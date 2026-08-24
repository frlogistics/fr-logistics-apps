// netlify/functions-helpers/wa-agent-db.js
//
// Supabase helpers for the WhatsApp Agent (Liam).
// All DB access from agent code goes through here so we have one place
// to enforce conventions, handle errors, and audit queries.
//
// Used by: wa-agent-router.js, wa-agent-greet.js, web-chat.js.
// Imports: only @supabase/supabase-js (already in package.json).
//
// MULTICANAL (2026-08-22). La identidad ya no es el telefono: es el par
// (channel, channel_user_id). Las funciones que antes recibian `waNumber`
// ahora reciben una DIRECCION, que puede ser:
//    "13055551234"          -> WhatsApp (retrocompatible, sin prefijo)
//    "web:<uuid-sesion>"    -> chat del sitio
//    "ig:<IGSID>"           -> Instagram Direct (fase 3)
// parseAddress() es el unico lugar que interpreta ese formato.

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

// ─────────────────────────────────────────────────────────────────────
// ADDRESSING — el unico interprete del formato de direccion
// ─────────────────────────────────────────────────────────────────────

const CHANNEL_PREFIX = { "web:": "web", "ig:": "instagram" };

/**
 * Convierte una direccion en { channel, id, waNumber }.
 * Sin prefijo conocido = WhatsApp, para que todo el codigo desplegado
 * (whatsapp-webhook.js pasa digitos pelados) siga funcionando igual.
 * waNumber sale null en los canales que no son telefonicos: es lo que
 * impide que un uuid de sesion termine guardado como si fuera un numero.
 */
export function parseAddress(addr) {
  const raw = String(addr || "").trim();
  for (const [prefix, channel] of Object.entries(CHANNEL_PREFIX)) {
    if (raw.toLowerCase().startsWith(prefix)) {
      return { channel, id: raw.slice(prefix.length), waNumber: null, address: raw };
    }
  }
  const digits = normalizePhone(raw);
  return { channel: "whatsapp", id: digits, waNumber: digits || null, address: digits };
}

/** Inverso de parseAddress: arma la direccion a partir del par. */
export function formatAddress(channel, id) {
  if (channel === "web") return `web:${id}`;
  if (channel === "instagram") return `ig:${id}`;
  return normalizePhone(id);
}

export async function lookupExistingClient(address) {
  const addr = parseAddress(address);
  // fr_clients solo tiene wa_number. Un visitante web o un IGSID no se
  // pueden cruzar contra esa columna, y hacerlo con los digitos sueltos
  // de un uuid daria falsos positivos. Se resuelve en el canal, no aqui.
  if (addr.channel !== "whatsapp") return null;
  const normalized = addr.id;
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
export async function getActiveConversation(address) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const addr = parseAddress(address);

  const { data, error } = await sb()
    .from("wa_agent_conversations")
    .select("*")
    .eq("channel", addr.channel)
    .eq("channel_user_id", addr.id)
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
export async function getLastConversationAny(address) {
  const addr = parseAddress(address);

  const { data, error } = await sb()
    .from("wa_agent_conversations")
    .select("id, captured_name, captured_email, captured_service, lead_id, is_existing_client, client_id, language, channel, channel_user_id")
    .eq("channel", addr.channel)
    .eq("channel_user_id", addr.id)
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
  waNumber,          // direccion: digitos (WhatsApp), "web:…" o "ig:…"
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
  const addr = parseAddress(waNumber);

  const row = {
    channel: addr.channel,
    channel_user_id: addr.id,
    channel_display: waProfileName || null,
    // Solo WhatsApp escribe wa_number. El CHECK de la base exige que este
    // presente cuando channel='whatsapp' y lo deja nulo en los demas.
    wa_number: addr.waNumber,
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
      `[agent-db] new ${addr.channel} conv for ${addr.id} inherited contact data from prior conv ${prior.id}`
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
  const addr = parseAddress(waNumber);

  const SOURCE_BY_CHANNEL = {
    whatsapp: "whatsapp_agent",
    web: "web_chat_agent",
    instagram: "instagram_agent",
  };
  const FALLBACK_NAME = {
    whatsapp: "WhatsApp Lead",
    web: "Web Chat Lead",
    instagram: "Instagram Lead",
  };

  const row = {
    name: waProfileName || FALLBACK_NAME[addr.channel] || "Lead",
    // Placeholder unico por canal — se reemplaza cuando el lead da el suyo.
    email: `pending+${addr.channel}-${addr.id}@fr-logistics.net`.slice(0, 250),
    // phone quedo nullable en la migracion multicanal: un visitante web no
    // tiene telefono y guardar uno falso envenena el matcher de clientes.
    phone: addr.waNumber ? `+${addr.waNumber}` : null,
    language: (language || "en").toLowerCase(),
    service: "other",
    service_detail: firstMessage?.slice(0, 500) || null,
    status: "new",
    source: SOURCE_BY_CHANNEL[addr.channel] || "whatsapp_agent",
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

// ─────────────────────────────────────────────────────────────────────
// 5. MENSAJERIA DE CANALES NO-META (chat web)
//
// WhatsApp sale por wa-agent-send.js (Cloud API). El chat web no tiene
// API externa: "enviar" es escribir la fila en wa_messages y que el widget
// la recoja en su siguiente sondeo. Estas funciones son ese transporte.
//
// Convencion de direcciones en wa_messages para el canal web:
//   entrante:  from_number = "web:<sesion>"   to_number = FR_NODE
//   saliente:  from_number = FR_NODE          to_number = "web:<sesion>"
// Asi el `.or(from_number.eq.X,to_number.eq.X)` que ya usa el router para
// cargar historial sigue funcionando sin cambios.
// ─────────────────────────────────────────────────────────────────────

const FR_NODE = "fr-logistics";
const WEB_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

function newMsgId(prefix) {
  const rand =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}:${rand}`;
}

/**
 * Persiste un mensaje ENTRANTE de un canal no-Meta.
 * Devuelve la fila insertada o null.
 */
export async function recordInboundMessage({
  address,
  text,
  clientName,
  conversationId = null,
}) {
  const addr = parseAddress(address);
  const row = {
    wa_msg_id: newMsgId(`${addr.channel}-in`),
    direction: "inbound",
    from_number: addr.address,
    to_number: FR_NODE,
    client_name: clientName || "",
    body: text || "",
    msg_type: "text",
    channel: addr.channel,
    conversation_id: conversationId,
    timestamp: new Date().toISOString(),
    read: false,
  };

  const { data, error } = await sb()
    .from("wa_messages")
    .insert(row)
    .select("*")
    .single();

  if (error) {
    console.error("[agent-db] recordInboundMessage error:", error.message);
    return null;
  }
  return data;
}

/**
 * "Envia" un mensaje al chat web escribiendolo en wa_messages.
 * Devuelve { ok, suppressed, id } — misma forma que sendAndRecord/sendOnce
 * de WhatsApp, para que el router no tenga que distinguir.
 *
 * Con once=true replica la semantica de sendOnce: si el mismo texto ya se
 * mando a esta sesion en los ultimos 10 minutos, no se repite. Ese guard
 * es el que evita que el menu se reenvie una y otra vez.
 */
export async function sendWebOutbound({ to, text, clientName, once = false }) {
  const addr = parseAddress(to);
  const body = String(text || "");
  if (!body) return { ok: false, suppressed: false, error: "empty body" };

  if (once) {
    const since = new Date(Date.now() - WEB_DEDUPE_WINDOW_MS).toISOString();
    const { data: dupes } = await sb()
      .from("wa_messages")
      .select("id")
      .eq("to_number", addr.address)
      .eq("direction", "outbound")
      .eq("body", body)
      .gte("timestamp", since)
      .limit(1);
    if (dupes?.length) {
      console.log(`[agent-db] sendWebOutbound suppressed duplicate for ${addr.address}`);
      return { ok: true, suppressed: true };
    }
  }

  // Cuelga el mensaje de la conversacion vigente si ya existe.
  const conv = await getLastConversationAny(addr.address);

  const row = {
    wa_msg_id: newMsgId(`${addr.channel}-out`),
    direction: "outbound",
    from_number: FR_NODE,
    to_number: addr.address,
    client_name: clientName || "Liam",
    body,
    msg_type: "text",
    channel: addr.channel,
    conversation_id: conv?.id || null,
    timestamp: new Date().toISOString(),
    read: true,
  };

  const { data, error } = await sb()
    .from("wa_messages")
    .insert(row)
    .select("id")
    .single();

  if (error) {
    console.error("[agent-db] sendWebOutbound error:", error.message);
    return { ok: false, suppressed: false, error: error.message };
  }
  return { ok: true, suppressed: false, id: data?.id };
}

/**
 * Mensajes de una sesion para el widget. Por defecto solo los SALIENTES:
 * el widget ya pinta en pantalla lo que el visitante escribio, y devolverle
 * su propio texto lo duplicaria.
 */
export async function getChannelMessages(address, { after = null, direction = "outbound", limit = 30 } = {}) {
  const addr = parseAddress(address);

  let q = sb()
    .from("wa_messages")
    .select("id, direction, body, timestamp")
    .eq("channel", addr.channel)
    .order("timestamp", { ascending: true })
    .limit(limit);

  q = direction === "outbound"
    ? q.eq("to_number", addr.address).eq("direction", "outbound")
    : q.or(`from_number.eq.${addr.address},to_number.eq.${addr.address}`);

  if (after) q = q.gt("timestamp", after);

  const { data, error } = await q;
  if (error) {
    console.error("[agent-db] getChannelMessages error:", error.message);
    return [];
  }
  return (data || []).map((m) => ({
    id: m.id,
    direction: m.direction === "inbound" ? "out" : "in",   // 'in' = lo ve el visitante como recibido
    body: m.body || "",
    ts: m.timestamp,
  }));
}

/**
 * Cuelga de la conversacion las filas de esta direccion que quedaron sin
 * conversation_id (el mensaje entrante se guarda ANTES de que el router
 * cree la conversacion). Idempotente.
 */
export async function attachOrphanMessages(address, conversationId) {
  if (!conversationId) return;
  const addr = parseAddress(address);
  const { error } = await sb()
    .from("wa_messages")
    .update({ conversation_id: conversationId })
    .is("conversation_id", null)
    .eq("channel", addr.channel)
    .or(`from_number.eq.${addr.address},to_number.eq.${addr.address}`);
  if (error) console.error("[agent-db] attachOrphanMessages error:", error.message);
}

/**
 * Cuenta los mensajes entrantes de una direccion en una ventana de tiempo.
 * El endpoint web es publico y sin sesion: esto es lo que evita que alguien
 * gaste la cuota de la API de Anthropic en un bucle.
 */
export async function countRecentInbound(address, windowMs) {
  const addr = parseAddress(address);
  const since = new Date(Date.now() - windowMs).toISOString();
  const { count, error } = await sb()
    .from("wa_messages")
    .select("id", { count: "exact", head: true })
    .eq("from_number", addr.address)
    .eq("direction", "inbound")
    .gte("timestamp", since);
  if (error) {
    console.error("[agent-db] countRecentInbound error:", error.message);
    return 0;   // fail-open: no bloquear a un visitante real por un fallo de DB
  }
  return count || 0;
}
