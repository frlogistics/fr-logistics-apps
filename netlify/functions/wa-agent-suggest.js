// netlify/functions/wa-agent-suggest.js
//
// SUGGEST MODE (2026-09-18).
//
// When a human holds a conversation (LIAM paused), the inbox can ask LIAM
// for a draft. The human edits and sends. Every pair (what LIAM proposed,
// what was actually sent) is stored in wa_agent_suggestions — that is the
// training signal for the prompt.
//
// POST /wa-agent-suggest { action:"suggest", phone }
//   → { ok, suggestion_id, text, language }
// POST /wa-agent-suggest { action:"feedback", suggestion_id, sent_text }
//   → { ok }          (called by the inbox right after a send)
// POST /wa-agent-suggest { action:"discard", suggestion_id }
//   → { ok }
//
// Reuses the production LLM stack: askLLM() applies the same system prompt,
// HARD_RULES (no individual names, no visits), kill switch and cost cap as
// live replies, so a suggestion can never say something LIAM would not.

import { askLLM } from "./_agent-helpers/wa-agent-llm.js";
import { topNFAQs } from "./_agent-helpers/wa-agent-faq-match.js";
import { parseAddress } from "./_agent-helpers/wa-agent-db.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const HISTORY_N = 10;

async function sb(path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  if (init.headers?.Prefer === "return=minimal") return null;
  return r.json();
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: HEADERS });

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: HEADERS });
  if (!SUPABASE_URL || !SUPABASE_KEY) return json({ error: "Supabase env missing" }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  try {
    if (body.action === "feedback") {
      if (!body.suggestion_id) return json({ error: "suggestion_id required" }, 400);
      const rows = await sb(`wa_agent_suggestions?select=suggestion&id=eq.${body.suggestion_id}`);
      const original = rows?.[0]?.suggestion || "";
      const sent = String(body.sent_text || "");
      await sb(`wa_agent_suggestions?id=eq.${body.suggestion_id}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ sent_text: sent.slice(0, 4000), sent_at: new Date().toISOString(), edited: norm(sent) !== norm(original) }),
      });
      return json({ ok: true });
    }

    if (body.action === "discard") {
      if (!body.suggestion_id) return json({ error: "suggestion_id required" }, 400);
      await sb(`wa_agent_suggestions?id=eq.${body.suggestion_id}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ discarded: true }),
      });
      return json({ ok: true });
    }

    if (body.action === "suggest") {
      const addr = parseAddress(String(body.phone || ""));
      const key = addr.channel === "whatsapp" ? addr.waNumber : addr.address;
      if (!key) return json({ error: "phone required" }, 400);

      // Conversation context
      const convFilter = addr.channel === "whatsapp" ? `wa_number=eq.${key}` : `channel_user_id=eq.${encodeURIComponent(addr.id)}`;
      const convs = await sb(`wa_agent_conversations?select=id,language,captured_name,captured_email,captured_service,captured_volume,captured_country,captured_product_type,captured_stage,handoff_summary,lead_score,is_existing_client&${convFilter}&order=updated_at.desc&limit=1`);
      const conv = convs?.[0] || null;

      // History (both directions), oldest first
      const msgFilter = addr.channel === "whatsapp" ? `or=(from_number.eq.${key},to_number.eq.${key})` : `conversation_id=eq.${conv?.id || "00000000-0000-0000-0000-000000000000"}`;
      const msgs = await sb(`wa_messages?select=direction,body,timestamp,is_internal&${msgFilter}&order=timestamp.desc&limit=${HISTORY_N * 2}`);
      const history = (msgs || []).filter((m) => !m.is_internal && m.body).reverse()
        .map((m) => ({ role: m.direction === "inbound" ? "user" : "assistant", text: String(m.body).slice(0, 800) }))
        .slice(-HISTORY_N);
      const lastInbound = [...history].reverse().find((m) => m.role === "user")?.text || "";
      if (!lastInbound) return json({ error: "Nothing to reply to — the contact has not written yet." }, 409);

      const language = (conv?.language || detectLang(lastInbound)).toLowerCase() === "es" ? "es" : "en";
      const faqContext = await topNFAQs(lastInbound, language, 3).catch(() => []);
      const leadData = conv ? {
        name: conv.captured_name, email: conv.captured_email, service: conv.captured_service,
        volume: conv.captured_volume, country: conv.captured_country, product: conv.captured_product_type,
        stage: conv.captured_stage, summary: conv.handoff_summary, score: conv.lead_score,
        existing_client: conv.is_existing_client,
      } : {};

      // The human is replying, so the draft speaks as "our team", never as
      // a bot introducing itself; and it answers the LAST message, not the
      // whole thread. This instruction rides on top of the production prompt.
      const userMessage =
        `${lastInbound}\n\n` +
        `[Instruction for this draft only: a human from our team will send this. Write ONE reply to the message above, ` +
        `in ${language === "es" ? "Spanish" : "English"}, max 90 words, no greeting like "Soy Liam", no menu, no numbered options. ` +
        `Be specific to what they asked. If something is missing to quote, ask for exactly that. Sign off as "our team"/"nuestro equipo" only if natural.]`;

      const t0 = Date.now();
      const res = await askLLM({ userMessage, language, history: history.slice(0, -1), faqContext, leadData, conversationId: conv?.id || null, waNumber: key });
      if (!res.allowed || !res.text) return json({ error: res.reason === "ok" ? "Empty draft" : `LIAM is not available right now (${res.reason})` }, 503);

      const text = cleanDraft(res.text);
      const ins = await sb(`wa_agent_suggestions?select=id`, {
        method: "POST", headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          conversation_id: conv?.id || null, wa_number: key, language, last_inbound: lastInbound.slice(0, 1000),
          suggestion: text, model: "claude-haiku-4-5-20251001", cost_usd: res.cost || null, latency_ms: res.latencyMs || (Date.now() - t0),
        }),
      });
      return json({ ok: true, suggestion_id: ins?.[0]?.id || null, text, language });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error("[wa-agent-suggest] error:", e.message);
    return json({ error: e.message }, 500);
  }
}

function norm(s) { return String(s || "").replace(/\s+/g, " ").trim().toLowerCase(); }
function detectLang(t) { return /[áéíóúñ¿¡]|\b(hola|gracias|quiero|necesito|buenas|cotiz)/i.test(t) ? "es" : "en"; }
// Strip a trailing menu or a bot self-intro if the model slips one in.
function cleanDraft(t) {
  let s = String(t || "").trim();
  s = s.replace(/^(¡?hola!?\s*👋?\s*)?(soy|i am|i'm)\s+liam[^\n]*\n?/i, "").trim();
  s = s.replace(/\n+\s*(1️⃣|1\.|1\))[\s\S]*$/m, "").trim();
  return s;
}
