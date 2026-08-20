// netlify/functions-helpers/wa-agent-db.js
//
// Supabase helpers for the WhatsApp Agent (Liam).
// All DB access from agent code goes through here so we have one place
// to enforce conventions, handle errors, and audit queries.
//
// Used by: wa-agent-router.js, wa-agent-greet.js, future state handlers.
// Imports: only @supabase/supabase-js (already in package.json).

import { createClient } from "@supabase/supabase-js";

// ─────────────────────────────────────────────────────────────────────
// CLIENT FACTORY — lazy singleton
// ─────────────────────────────────────────────────────────────────────

let _client = null;

function sb() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error("[agent-db] SUPABASE_URL / SUPABASE_SERVICE_KEY missing");
  }
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

// ─────────────────────────────────────────────────────────────────────
// 1. EXISTING CLIENT LOOKUP
// Normalizes phone and matches against fr_clients.wa_number.
// Returns { clientId, clientName, preferredLanguage } or null.
// ─────────────────────────────────────────────────────────────────────

function normalizePhone(raw) {
  return String(raw || "").replace(/[^\d]/g, "");
}

export async function lookupExistingClient(waNumber) {
  const normalized = normalizePhone(waNumber);
  if (!normalized) return null;

  // fr_clients es la fuente canonica de clientes de todo el ecosistema.
  // wa_clients quedo obsoleta (duplicados) y ademas no tiene preferred_language,
  // lo que hacia fallar la consulta entera y devolver null siempre.
  const { data, error } = await sb()
    .from("fr_clients")
    .select("id, company, wa_number, lang, active")
    .eq("active", true);

  if (error) {
    console.error("[agent-db] lookupExistingClient error:", error.message);
    return null;
  }
  if (!data?.length) return null;

  // fr_clients tiene duplicados historicos (mismo wa_number en dos filas).
  // Recolectamos TODOS los matches y, si hay mas de uno, preferimos el que
  // trae mas datos (company + lang), en vez del .find() que devolvia el
  // primero del arreglo a ciegas.
  const matches = data.filter(
    (c) => c.wa_number && normalizePhone(c.wa_number) === normalized
  );
  if (!matches.length) return null;

  const match =
    matches.length === 1
      ? matches[0]
      : matches
          .slice()
          .sort(
            (a, b) =>
              (b.company ? 1 : 0) + (b.lang ? 1 : 0) -
              ((a.company ? 1 : 0) + (a.lang ? 1 : 0))
          )[0];

  if (matches.length > 1) {
    console.warn(
      `[agent-db] lookupExistingClient: ${matches.length} fr_clients rows share wa_number ${normalized}; picked id=${match.id}`
    );
  }

  return {
    clientId: match.id,
    clientName: match.company || "Cliente",
    preferredLanguage: (match.lang || "").toUpperCase() || null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// 2. CONVERSATION LIFECYCLE
// ─────────────────────────────────────────────────────────────────────

/**
 * Returns the active conversation for a WhatsApp number, or null.
 * "Active" means: not in 'lost'/'completed'/'paused' state, updated <24h ago.
 * Paused conversations are excluded so a human-owned thread is never
 * reopened by the agent; the router checks paused_by_human separately.
 */
export async function getActiveConversation(waNumber) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await sb()
    .from("wa_agent_conversations")
    .select("*")
    .eq("wa_number", waNumber)
    .not("state", "in", "(lost,completed,paused)")
    .gte("updated_at", cutoff)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("[agent-db] getActiveConversation error:", error.message);
    return null;
  }
  return data?.[0] || null;
}

/**
 * Returns the most recent conversation for a number REGARDLESS of state or
 * age (paused, completed, old — all count). Used to inherit already-captured
 * contact data into a fresh conversation so we never re-ask a lead for a
 * name/email they already gave in a previous session.
 * Returns the row or null.
 */
export async function getLastConversationAny(waNumber) {
  const { data, error } = await sb()
    .from("wa_agent_conversations")
    .select("id, captured_name, captured_email, captured_service, lead_id, is_existing_client, client_id, language")
    .eq("wa_number", waNumber)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("[agent-db] getLastConversationAny error:", error.message);
    return null;
  }
  return data?.[0] || null;
}

/**
 * Creates a new conversation row. Returns the inserted row or null on error.
 *
 * Inherits captured contact data (name, email, service, lead_id) from the
 * number's most recent prior conversation when the caller doesn't override
 * it. This is the fix for a lead being asked for their name/email again on
 * every new 24h session — the data lived on the previous (now completed or
 * paused) row and was lost.
 */
export async function createConversation({
  waNumber,
  waProfileName,
  firstMessage,
  language,           // 'ES' | 'EN' | null
  languageSource,     // 'text_detect' | 'phone_prefix' | 'client_preference' | null
  isExistingClient,
  clientId,
}) {
  // Map UPPERCASE to lowercase for the enum
  const langLower = language ? language.toLowerCase() : null;

  const initialState = language
    ? "greeted"               // We can greet directly
    : "pending_language";     // Need bilingual prompt first

  // Pull forward anything we already know about this number.
  const prior = await getLastConversationAny(waNumber);

  const row = {
    wa_number: waNumber,
    wa_profile_name: waProfileName || null,
    first_message: firstMessage || null,
    state: initialState,
    language: langLower,
    language_source: languageSource || null,
    is_existing_client: !!isExistingClient || !!prior?.is_existing_client,
    client_id: clientId || prior?.client_id || null,
    last_user_message_at: new Date().toISOString(),
    message_count: 1,
    // Inherited contact data — only carried over, never invented.
    captured_name: prior?.captured_name || null,
    captured_email: prior?.captured_email || null,
    captured_service: prior?.captured_service || null,
    lead_id: prior?.lead_id || null,
  };

  const { data, error } = await sb()
    .from("wa_agent_conversations")
    .insert(row)
    .select("*")
    .single();

  if (error) {
    console.error("[agent-db] createConversation error:", error.message);
    return null;
  }

  if (prior && (prior.captured_name || prior.captured_email)) {
    console.log(
      `[agent-db] new conv for ${waNumber} inherited contact data from prior conv ${prior.id}`
    );
  }
  return data;
}

/**
 * Updates conversation fields. Always bumps message_count by 1 and
 * sets last_user_message_at to now.
 */
export async function updateConversationOnUserMessage(conversationId, patch = {}) {
  const updates = {
    ...patch,
    last_user_message_at: new Date().toISOString(),
  };

  // We can't do "message_count = message_count + 1" via the supabase-js
  // table builder, so we fetch current, increment, write back.
  const { data: current } = await sb()
    .from("wa_agent_conversations")
    .select("message_count")
    .eq("id", conversationId)
    .single();

  updates.message_count = (current?.message_count || 0) + 1;

  const { data, error } = await sb()
    .from("wa_agent_conversations")
    .update(updates)
    .eq("id", conversationId)
    .select("*")
    .single();

  if (error) {
    console.error("[agent-db] updateConversationOnUserMessage error:", error.message);
    return null;
  }
  return data;
}

/**
 * Records that the agent just sent a message back.
 */
export async function recordAgentMessage(conversationId, newState = null) {
  const updates = {
    last_agent_message_at: new Date().toISOString(),
  };
  if (newState) updates.state = newState;

  const { error } = await sb()
    .from("wa_agent_conversations")
    .update(updates)
    .eq("id", conversationId);

  if (error) {
    console.error("[agent-db] recordAgentMessage error:", error.message);
  }
}

// ─────────────────────────────────────────────────────────────────────
// NAME VALIDATION — reject junk before it becomes a chat title
//
// captured_name has repeatedly stored whole paragraphs (a lead pasting
// "My name is X and my email is Y and I'd prefer to..." lands verbatim in
// captured_name, and the inbox then titles the chat with that paragraph).
// A real name is short: a few words, no @, no line breaks, no question
// marks, no long sentences. When the reply isn't a plausible name we store
// NOTHING rather than garbage — the router can re-ask or fall back to the
// WhatsApp profile name.
// ─────────────────────────────────────────────────────────────────────

export function looksLikeValidName(raw) {
  const s = String(raw || "").trim();
  if (!s) return false;
  if (s.length > 40) return false;              // real names are short
  if (/[\n\r]/.test(s)) return false;           // multi-line = pasted blob
  if (/[@?]/.test(s)) return false;             // email / a question, not a name
  if (/\d{3,}/.test(s)) return false;           // phone numbers etc.
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length > 4) return false;           // "my name is Juan Viton" style blobs
  return true;
}

/**
 * Cleans a raw reply into a storable name, or returns null if it doesn't
 * look like a name. Strips a leading "mi nombre es " / "my name is " /
 * "soy " / "me llamo " so those common lead-ins don't blow the word count.
 */
export function extractName(raw) {
  let s = String(raw || "").trim();
  s = s.replace(
    /^(mi nombre es|me llamo|soy|my name is|i am|i'm|this is)\s+/i,
    ""
  ).trim();
  // Drop a trailing email if they wrote "Juan juan@x.com" on one line.
  s = s.replace(/\s*\S+@\S+.*$/, "").trim();
  return looksLikeValidName(s) ? s : null;
}

/**
 * Sets captured_name ONLY if the value looks like a real name.
 * Returns the stored name, or null if it was rejected (caller can re-ask).
 */
export async function setCapturedName(conversationId, rawName) {
  const clean = extractName(rawName);
  if (!clean) {
    console.log(`[agent-db] setCapturedName rejected junk for conv ${conversationId}`);
    return null;
  }
  const { error } = await sb()
    .from("wa_agent_conversations")
    .update({ captured_name: clean })
    .eq("id", conversationId);
  if (error) {
    console.error("[agent-db] setCapturedName error:", error.message);
    return null;
  }
  return clean;
}

/**
 * Marks a conversation as paused (human took over).
 */
export async function pauseConversation(conversationId, pausedBy = "jose") {
  const { error } = await sb()
    .from("wa_agent_conversations")
    .update({
      paused_by_human: true,
      paused_at: new Date().toISOString(),
      paused_by: pausedBy,
      state: "paused",
    })
    .eq("id", conversationId);
  if (error) console.error("[agent-db] pauseConversation error:", error.message);
}

/**
 * Marks a conversation as needing handoff.
 */
export async function markHandoff(conversationId, reason, newState = "handoff_jose") {
  const { error } = await sb()
    .from("wa_agent_conversations")
    .update({
      handoff_required: true,
      handoff_reason: reason,
      handoff_at: new Date().toISOString(),
      state: newState,
    })
    .eq("id", conversationId);
  if (error) console.error("[agent-db] markHandoff error:", error.message);
}

// ─────────────────────────────────────────────────────────────────────
// 3. KILL SWITCH
// ─────────────────────────────────────────────────────────────────────

/**
 * Returns true if the agent is currently disabled (cap reached or manual).
 */
export async function isAgentDisabled() {
  const { data, error } = await sb()
    .from("wa_agent_kill_switch")
    .select("is_disabled, current_month_spend_usd, monthly_cap_usd")
    .eq("id", 1)
    .single();

  if (error) {
    console.error("[agent-db] isAgentDisabled error:", error.message);
    // Fail OPEN — if we can't read kill switch, let the agent run.
    // Safer than blocking real leads due to a DB blip.
    return false;
  }
  return !!data?.is_disabled;
}

// ─────────────────────────────────────────────────────────────────────
// 4. LEAD CREATION (link to existing wa_leads table)
// ─────────────────────────────────────────────────────────────────────

/**
 * Creates a wa_leads row from a new conversation. Returns lead_id or null.
 */
export async function createLeadFromConversation({
  waNumber,
  waProfileName,
  language,
  firstMessage,
}) {
  const row = {
    name: waProfileName || "WhatsApp Lead",
    email: `pending+${normalizePhone(waNumber)}@fr-logistics.net`,  // placeholder, captured later
    phone: waNumber.startsWith("+") ? waNumber : `+${waNumber}`,
    language: (language || "en").toLowerCase(),
    service: "other",
    service_detail: firstMessage?.slice(0, 500) || null,
    status: "new",
    source: "whatsapp_agent",
    captured_by: "Liam (agent)",
  };

  const { data, error } = await sb()
    .from("wa_leads")
    .insert(row)
    .select("id")
    .single();

  if (error) {
    console.error("[agent-db] createLeadFromConversation error:", error.message);
    return null;
  }
  return data?.id || null;
}

/**
 * Links a conversation to its lead row.
 */
export async function linkConversationToLead(conversationId, leadId) {
  const { error } = await sb()
    .from("wa_agent_conversations")
    .update({ lead_id: leadId })
    .eq("id", conversationId);
  if (error) console.error("[agent-db] linkConversationToLead error:", error.message);
}
