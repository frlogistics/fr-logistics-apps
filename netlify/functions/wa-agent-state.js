// netlify/functions/wa-agent-state.js
//
// AGENT STATE for the WhatsApp Inbox (2026-09-18).
//
// The inbox needs, per contact, what LIAM knows and where the conversation
// stands — score, summary, next action, pause state, lead and quotes —
// without exposing the service key to the browser.
//
// GET  /wa-agent-state                → { "<phone|web:id>": {...}, ... }  (latest conversation per contact)
// GET  /wa-agent-state?phone=1786...  → { contact: {...}, quotes: [...] }   (one contact, with quotes)
// POST /wa-agent-state { action: "pause",  phone }   → human takes over (LIAM silent)
// POST /wa-agent-state { action: "resume", phone }   → hand back to LIAM
// POST /wa-agent-state { action: "note",   phone, next_action, next_action_date } → CRM next step on wa_leads
// POST /wa-agent-state { action: "block",   phone, reason: "vendor"|"noise" } → wa_blocklist + LIAM silent + leads flagged
// POST /wa-agent-state { action: "unblock", phone }  → lifts the block (LIAM stays paused until "Hand back")
//
// [2026-10-08] Blocklist: Noise / spam y Vendor pitch bloquean el numero.
// Funciona aunque el contacto no tenga lead (antes los botones quedaban
// deshabilitados sin lead_id). Bloqueado = LIAM no contesta, no se crean
// leads nuevos (trigger trg_wa_leads_skip_blocked), no hay seguimientos ni
// avisos, y el inbox lo esconde bajo el chip "Blocked".
//
// Same trust model as wa-messages.js: the portal is behind login and the
// function runs with the service key. No env vars added.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function normalizePhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.length === 12 && d.startsWith("11")) d = d.slice(1);
  if (d.length === 10 && /^[2-9]/.test(d)) d = "1" + d;
  return d;
}

// Accepts "1786...", "+1 786...", "web:<session>", "ig:<id>" → canonical key
function contactKey(raw) {
  const s = String(raw || "").trim();
  if (/^(web:|ig:)/i.test(s)) return s.toLowerCase();
  return normalizePhone(s);
}

async function sb(path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Supabase ${r.status}: ${t.slice(0, 200)}`);
  }
  if (init.headers?.Prefer === "return=minimal") return null;
  return r.json();
}

const CONV_COLS = [
  "id", "created_at", "updated_at", "wa_number", "channel", "channel_user_id", "wa_profile_name",
  "state", "sub_state", "language", "handoff_required", "handoff_reason", "handoff_at",
  "paused_by_human", "paused_by", "paused_at", "lead_id", "client_id", "is_existing_client",
  "captured_name", "captured_email", "captured_service", "captured_volume", "captured_country",
  "captured_stage", "captured_product_type", "captured_platforms",
  "handoff_summary", "lead_score", "lead_score_reason", "summary_at",
  "message_count", "last_user_message_at", "last_agent_message_at", "info_email_sent_at",
].join(",");

function shape(c, lead) {
  const key = c.channel && c.channel !== "whatsapp" ? `${c.channel === "web" ? "web" : "ig"}:${c.channel_user_id}` : normalizePhone(c.wa_number);
  return {
    key,
    conversation_id: c.id,
    channel: c.channel || "whatsapp",
    state: c.state,
    sub_state: c.sub_state,
    language: c.language,
    paused: !!c.paused_by_human,
    paused_by: c.paused_by,
    paused_at: c.paused_at,
    handoff_required: !!c.handoff_required,
    handoff_reason: c.handoff_reason,
    handoff_at: c.handoff_at,
    is_existing_client: !!c.is_existing_client,
    client_id: c.client_id,
    lead_id: c.lead_id,
    name: c.captured_name || lead?.name || c.wa_profile_name || null,
    email: c.captured_email || lead?.email || null,
    service: c.captured_service || null,
    volume: c.captured_volume || lead?.monthly_volume || null,
    country: c.captured_country || lead?.country || null,
    stage: c.captured_stage || null,
    product: c.captured_product_type || lead?.product_type || null,
    platforms: c.captured_platforms || null,
    score: c.lead_score || null,
    score_reason: c.lead_score_reason || null,
    summary: c.handoff_summary || lead?.conversation_summary || null,
    summary_at: c.summary_at,
    next_action: lead?.next_action || null,
    next_action_date: lead?.next_action_date || null,
    lead_status: lead?.status || null,
    lead_dq: lead?.dq_flag || null,
    lead_owner: lead?.owner || null,
    meeting_start: lead?.meeting_start_time || null,
    email_sent: !!c.info_email_sent_at,
    message_count: c.message_count || 0,
    last_user_message_at: c.last_user_message_at,
    last_agent_message_at: c.last_agent_message_at,
    updated_at: c.updated_at,
  };
}

const json_ = (o, status) => new Response(JSON.stringify(o), { status, headers: HEADERS });

// key "1786..." | "web:<id>" | "ig:<id>" → { channel, id }
function splitKey(key) {
  if (key.startsWith("web:")) return { channel: "web", id: key.slice(4) };
  if (key.startsWith("ig:")) return { channel: "instagram", id: key.slice(3) };
  return { channel: "whatsapp", id: key };
}
function keyOf(channel, id) {
  if (channel === "web") return `web:${id}`;
  if (channel === "instagram") return `ig:${id}`;
  return normalizePhone(id);
}

// Active blocks → { key: { reason, blocked_at } }. Fail-open.
async function loadBlocks() {
  try {
    const rows = await sb(`wa_blocklist?select=channel,channel_user_id,reason,blocked_at&unblocked_at=is.null`);
    const map = {};
    for (const r of rows || []) map[keyOf(r.channel, r.channel_user_id)] = { reason: r.reason, blocked_at: r.blocked_at };
    return map;
  } catch (e) {
    console.error("[wa-agent-state] blocklist read error:", e.message);
    return {};
  }
}

async function blockContact(key, reason, note) {
  const { channel, id } = splitKey(key);
  const now = new Date().toISOString();
  await sb(`wa_blocklist?on_conflict=channel,channel_user_id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ channel, channel_user_id: id, reason, note: note || null, blocked_at: now, blocked_by: "portal", unblocked_at: null }),
  });
  // LIAM silent on every conversation of the contact
  const convFilter = `channel=eq.${channel}&channel_user_id=eq.${encodeURIComponent(id)}`;
  await sb(`wa_agent_conversations?${convFilter}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ paused_by_human: true, paused_by: "blocklist", paused_at: now, state: "paused" }),
  });
  // Flag every lead of the contact so it drops out of the CRM pipeline
  const convs = await sb(`wa_agent_conversations?select=lead_id&${convFilter}`);
  const ids = [...new Set((convs || []).map((c) => c.lead_id).filter(Boolean))];
  const ors = [];
  if (ids.length) ors.push(`id.in.(${ids.join(",")})`);
  if (channel === "whatsapp") ors.push(`phone.eq.${encodeURIComponent("+" + id)}`);
  if (ors.length) {
    await sb(`wa_leads?or=(${ors.join(",")})`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ dq_flag: reason, dq_note: `portal: blocked as ${reason} ${now.slice(0, 10)}` }),
    });
  }
}

async function unblockContact(key) {
  const { channel, id } = splitKey(key);
  await sb(`wa_blocklist?channel=eq.${channel}&channel_user_id=eq.${encodeURIComponent(id)}&unblocked_at=is.null`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ unblocked_at: new Date().toISOString() }),
  });
}

async function loadLeads(ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return {};
  const rows = await sb(`wa_leads?select=id,name,email,status,dq_flag,owner,next_action,next_action_date,conversation_summary,monthly_volume,product_type,country,meeting_start_time&id=in.(${list.join(",")})`);
  const map = {};
  for (const r of rows || []) map[r.id] = r;
  return map;
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return new Response(JSON.stringify({ error: "Supabase env missing" }), { status: 500, headers: HEADERS });
  }

  try {
    if (req.method === "GET") {
      const url = new URL(req.url);
      const one = url.searchParams.get("phone");

      if (one) {
        const key = contactKey(one);
        const filter = /^(web|ig):/.test(key)
          ? `channel_user_id=eq.${encodeURIComponent(key.split(":")[1])}`
          : `wa_number=eq.${encodeURIComponent(key)}`;
        const convs = await sb(`wa_agent_conversations?select=${CONV_COLS}&${filter}&order=updated_at.desc&limit=1`);
        const c = convs?.[0];
        if (!c) return new Response(JSON.stringify({ contact: null, quotes: [] }), { status: 200, headers: HEADERS });
        const [leads, blocks] = await Promise.all([loadLeads([c.lead_id]), loadBlocks()]);
        const contact = shape(c, leads[c.lead_id]);
        contact.blocked = blocks[contact.key]?.reason || null;

        // Quotes: by lead, else by email
        let quotes = [];
        try {
          const ors = [];
          if (c.lead_id) ors.push(`source_lead_id.eq.${c.lead_id}`);
          if (contact.email) ors.push(`contact_email.ilike.${encodeURIComponent(contact.email)}`);
          if (c.client_id) ors.push(`client_id.eq.${c.client_id}`);
          if (ors.length) {
            quotes = await sb(`quotes?select=quote_id,client_name,status,quote_date,valid_until,subtotal,suggested,op_type,created_at&or=(${ors.join(",")})&order=created_at.desc&limit=10`);
          }
        } catch (e) { console.error("[wa-agent-state] quotes error:", e.message); }

        return new Response(JSON.stringify({ contact, quotes: quotes || [] }), { status: 200, headers: HEADERS });
      }

      // Bulk: latest conversation per contact (last 400 conversations)
      const convs = await sb(`wa_agent_conversations?select=${CONV_COLS}&order=updated_at.desc&limit=400`);
      const [leads, blocks] = await Promise.all([loadLeads((convs || []).map((c) => c.lead_id)), loadBlocks()]);
      const out = {};
      for (const c of convs || []) {
        const s = shape(c, leads[c.lead_id]);
        if (!s.key) continue;
        if (!out[s.key]) { s.blocked = blocks[s.key]?.reason || null; out[s.key] = s; }   // first = most recent
      }
      return new Response(JSON.stringify(out), { status: 200, headers: HEADERS });
    }

    if (req.method === "POST") {
      let body;
      try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: HEADERS }); }
      const key = contactKey(body.phone);
      if (!key) return new Response(JSON.stringify({ error: "phone required" }), { status: 400, headers: HEADERS });
      const filter = /^(web|ig):/.test(key)
        ? `channel_user_id=eq.${encodeURIComponent(key.split(":")[1])}`
        : `wa_number=eq.${encodeURIComponent(key)}`;

      const convs = await sb(`wa_agent_conversations?select=id,state,lead_id,paused_by_human&${filter}&order=updated_at.desc&limit=1`);
      const c = convs?.[0];

      if (body.action === "pause") {
        if (!c) return new Response(JSON.stringify({ error: "no conversation" }), { status: 404, headers: HEADERS });
        await sb(`wa_agent_conversations?id=eq.${c.id}`, {
          method: "PATCH", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ paused_by_human: true, paused_at: new Date().toISOString(), paused_by: body.by || "portal", state: "paused" }),
        });
        return new Response(JSON.stringify({ ok: true, paused: true }), { status: 200, headers: HEADERS });
      }

      if (body.action === "resume") {
        if (!c) return new Response(JSON.stringify({ error: "no conversation" }), { status: 404, headers: HEADERS });
        // Back to a state the router handles: "greeted" (menu context). The
        // autopause trigger only fires on the handoff_required transition,
        // so resuming is stable.
        const patch = { paused_by_human: false, paused_at: null, paused_by: null };
        if (c.state === "paused") { patch.state = "greeted"; patch.sub_state = null; }
        await sb(`wa_agent_conversations?id=eq.${c.id}`, {
          method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch),
        });
        return new Response(JSON.stringify({ ok: true, paused: false }), { status: 200, headers: HEADERS });
      }

      if (body.action === "block") {
        const reason = body.reason;
        if (!["vendor", "noise"].includes(reason)) return json_({ error: "reason must be vendor or noise" }, 400);
        await blockContact(key, reason, body.note);
        return json_({ ok: true, blocked: reason }, 200);
      }

      if (body.action === "unblock") {
        await unblockContact(key);
        return json_({ ok: true, blocked: null }, 200);
      }

      if (body.action === "note") {
        // Noise / Vendor = block (works with or without a lead)
        if (["vendor", "noise"].includes(body.dq_flag)) {
          await blockContact(key, body.dq_flag, null);
          return json_({ ok: true, blocked: body.dq_flag }, 200);
        }
        if (!c?.lead_id) return new Response(JSON.stringify({ error: "no lead" }), { status: 404, headers: HEADERS });
        const patch = {};
        if (body.next_action !== undefined) patch.next_action = String(body.next_action || "").slice(0, 200) || null;
        if (body.next_action_date !== undefined) patch.next_action_date = body.next_action_date || null;
        if (body.owner !== undefined) patch.owner = body.owner || null;
        if (body.dq_flag !== undefined) {
          const ok = ["real", "duplicate", "existing_client", "internal", "vendor", "noise"];
          if (body.dq_flag !== null && !ok.includes(body.dq_flag)) return json_({ error: "bad dq_flag" }, 400);
          patch.dq_flag = body.dq_flag; patch.dq_note = `portal: set by human ${new Date().toISOString().slice(0, 10)}`;
        }
        await sb(`wa_leads?id=eq.${c.lead_id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: HEADERS });
      }

      return new Response(JSON.stringify({ error: "unknown action" }), { status: 400, headers: HEADERS });
    }

    return new Response("Method Not Allowed", { status: 405, headers: HEADERS });
  } catch (e) {
    console.error("[wa-agent-state] error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: HEADERS });
  }
}
