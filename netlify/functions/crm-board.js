// ════════════════════════════════════════════════════════════════════════════
// crm-board.js — FR-Logistics CRM Scorecard API
// Storage: Supabase (quotes + wa_leads)
// Pattern: same as dashboard-kpis.js / services-log.js (CommonJS, Lambda compat)
//
// Endpoints:
//   GET  ?action=board            -> { ok, generated_at, kpi, quotes[], leads[] }
//
//   POST { action:'update_quote', quote_id, status?, valid_until?, owner?, notes? }
//   POST { action:'update_lead',  id, status?, next_action?, next_action_date?,
//                                 owner?, dq_flag? }
//
// Uses only SUPABASE_URL + SUPABASE_SERVICE_KEY, which already exist on the
// site. No new environment variables — the site sits just under the 4KB
// AWS Lambda ceiling and cannot take another one.
// ════════════════════════════════════════════════════════════════════════════

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

const QUOTE_STATUSES = ['draft', 'sent', 'negotiating', 'won', 'lost'];
const LEAD_STATUSES = ['new', 'qualifying', 'sent_to_sales', 'won', 'lost'];
const DQ_FLAGS = ['real', 'duplicate', 'existing_client', 'internal', 'vendor', 'noise'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json'
};

function reply(code, body) {
  return { statusCode: code, headers: CORS, body: JSON.stringify(body) };
}

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.method === 'PATCH' ? 'return=representation' : 'count=exact',
      ...(opts.headers || {})
    }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : [];
}

const today = () => new Date().toISOString().slice(0, 10);

function daysBetween(from, to) {
  if (!from) return null;
  const a = new Date(from + (from.length === 10 ? 'T00:00:00Z' : ''));
  const b = new Date(to + 'T00:00:00Z');
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

async function buildBoard() {
  const now = today();

  const quoteCols = 'id,quote_id,client_name,contact_name,contact_email,channel,op_type,' +
    'quote_date,valid_until,status,subtotal,min_billing,monthly_orders,monthly_units,owner,notes,updated_at';
  const leadCols = 'id,name,email,phone,country,service,service_detail,monthly_volume,status,' +
    'source,captured_by,owner,next_action,next_action_date,meeting_start_time,notes,created_at,updated_at,dq_flag';

  const [rawQuotes, rawLeads] = await Promise.all([
    sb(`quotes?select=${quoteCols}&order=quote_date.desc`),
    sb(`wa_leads?select=${leadCols}&dq_flag=eq.real` +
       `&status=in.(new,qualifying,sent_to_sales)&order=created_at.desc&limit=400`)
  ]);

  const quotes = rawQuotes.map(q => {
    const daysToExpiry = q.valid_until ? daysBetween(now, q.valid_until) : null;
    // Age is measured from quote_date, not updated_at: updated_at moves every
    // time anyone edits a field, which would reset the clock and hide a quote
    // that has been sitting untouched for weeks.
    return {
      ...q,
      days_idle: daysBetween((q.quote_date || '').slice(0, 10), now),
      days_to_expiry: daysToExpiry,
      expired: daysToExpiry !== null && daysToExpiry < 0
    };
  });

  // A lead nobody has worked is as old as the day it arrived. Once it is
  // being worked, the clock restarts from the last touch.
  const leads = rawLeads.map(l => {
    const anchor = l.status === 'new'
      ? (l.created_at || '')
      : (l.updated_at || l.created_at || '');
    return {
      ...l,
      days_idle: daysBetween(anchor.slice(0, 10), now),
      action_overdue: !!(l.next_action_date && l.next_action_date < now),
      days_to_action: l.next_action_date ? daysBetween(now, l.next_action_date) : null
    };
  });

  const open = quotes.filter(q => q.status === 'draft' || q.status === 'sent' || q.status === 'negotiating');
  const num = v => (v === null || v === undefined ? 0 : Number(v));

  const kpi = {
    open_quotes: open.length,
    unsent_quotes: quotes.filter(q => q.status === 'draft').length,
    value_on_table: open.reduce((s, q) => s + num(q.subtotal), 0),
    expiring_7d: open.filter(q => q.days_to_expiry !== null && q.days_to_expiry >= 0 && q.days_to_expiry <= 7).length,
    expired_quotes: open.filter(q => q.expired).length,
    leads_untouched: leads.filter(l => l.status === 'new').length,
    leads_working: leads.filter(l => l.status !== 'new').length,
    actions_overdue: leads.filter(l => l.action_overdue).length,
    actions_next_7d: leads.filter(l => l.days_to_action !== null && l.days_to_action >= 0 && l.days_to_action <= 7).length,
    stale_over_30d: [...open, ...leads].filter(x => (x.days_idle || 0) > 30).length,
    won_quotes: quotes.filter(q => q.status === 'won').length,
    lost_quotes: quotes.filter(q => q.status === 'lost').length
  };

  return { ok: true, generated_at: new Date().toISOString(), kpi, quotes, leads };
}

async function updateQuote(b) {
  if (!b.quote_id) return reply(400, { ok: false, error: 'quote_id is required' });
  const patch = {};
  if (b.status !== undefined) {
    if (!QUOTE_STATUSES.includes(b.status))
      return reply(400, { ok: false, error: `status must be one of ${QUOTE_STATUSES.join(', ')}` });
    patch.status = b.status;
  }
  if (b.valid_until !== undefined) patch.valid_until = b.valid_until || null;
  if (b.owner !== undefined) patch.owner = b.owner || null;
  if (b.notes !== undefined) patch.notes = b.notes;
  if (!Object.keys(patch).length) return reply(400, { ok: false, error: 'Nothing to update' });
  patch.updated_at = new Date().toISOString();

  const rows = await sb(`quotes?quote_id=eq.${encodeURIComponent(b.quote_id)}`, {
    method: 'PATCH', body: JSON.stringify(patch)
  });
  if (!rows.length) return reply(404, { ok: false, error: 'Quote not found' });
  return reply(200, { ok: true, row: rows[0] });
}

async function updateLead(b) {
  if (!b.id) return reply(400, { ok: false, error: 'id is required' });
  const patch = {};
  if (b.status !== undefined) {
    if (!LEAD_STATUSES.includes(b.status))
      return reply(400, { ok: false, error: `status must be one of ${LEAD_STATUSES.join(', ')}` });
    patch.status = b.status;
  }
  if (b.dq_flag !== undefined) {
    if (!DQ_FLAGS.includes(b.dq_flag))
      return reply(400, { ok: false, error: `dq_flag must be one of ${DQ_FLAGS.join(', ')}` });
    patch.dq_flag = b.dq_flag;
  }
  if (b.next_action !== undefined) patch.next_action = b.next_action || null;
  if (b.next_action_date !== undefined) patch.next_action_date = b.next_action_date || null;
  if (b.owner !== undefined) patch.owner = b.owner || null;
  if (!Object.keys(patch).length) return reply(400, { ok: false, error: 'Nothing to update' });
  patch.updated_at = new Date().toISOString();

  const rows = await sb(`wa_leads?id=eq.${encodeURIComponent(b.id)}`, {
    method: 'PATCH', body: JSON.stringify(patch)
  });
  if (!rows.length) return reply(404, { ok: false, error: 'Lead not found' });
  return reply(200, { ok: true, row: rows[0] });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!SUPA_URL || !SUPA_KEY)
    return reply(500, { ok: false, error: 'SUPABASE_URL / SUPABASE_SERVICE_KEY are not configured' });

  try {
    if (event.httpMethod === 'GET') return reply(200, await buildBoard());

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      if (b.action === 'update_quote') return await updateQuote(b);
      if (b.action === 'update_lead') return await updateLead(b);
      return reply(400, { ok: false, error: "action must be 'update_quote' or 'update_lead'" });
    }

    return reply(405, { ok: false, error: 'Method not allowed' });
  } catch (err) {
    console.error('[crm-board]', err);
    return reply(500, { ok: false, error: String(err.message || err) });
  }
};
