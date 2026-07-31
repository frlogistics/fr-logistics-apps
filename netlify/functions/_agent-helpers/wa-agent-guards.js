// netlify/functions-helpers/wa-agent-guards.js
//
// SAFETY GUARDS for the WhatsApp agent.
//
// Added 2026-07-31 after an incident where Liam replied
// "No reconozco eso como un email válido" TEN times in a row to an
// existing client (Shop World) who had simply asked an operational
// question and sent a photo.
//
// Root causes this file addresses:
//   1. Re-ask loops with no retry cap  → maxedOut() + bumpRetry()
//   2. No repeat suppression           → sendOnce()
//   3. Router is blind to media        → isMediaPlaceholder()
//   4. "Gracias" / "Ok" restarts flows → isClosing()
//   5. Menu appended to every reply    → shouldSendFullMenu()
//
// Every function here is BEST-EFFORT and must never throw. On any
// failure they fall back to the permissive answer so the agent keeps
// working exactly as before.

import { sendAndRecord } from "./wa-agent-send.js";

function sb() {
  // Lazy import matches the existing inline pattern in wa-agent-router.js
  return import("@supabase/supabase-js").then(({ createClient }) =>
    createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
    })
  );
}

// ─────────────────────────────────────────────────────────────────────
// 1. MEDIA DETECTION
// ─────────────────────────────────────────────────────────────────────
// The webhook persists non-text messages as a literal placeholder string
// in `body` ("[image]", "[audio]", ...). Without this check the router
// feeds that string into the capture/qualify logic and tries to parse
// "[image]" as an email address — which is exactly what happened.

const MEDIA_PLACEHOLDERS = [
  "[image]", "[audio]", "[video]", "[document]",
  "[sticker]", "[reaction]", "[location]", "[contacts]",
];

export function isMediaPlaceholder(text) {
  if (!text) return false;
  return MEDIA_PLACEHOLDERS.includes(String(text).trim().toLowerCase());
}

export function mediaKind(text) {
  if (!isMediaPlaceholder(text)) return null;
  return String(text).trim().toLowerCase().replace(/[\[\]]/g, "");
}

// ─────────────────────────────────────────────────────────────────────
// 2. CLOSING DETECTION
// ─────────────────────────────────────────────────────────────────────
// "Gracias" / "Ok" / "Listo" are conversation enders, not answers to
// whatever slot we happen to be waiting on. Treat them as a soft close.

const CLOSING_PATTERNS = [
  /^(muchas\s+)?gracias[\s!.]*$/i,
  /^(ok|oki|okay|okey|vale|dale|listo|perfecto|excelente|genial|buenísimo)[\s!.]*$/i,
  /^(thanks|thank\s+you|thx|ty|got\s+it|great|perfect|awesome)[\s!.]*$/i,
  /^(me\s+qued[oó]\s+claro|entendido|comprendido|clarísimo|todo\s+claro)[\s!.]*$/i,
  /^(understood|clear|makes\s+sense|all\s+good)[\s!.]*$/i,
  /^👍+$|^🙏+$|^👌+$|^✅+$/,
];

export function isClosing(text) {
  if (!text) return false;
  const t = String(text).trim();
  if (t.length > 40) return false; // a long message is never just a thank-you
  return CLOSING_PATTERNS.some((re) => re.test(t));
}

// ─────────────────────────────────────────────────────────────────────
// 3. REPEAT SUPPRESSION  ← the universal net
// ─────────────────────────────────────────────────────────────────────
// Drop-in replacement for sendAndRecord(). Refuses to send a message
// whose body is identical to the last thing we already sent to that
// number. Catches ANY future loop, whatever its cause.
//
// Returns { ok, suppressed }.

export async function sendOnce({ to, text, clientName = "Liam" }) {
  try {
    const db = await sb();
    const { data } = await db
      .from("wa_messages")
      .select("body")
      .eq("direction", "outbound")
      .eq("to_number", to)
      .order("timestamp", { ascending: false })
      .limit(1);

    const last = data?.[0]?.body;
    if (last && last.trim() === String(text).trim()) {
      console.warn(`[guards] SUPPRESSED duplicate message to ${to}: "${String(text).slice(0, 60)}"`);
      return { ok: true, suppressed: true };
    }
  } catch (e) {
    // If the lookup fails we prefer sending over staying silent.
    console.log(`[guards] repeat check failed, sending anyway: ${e.message}`);
  }

  const res = await sendAndRecord({ to, text, clientName });
  return { ...res, suppressed: false };
}

// ─────────────────────────────────────────────────────────────────────
// 4. RETRY CAP
// ─────────────────────────────────────────────────────────────────────
// Requires: alter table wa_agent_conversations
//             add column retry_count integer not null default 0;

export const MAX_RETRIES = 2;

export async function bumpRetry(conversationId) {
  try {
    const db = await sb();
    const { data } = await db
      .from("wa_agent_conversations")
      .select("retry_count")
      .eq("id", conversationId)
      .single();

    const next = (data?.retry_count || 0) + 1;
    await db
      .from("wa_agent_conversations")
      .update({ retry_count: next })
      .eq("id", conversationId);
    return next;
  } catch (e) {
    console.log(`[guards] bumpRetry failed: ${e.message}`);
    return 0; // fail-open: never block the flow because a counter broke
  }
}

export async function resetRetry(conversationId) {
  try {
    const db = await sb();
    await db
      .from("wa_agent_conversations")
      .update({ retry_count: 0 })
      .eq("id", conversationId);
  } catch (e) {
    console.log(`[guards] resetRetry failed: ${e.message}`);
  }
}

export function maxedOut(count) {
  return count >= MAX_RETRIES;
}

// ─────────────────────────────────────────────────────────────────────
// 5. MENU DECAY
// ─────────────────────────────────────────────────────────────────────
// Requires: alter table wa_agent_conversations
//             add column menu_sent_count integer not null default 0;
//
// Full menu once. Then a one-line nudge. Then nothing at all — the lead
// already knows what we offer; repeating it is what reads as spam.

export const MENU_FULL = "full";
export const MENU_SHORT = "short";
export const MENU_NONE = "none";

export async function nextMenuMode(conversationId) {
  try {
    const db = await sb();
    const { data } = await db
      .from("wa_agent_conversations")
      .select("menu_sent_count")
      .eq("id", conversationId)
      .single();

    const sent = data?.menu_sent_count || 0;
    await db
      .from("wa_agent_conversations")
      .update({ menu_sent_count: sent + 1 })
      .eq("id", conversationId);

    if (sent === 0) return MENU_FULL;
    if (sent === 1) return MENU_SHORT;
    return MENU_NONE;
  } catch (e) {
    console.log(`[guards] nextMenuMode failed: ${e.message}`);
    return MENU_SHORT; // safest middle ground
  }
}
