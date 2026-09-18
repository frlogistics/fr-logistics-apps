// netlify/functions/_agent-helpers/wa-agent-summary.js
//
// HANDOFF SUMMARY + LEAD SCORE (2026-09-18)
//
// When LIAM hands a conversation to a human (completeHandoff or
// escalateToHuman), this builds a 3-line internal summary and a
// hot / warm / cold score, and writes them to:
//   - wa_agent_conversations.handoff_summary / lead_score /
//     lead_score_reason / summary_at   (what the inbox panel reads)
//   - wa_leads.conversation_summary / next_action / next_action_date
//     (what the CRM views read)
// The router also passes the result into the handoff email.
//
// Output is ENGLISH on purpose: it is internal UI text (portal/email), and
// every FR-Logistics interface is in English. The conversation itself can
// be in Spanish; the model reads both.
//
// Best-effort and idempotent: never throws, returns null on any failure,
// and if a summary already exists for the conversation it is returned
// without a new LLM call (re-entries from the retry paths are cheap).
//
// Gated by the same kill switch / cost cap as the chat LLM (shouldRunLLM).
// Uses direct fetch to api.anthropic.com like wa-agent-llm.js.

import { createClient } from "@supabase/supabase-js";
import { shouldRunLLM } from "./wa-agent-llm.js";

const MODEL_ID = "claude-haiku-4-5-20251001";
const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const REQUEST_TIMEOUT_MS = 15000;
const MAX_TOKENS_OUT = 400;
const HISTORY_LIMIT = 16;

const PRICE_PER_M_INPUT = 1.00;
const PRICE_PER_M_OUTPUT = 5.00;

function sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
}

const SYSTEM_PROMPT = `You write internal handoff notes for the sales team of FR-Logistics, a 3PL warehouse in Miami (Amazon FBA prep, Shopify/DTC fulfillment, removal-order consolidation, casillero/dropshipments for LATAM e-commerce sellers).

You receive a WhatsApp/web-chat transcript between the assistant "Liam" and a prospect, plus any fields the bot captured. Produce a JSON object ONLY (no prose, no markdown fences) with exactly these keys:

{
  "summary": "3 short lines separated by \\n. Line 1: who they are (name, company, country if known). Line 2: what they want (service, product, volume, timing). Line 3: what is still missing or unclear.",
  "score": "hot" | "warm" | "cold",
  "reason": "one sentence, max 20 words, why that score",
  "next_action": "one concrete step for the human, max 12 words, e.g. 'Send FBA prep quote for 3 pallets' or 'Ask for SKU list and monthly volume'"
}

Scoring rules:
- hot: clear service fit + volume or timing stated + wants to move now (has product, asks for quote/pricing/next steps, or explicitly asked for a human).
- warm: real business but something important is missing (no volume, no timing, exploring options, first shipment months away).
- cold: out of scope for FR-Logistics (international shipping outside the US, wants to visit first, food/supplements without registration, uses FR address as business address, pure price shopping with no product), spam, vendor pitch, or no real intent.

Write in English. Never invent facts: if something was not said, say it is missing. Do not include phone numbers or emails in the summary (they are stored separately).`;

/**
 * Build (or fetch cached) summary for a conversation.
 * @param {object} conv - wa_agent_conversations row (needs id, wa_number/channel_user_id, captured_*)
 * @param {object} [opts]
 * @param {boolean} [opts.force] - ignore cached summary
 * @returns {Promise<null | {summary, score, reason, next_action, cached}>}
 */
export async function buildHandoffSummary(conv, opts = {}) {
  try {
    if (!conv?.id) return null;

    // 0) Cached?
    if (!opts.force && conv.handoff_summary && conv.lead_score) {
      return {
        summary: conv.handoff_summary,
        score: conv.lead_score,
        reason: conv.lead_score_reason || "",
        next_action: null,
        cached: true,
      };
    }

    // 1) Gate (same cap as the chat LLM)
    const gate = await shouldRunLLM();
    if (!gate.allowed) {
      console.log(`[summary] gated: ${gate.reason}`);
      return null;
    }
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { console.error("[summary] ANTHROPIC_API_KEY missing"); return null; }

    // 2) Transcript
    const address = conv.channel_user_id || conv.wa_number;
    const history = await loadTranscript(address, conv);
    const captured = pickCaptured(conv);

    const userContent =
      `CAPTURED FIELDS (from the bot, may be partial):\n${JSON.stringify(captured, null, 2)}\n\n` +
      `HANDOFF REASON: ${conv.handoff_reason || "unknown"}\n` +
      `LANGUAGE: ${conv.language || "unknown"}\n\n` +
      `TRANSCRIPT (oldest first):\n${history || "(no messages found)"}`;

    // 3) Call
    const start = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: MODEL_ID,
          max_tokens: MAX_TOKENS_OUT,
          temperature: 0,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userContent }],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
    const latencyMs = Date.now() - start;

    if (!response.ok) {
      const t = await response.text().catch(() => "");
      console.error(`[summary] API ${response.status}: ${t.slice(0, 300)}`);
      await logCall({ conv, latencyMs, success: false, error: `HTTP ${response.status}` });
      return null;
    }

    const data = await response.json();
    const text = (data?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    const inTok = data?.usage?.input_tokens || 0;
    const outTok = data?.usage?.output_tokens || 0;
    const costUsd = Number(((inTok / 1e6) * PRICE_PER_M_INPUT + (outTok / 1e6) * PRICE_PER_M_OUTPUT).toFixed(6));

    const parsed = parseModelJson(text);
    if (!parsed) {
      console.error("[summary] could not parse model JSON:", text.slice(0, 200));
      await logCall({ conv, latencyMs, success: false, error: "parse_failed", responseText: text, inTok, outTok, costUsd });
      return null;
    }

    const result = normalize(parsed);
    await recordSpend(costUsd);
    await logCall({ conv, latencyMs, success: true, responseText: text, inTok, outTok, costUsd });

    // 4) Persist
    await persist(conv, result);
    return { ...result, cached: false };
  } catch (e) {
    console.error("[summary] error:", e?.message || e);
    return null;
  }
}

// ───────────────────────────────── internals

function pickCaptured(conv) {
  const out = {};
  const keys = [
    "captured_name", "captured_service", "captured_volume", "captured_country",
    "captured_platforms", "captured_stage", "captured_product_type",
    "captured_integration", "captured_eco_focus", "first_message",
    "is_existing_client", "wa_profile_name", "channel",
  ];
  for (const k of keys) if (conv[k] !== undefined && conv[k] !== null && conv[k] !== "") out[k] = conv[k];
  return out;
}

async function loadTranscript(address, conv) {
  try {
    const num = String(address || "").replace(/^\+/, "");
    let q = sb()
      .from("wa_messages")
      .select("direction,body,timestamp,is_internal")
      .order("timestamp", { ascending: false })
      .limit(HISTORY_LIMIT);

    if (conv.channel && conv.channel !== "whatsapp") {
      q = q.eq("conversation_id", conv.id);
    } else {
      q = q.or(`from_number.eq.${num},to_number.eq.${num}`);
    }
    const { data, error } = await q;
    if (error) { console.error("[summary] transcript error:", error.message); return ""; }
    const rows = (data || []).filter((r) => !r.is_internal).reverse();
    return rows
      .map((r) => `${r.direction === "inbound" ? "PROSPECT" : "LIAM"}: ${String(r.body || "").replace(/\s+/g, " ").slice(0, 400)}`)
      .join("\n");
  } catch (e) {
    console.error("[summary] transcript exception:", e?.message || e);
    return "";
  }
}

function parseModelJson(text) {
  if (!text) return null;
  const clean = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); } catch { /* fallthrough */ }
  const m = clean.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { return null; } }
  return null;
}

function normalize(p) {
  const score = ["hot", "warm", "cold"].includes(String(p.score || "").toLowerCase())
    ? String(p.score).toLowerCase()
    : "warm";
  return {
    summary: String(p.summary || "").trim().slice(0, 900),
    score,
    reason: String(p.reason || "").trim().slice(0, 240),
    next_action: String(p.next_action || "").trim().slice(0, 160) || null,
  };
}

async function persist(conv, r) {
  const now = new Date().toISOString();
  try {
    await sb()
      .from("wa_agent_conversations")
      .update({
        handoff_summary: r.summary,
        lead_score: r.score,
        lead_score_reason: r.reason,
        summary_at: now,
      })
      .eq("id", conv.id);
  } catch (e) {
    console.error("[summary] conv persist error:", e?.message || e);
  }

  if (conv.lead_id) {
    try {
      const patch = { conversation_summary: r.summary };
      // CRM hygiene: classify the lead if nobody has yet. hot/warm → real;
      // an existing client is never a lead; cold stays unclassified for a
      // human to decide (out-of-scope businesses are not "noise").
      try {
        const { data: cur } = await sb().from("wa_leads").select("dq_flag").eq("id", conv.lead_id).single();
        if (cur && !cur.dq_flag) {
          if (conv.is_existing_client) { patch.dq_flag = "existing_client"; patch.dq_note = "auto: conversation matched fr_clients"; }
          else if (r.score === "hot" || r.score === "warm") { patch.dq_flag = "real"; patch.dq_note = `auto: LIAM scored ${r.score} at handoff`; }
        }
      } catch (e) { console.error("[summary] dq_flag check:", e?.message || e); }
      if (r.next_action) {
        patch.next_action = r.next_action;
        // Hot → today, warm → tomorrow, cold → no date (parked).
        if (r.score === "hot") patch.next_action_date = now.slice(0, 10);
        else if (r.score === "warm") patch.next_action_date = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      }
      await sb().from("wa_leads").update(patch).eq("id", conv.lead_id);
    } catch (e) {
      console.error("[summary] lead persist error:", e?.message || e);
    }
  }
}

// Same monthly cap as the chat LLM (auto-disables when the cap is reached).
async function recordSpend(costUsd) {
  if (!costUsd || costUsd <= 0) return;
  try {
    const { error } = await sb().rpc("fn_record_llm_spend", { p_cost: costUsd });
    if (error) console.error("[summary] record_spend failed:", error.message);
  } catch (e) {
    console.error("[summary] record_spend exception:", e?.message || e);
  }
}

async function logCall({ conv, latencyMs, success, error = null, responseText = null, inTok = 0, outTok = 0, costUsd = 0 }) {
  try {
    await sb().from("wa_agent_llm_logs").insert({
      conversation_id: conv.id || null,
      wa_number: conv.wa_number || conv.channel_user_id || null,
      model: MODEL_ID,
      system_prompt_tokens: inTok,
      user_message_tokens: 0,
      context_tokens: 0,
      response_tokens: outTok,
      cost_usd: costUsd,
      response_text: responseText ? `[handoff-summary] ${responseText.slice(0, 3900)}` : "[handoff-summary]",
      response_time_ms: latencyMs || null,
      success: success === true,
      error_message: error,
    });
  } catch (e) {
    console.error("[summary] log insert failed:", e?.message || e);
  }
}
