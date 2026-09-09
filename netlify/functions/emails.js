// netlify/functions/emails.js
// FR-Logistics — Email Builder backend (emails.html).
// Pre-signature correspondence with prospects/clients: quotations, terms,
// qualification, follow-ups. Post-signature material stays in onboarding.html.
//
//   GET  ?action=bootstrap                -> { templates, policy, catalog }
//   GET  ?action=messages[&client_id=][&limit=] -> { messages }
//   GET  ?action=message&id=<uuid>        -> { message }
//   POST { action:'save_message',  message:{...} }   -> { message }   (insert or update)
//   POST { action:'save_template', template:{...} }  -> { template }  (upsert by slug)
//   POST { action:'mark_sent',     id, register_quote:true } -> { message, quote }
//   POST { action:'gmail_draft',   id, to, subject, htmlBody, textBody } -> { message, result }
//   POST { action:'delete_message', id } -> { ok }
//
// Tables: email_templates, email_policy_blocks, email_messages (migration
// email_builder_module, 9-Sep-2026). All three are service_role-only.
// mark_sent also upserts `quotes` (on quote_id) so the message shows up in
// v_crm_pipeline / v_crm_agenda without touching the SQL editor.
//
// Uses SUPABASE_URL + SUPABASE_SERVICE_KEY only. No new environment variables.

const ALLOWED_ORIGINS = [
  'https://apps.fr-logistics.net',
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
];

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Same Apps Script the onboarding package uses (creates a Gmail draft in
// josefuentes@fr-logistics.net). Kept identical to send-onboard-email.js.
const APPS_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbwnaHp2828BuXKkxPMCG8CsWG5eTjPPlYWx6RI4HevUZdpfA5TaDz13vHOHtkRrUM8rDw/exec';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUOTE_VALID_DAYS = 30;

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

async function sb(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error((json && (json.message || json.error)) || `Supabase ${res.status}`);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

const ok = (headers, body, status = 200) => ({ statusCode: status, headers, body: JSON.stringify(body) });
const bad = (headers, message, status = 400, extra = {}) =>
  ({ statusCode: status, headers, body: JSON.stringify({ error: message, ...extra }) });

// Only these columns can be written from the client. Anything else is dropped.
const MESSAGE_FIELDS = [
  'ref', 'subject', 'to_email', 'to_name', 'company', 'client_id', 'lead_id',
  'template_slug', 'lang', 'body', 'created_by',
];
const TEMPLATE_FIELDS = ['slug', 'name', 'service_line', 'lang', 'body', 'active', 'sort_order'];

function pick(obj, fields) {
  const out = {};
  fields.forEach((f) => { if (obj[f] !== undefined) out[f] = obj[f]; });
  return out;
}

function cleanMessage(m) {
  const row = pick(m || {}, MESSAGE_FIELDS);
  if (row.client_id && !UUID_RE.test(String(row.client_id))) row.client_id = null;
  if (row.lead_id && !UUID_RE.test(String(row.lead_id))) row.lead_id = null;
  if (row.client_id === '') row.client_id = null;
  if (row.lead_id === '') row.lead_id = null;
  if (row.lang) row.lang = String(row.lang).toUpperCase() === 'EN' ? 'EN' : 'ES';
  if (row.ref) row.ref = String(row.ref).trim().slice(0, 40);
  if (row.to_email) row.to_email = String(row.to_email).trim().toLowerCase().slice(0, 200);
  if (row.body && typeof row.body !== 'object') {
    try { row.body = JSON.parse(row.body); } catch { row.body = null; }
  }
  return row;
}

function isoDatePlus(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const headers = corsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return bad(headers, 'Server not configured', 500);

  const qs = event.queryStringParameters || {};

  // ── GET ──────────────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    try {
      const action = qs.action || 'bootstrap';

      if (action === 'bootstrap') {
        const [templates, policy, catalog] = await Promise.all([
          sb('email_templates?active=eq.true&order=sort_order.asc,name.asc'),
          sb('email_policy_blocks?active=eq.true&order=sort_order.asc,slug.asc'),
          sb('fr_service_catalog?active=eq.true&select=service_code,service_name,unit,default_rate,category,sort_order&order=sort_order.asc'),
        ]);
        return ok(headers, { templates, policy, catalog });
      }

      if (action === 'messages') {
        const limit = Math.min(Math.max(parseInt(qs.limit || '50', 10) || 50, 1), 200);
        let path = `email_messages?select=id,ref,subject,to_email,to_name,company,client_id,lead_id,template_slug,lang,status,sent_at,gmail_draft_at,created_at,updated_at&order=updated_at.desc&limit=${limit}`;
        if (qs.client_id && UUID_RE.test(qs.client_id)) path += `&client_id=eq.${qs.client_id}`;
        if (qs.status) path += `&status=eq.${encodeURIComponent(qs.status)}`;
        const messages = await sb(path);
        return ok(headers, { messages });
      }

      if (action === 'message') {
        if (!UUID_RE.test(qs.id || '')) return bad(headers, 'Invalid id');
        const rows = await sb(`email_messages?id=eq.${qs.id}&limit=1`);
        if (!rows.length) return bad(headers, 'Not found', 404);
        return ok(headers, { message: rows[0] });
      }

      return bad(headers, 'Unknown action');
    } catch (err) {
      return bad(headers, 'Read failed', err.status === 404 ? 404 : 500, { detail: String(err.message) });
    }
  }

  if (event.httpMethod !== 'POST') return bad(headers, 'Method not allowed', 405);

  // ── POST ─────────────────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return bad(headers, 'Invalid JSON'); }
  const action = String(body.action || '');

  try {
    if (action === 'save_message') {
      const row = cleanMessage(body.message);
      if (!row.body || typeof row.body !== 'object') return bad(headers, 'message.body must be the builder JSON');
      const id = body.message && body.message.id;
      let rows;
      if (id && UUID_RE.test(id)) {
        row.updated_at = new Date().toISOString();
        rows = await sb(`email_messages?id=eq.${id}`, { method: 'PATCH', body: row, prefer: 'return=representation' });
        if (!rows.length) return bad(headers, 'Not found', 404);
      } else {
        rows = await sb('email_messages', { method: 'POST', body: row, prefer: 'return=representation' });
      }
      return ok(headers, { message: rows[0] });
    }

    if (action === 'save_template') {
      const t = pick(body.template || {}, TEMPLATE_FIELDS);
      t.slug = String(t.slug || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 60);
      if (!t.slug || !t.name || !t.body) return bad(headers, 'template.slug, name and body are required');
      if (t.lang) t.lang = String(t.lang).toUpperCase() === 'EN' ? 'EN' : 'ES';
      t.updated_at = new Date().toISOString();
      const rows = await sb('email_templates?on_conflict=slug', {
        method: 'POST', body: t, prefer: 'resolution=merge-duplicates,return=representation',
      });
      return ok(headers, { template: rows[0] });
    }

    if (action === 'delete_message') {
      if (!UUID_RE.test(body.id || '')) return bad(headers, 'Invalid id');
      // Sent messages are history — they don't get deleted from the app.
      const rows = await sb(`email_messages?id=eq.${body.id}&status=neq.sent`, { method: 'DELETE', prefer: 'return=representation' });
      return ok(headers, { ok: true, deleted: rows.length });
    }

    if (action === 'mark_sent') {
      if (!UUID_RE.test(body.id || '')) return bad(headers, 'Invalid id');
      const cur = (await sb(`email_messages?id=eq.${body.id}&limit=1`))[0];
      if (!cur) return bad(headers, 'Not found', 404);
      const now = new Date().toISOString();
      const rows = await sb(`email_messages?id=eq.${body.id}`, {
        method: 'PATCH', body: { status: 'sent', sent_at: now, updated_at: now }, prefer: 'return=representation',
      });
      const message = rows[0];

      let quote = null;
      if (body.register_quote !== false && message.ref) {
        // Resolve client_code from fr_clients when we have a client; otherwise
        // the 8-char prefix of the ref (convention XXXX_XXX-YYMMDD).
        let clientCode = null;
        if (message.client_id) {
          const c = (await sb(`fr_clients?id=eq.${message.client_id}&select=client_code&limit=1`))[0];
          clientCode = c && c.client_code ? c.client_code : null;
        }
        if (!clientCode) clientCode = String(message.ref).split('-')[0].slice(0, 8) || null;

        const q = {
          quote_id: message.ref,
          client_name: message.company || message.to_name || null,
          contact_name: message.to_name || null,
          contact_email: message.to_email || null,
          quote_date: now.slice(0, 10),
          validity: `${QUOTE_VALID_DAYS} days`,
          valid_until: isoDatePlus(QUOTE_VALID_DAYS),
          prepared_by: message.created_by || 'Jose Fuentes',
          owner: message.created_by || 'Jose Fuentes',
          status: 'sent',
          notes: `Email builder · ${message.template_slug || 'custom'} · ${message.subject || ''}`.slice(0, 500),
          client_id: message.client_id || null,
          client_code: clientCode,
          source_lead_id: message.lead_id || null,
          updated_at: now,
        };
        const qrows = await sb('quotes?on_conflict=quote_id', {
          method: 'POST', body: q, prefer: 'resolution=merge-duplicates,return=representation',
        });
        quote = qrows[0] || null;
      }
      return ok(headers, { message, quote });
    }

    if (action === 'gmail_draft') {
      if (!UUID_RE.test(body.id || '')) return bad(headers, 'Invalid id');
      const { to, subject, htmlBody, textBody } = body;
      if (!to || !subject || !htmlBody) return bad(headers, 'to, subject and htmlBody are required');

      const response = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' }, // avoids the Apps Script preflight
        body: JSON.stringify({ to, subject, htmlBody, textBody: textBody || '', attachments: [] }),
        redirect: 'follow',
      });
      const text = await response.text();
      let result;
      try { result = JSON.parse(text); }
      catch { result = { success: true, note: 'Draft likely created (CORS read blocked)' }; }

      const now = new Date().toISOString();
      const rows = await sb(`email_messages?id=eq.${body.id}`, {
        method: 'PATCH',
        body: { status: 'gmail_draft', gmail_draft_at: now, updated_at: now, to_email: String(to).toLowerCase(), subject },
        prefer: 'return=representation',
      });
      return ok(headers, { message: rows[0], result });
    }

    return bad(headers, 'Unknown action');
  } catch (err) {
    return bad(headers, 'Write failed', 500, { detail: String(err.message), payload: err.payload || null });
  }
};
