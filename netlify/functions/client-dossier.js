// ════════════════════════════════════════════════════════════════════════════
// client-dossier.js — FR-Logistics: everything known about one account
// Storage: Supabase (fr_clients + quotes + wa_leads + operational tables)
// Pattern: same as crm-board.js (CommonJS, Lambda compat)
//
// Endpoint:
//   GET ?client_id=<uuid>    full dossier for a client
//   GET ?quote_id=<ref>      dossier anchored on a quote (client may be null
//                            when the quote belongs to a prospect)
//   GET ?lead_id=<uuid>      dossier anchored on a lead
//
// READ ONLY. Nothing here writes. A window that also edits doubles the
// surface for mistakes, and the board already edits status and next action.
//
// History is capped at MAX_ROWS per section with the true total alongside:
// a client with 221 shipments does not need 221 rows to be understood.
//
// Uses only SUPABASE_URL + SUPABASE_SERVICE_KEY + FR_APP_TOKEN.
// ════════════════════════════════════════════════════════════════════════════

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

// ─── ACCESS GUARD ───────────────────────────────────────────────────────────
// Same guard as the board: this returns contract terms, negotiated rates and
// contact details. Fails CLOSED when FR_APP_TOKEN is not configured.
const APP_TOKEN = process.env.FR_APP_TOKEN;

function tokenOk(event) {
  if (!APP_TOKEN) return false;
  const h = event.headers || {};
  const sent = h['x-fr-token'] || h['X-Fr-Token'] || '';
  if (!sent || sent.length !== APP_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < APP_TOKEN.length; i++) diff |= sent.charCodeAt(i) ^ APP_TOKEN.charCodeAt(i);
  return diff === 0;
}

const MAX_ROWS = 10;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-fr-token',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Content-Type': 'application/json'
};
const reply = (c, b) => ({ statusCode: c, headers: CORS, body: JSON.stringify(b) });
const enc = encodeURIComponent;

// Returns { rows, total } — the total comes from the Content-Range header that
// PostgREST sends with Prefer: count=exact, so the count is the real one and
// not just the length of the page.
async function sbPage(path) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
      Prefer: 'count=exact', Range: `0-${MAX_ROWS - 1}`
    }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
  const rows = text ? JSON.parse(text) : [];
  const cr = res.headers.get('content-range') || '';
  const total = Number(String(cr).split('/')[1]);
  return { rows, total: Number.isFinite(total) ? total : rows.length };
}

async function sbAll(path) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : [];
}

// Resolves which client (if any) the request is about.
async function resolveClient(p) {
  if (p.client_id) {
    const r = await sbAll(`fr_clients?id=eq.${enc(p.client_id)}&select=*`);
    return { client: r[0] || null, anchor: 'client' };
  }
  if (p.quote_id) {
    const q = await sbAll(`quotes?quote_id=eq.${enc(p.quote_id)}&select=client_id,client_name,contact_email`);
    if (!q.length) return { client: null, anchor: 'quote', notFound: true };
    if (q[0].client_id) {
      const r = await sbAll(`fr_clients?id=eq.${enc(q[0].client_id)}&select=*`);
      return { client: r[0] || null, anchor: 'quote', quote: q[0] };
    }
    return { client: null, anchor: 'quote', quote: q[0] };
  }
  if (p.lead_id) {
    const l = await sbAll(`wa_leads?id=eq.${enc(p.lead_id)}&select=client_id,name,email,phone`);
    if (!l.length) return { client: null, anchor: 'lead', notFound: true };
    if (l[0].client_id) {
      const r = await sbAll(`fr_clients?id=eq.${enc(l[0].client_id)}&select=*`);
      return { client: r[0] || null, anchor: 'lead', lead: l[0] };
    }
    return { client: null, anchor: 'lead', lead: l[0] };
  }
  return { client: null, anchor: null, missing: true };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return reply(405, { ok: false, error: 'Method not allowed' });
  if (!SUPA_URL || !SUPA_KEY)
    return reply(500, { ok: false, error: 'SUPABASE_URL / SUPABASE_SERVICE_KEY are not configured' });
  if (!tokenOk(event))
    return reply(401, { ok: false, error: 'Unauthorized', need_token: true });

  try {
    const p = event.queryStringParameters || {};
    const res = await resolveClient(p);
    if (res.missing) return reply(400, { ok: false, error: 'Pass client_id, quote_id or lead_id' });
    if (res.notFound) return reply(404, { ok: false, error: 'Not found' });

    const c = res.client;
    const out = {
      ok: true,
      anchor: res.anchor,
      is_client: !!c,
      client: c || null,
      generated_at: new Date().toISOString()
    };

    // ── Commercial side: works with or without a client record ──────────────
    // A prospect has no client_id anywhere, so quotes and leads are matched by
    // the identifiers we actually have: the quote reference and the email.
    const email = (c && c.email) || (res.quote && res.quote.contact_email) || (res.lead && res.lead.email) || '';
    const name  = (c && c.company) || (res.quote && res.quote.client_name) || '';

    const quoteFilters = [];
    // The quote you clicked is always in the dossier, even if it has no client
    // link and no matching email yet.
    if (p.quote_id) quoteFilters.push(`quote_id.eq.${enc(p.quote_id)}`);
    if (c) quoteFilters.push(`client_id.eq.${enc(c.id)}`);
    if (email && email.includes('@')) quoteFilters.push(`contact_email.eq.${enc(email)}`);
    if (name) quoteFilters.push(`client_name.eq.${enc(name)}`);

    const leadFilters = [];
    if (c) leadFilters.push(`client_id.eq.${enc(c.id)}`);
    if (email && email.includes('@')) leadFilters.push(`email.eq.${enc(email)}`);
    if (res.lead) leadFilters.push(`id.eq.${enc(p.lead_id)}`);

    const tasks = {};

    tasks.quotes = quoteFilters.length
      ? sbPage(`quotes?or=(${quoteFilters.join(',')})&order=quote_date.desc`
             + `&select=quote_id,client_name,contact_name,status,subtotal,min_billing,`
             + `quote_date,valid_until,op_type,channel,notes`)
      : Promise.resolve({ rows: [], total: 0 });

    tasks.leads = leadFilters.length
      ? sbPage(`wa_leads?or=(${leadFilters.join(',')})&order=created_at.desc`
             + `&select=id,name,email,phone,country,service,service_detail,monthly_volume,`
             + `status,source,dq_flag,next_action,next_action_date,meeting_start_time,created_at`)
      : Promise.resolve({ rows: [], total: 0 });

    // ── Operational side: only exists for a real client. These tables all
    //    carry a populated client_id FK, so the joins are exact.
    if (c) {
      const id = enc(c.id);
      tasks.shipments = sbPage(`shipments_general?client_id=eq.${id}&order=created_at.desc`
        + `&select=id,created_at,received_at,carrier,tracking,direction,type,notes,billed_at`);
      tasks.orders = sbPage(`client_orders?client_id=eq.${id}&order=created_at.desc`
        + `&select=id,created_at,order_number,status,recipient_name,city,state,country_code,shipping_service,exported_at`);
      tasks.billing = sbPage(`billing_runs?client_id=eq.${id}&order=generated_at.desc`
        + `&select=id,invoice_number,period_start,period_end,total_usd,package_count,mmb_amount,status,generated_at`);
      tasks.dropshipments = sbPage(`dropshipments?client_id=eq.${id}&order=created_at.desc`
        + `&select=id,created_at,tracking_number,carrier,content,qty_boxes,outbound_tracking,status,shipped_at`);
      tasks.rates = sbPage(`fr_client_rates?or=(client_id.eq.${id},client_name.eq.${enc(c.company || '')})&select=*`);
    }

    const keys = Object.keys(tasks);
    const settled = await Promise.allSettled(keys.map(k => tasks[k]));

    // One failing section must not blank the whole dossier — it reports its
    // own error and the rest still renders.
    keys.forEach((k, i) => {
      const s = settled[i];
      out[k] = s.status === 'fulfilled'
        ? { rows: s.value.rows, total: s.value.total, shown: s.value.rows.length }
        : { rows: [], total: 0, shown: 0, error: String(s.reason && s.reason.message || s.reason) };
    });

    if (!c) {
      out.note = 'Prospect: no client record yet, so there is no operational history.';
    }
    out.max_rows = MAX_ROWS;
    return reply(200, out);
  } catch (err) {
    console.error('[client-dossier]', err);
    return reply(500, { ok: false, error: String(err.message || err) });
  }
};
