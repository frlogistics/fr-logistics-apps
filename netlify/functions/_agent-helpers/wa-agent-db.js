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
// Normalizes phone (strip +, spaces, dashes) and matches against
// wa_clients.wa_number. Returns { client, language } or null.
// ─────────────────────────────────────────────────────────────────────

function normalizePhone(raw) {
  return String(raw || "").replace(/[^\d]/g, "");
}

export async function lookupExistingClient(waNumber) {
  const normalized = normalizePhone(waNumber);
  if (!normalized) return null;

  const { data, error } = await sb()
    .from("wa_clients")
    .select("id, name, company, wa_number, preferred_language, active")
    .eq("active", true);

  if (error) {
    console.error("[agent-db] lookupExistingClient error:", error.message);
    return null;
  }
  if (!data?.length) return null;

  // Match by normalized phone
  const match = data.find(
    (c) => normalizePhone(c.wa_number) === normalized
  );
  if (!match) return null;

  return {
    clientId: match.id,
    clientName: match.name || match.company || "Cliente",
    preferredLanguage: (match.preferred_language || "").toUpperCase() || null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// 2. CONVERSATION LIFECYCLE
// ─────────────────────────────────────────────────────────────────────

/**
 * Returns the active conversation for a WhatsApp number, or null.
 * "Active" means: not in 'lost' or 'completed' state, and updated <24h ago.
 */
export async function getActiveConversation(waNumber) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await sb()
    .from("wa_agent_conversations")
    .select("*")
    .eq("wa_number", waNumber)
    .not("state", "in", "(lost,completed)")
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
 * Creates a new conversation row. Returns the inserted row or null on error.
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

  const row = {
    wa_number: waNumber,
    wa_profile_name: waProfileName || null,
    first_message: firstMessage || null,
    state: initialState,
    language: langLower,
    language_source: languageSource || null,
    is_existing_client: !!isExistingClient,
    client_id: clientId || null,
    last_user_message_at: new Date().toISOString(),
    message_count: 1,
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
  // table builder, so we use rpc if available — fallback to manual fetch+set.
  // Simplest: fetch current, increment, write back. Race-safe enough at our scale.
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
