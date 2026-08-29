// ════════════════════════════════════════════════════════════════════════════
// quote-save.js — FR-Logistics Quote Builder persistence
// Storage: Supabase (public.quotes)
// Pattern: same as billing-rates.js / quote-leads.js (CommonJS, Lambda compat)
//
// Endpoints:
//   POST  { quote_id, client_name, ... , lines:[...] }   upsert a quote
//   PATCH { quote_id, status }                           advance a quote
//
// Called by FR_Logistics_Quote_System_v3.html when "Generate Quote" is pressed
// (saved as draft) and again when the email draft is created (moved to sent).
//
// Saving is deliberately non-fatal on the client side: if this endpoint is
// down, the quote must still generate, print and email. It is a recorder,
// never a gate.
//
// Uses only SUPABASE_URL + SUPABASE_SERVICE_KEY, which already exist.
// ════════════════════════════════════════════════════════════════════════════

const SUPA_URL = process.env.SUPABASE_URL;

// ─── ACCESS GUARD ───────────────────────────────────────────────────────────
// These endpoints return commercial data (quote amounts, prospect contacts)
// and can write to the database, so they cannot stay open like the rest of
// the site. The shared token lives in the FR_APP_TOKEN environment variable
// and is typed once by the operator in the app — never committed, because
// this repository is public.
//
// Fails CLOSED: if FR_APP_TOKEN is not configured the endpoint refuses every
// request rather than silently serving the data unprotected.
const APP_TOKEN = process.env.FR_APP_TOKEN;

function tokenOk(event) {
  if (!APP_TOKEN) return false;
  const h = event.headers || {};
  const sent = h['x-fr-token'] || h['X-Fr-Token'] || '';
  if (!sent || sent.length !== APP_TOKEN.length) return false;
  // Constant-time compare so the token cannot be guessed a character at a time.
  let diff = 0;
  for (let i = 0; i < APP_TOKEN.length; i++) diff |= sent.charCodeAt(i) ^ APP_TOKEN.charCodeAt(i);
  return diff === 0;
}

const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

const STATUSES = ['draft', 'sent', 'negotiating', 'won', 'lost'];
// A quote that already moved forward must not be dragged back to draft just
// because someone reopened the builder and pressed Generate again.
const RANK = { draft: 0, sent: 1, negotiating: 2, won: 3, lost: 3 };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-fr-token',
  'Access-Control-Allow-Methods': 'POST,PATCH,OPTIONS',
  'Content-Type': 'application/json'
};
const reply = (c, b) => ({ statusCode: c, headers: CORS, body: JSON.stringify(b) });

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {})
    }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : [];
}

const num = v => (v === null || v === undefined || v === '' ? null : Number(v));

// The builder's "validity" field is free text ("30 days", "30", "2026-09-30").
// Only a value we can resolve with certainty becomes a real date; anything
// else stays null rather than inventing an expiry the quote never stated.
function resolveValidUntil(validity, quoteDate) {
  if (!validity) return null;
  const v = String(validity).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const days = v.match(/^(\d{1,3})\s*(d|days|dias|días)?$/i);
  if (days && quoteDate && /^\d{4}-\d{2}-\d{2}$/.test(quoteDate)) {
    const d = new Date(quoteDate + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + Number(days[1]));
    return d.toISOString().slice(0, 10);
  }
  return null;
}

async function upsertQuote(b) {
  if (!b.quote_id) return reply(400, { ok: false, error: 'quote_id is required' });
  if (!b.client_name) return reply(400, { ok: false, error: 'client_name is required' });

  const lines = Array.isArray(b.lines) ? b.lines : [];
  const quoteDate = b.quote_date || new Date().toISOString().slice(0, 10);

  const row = {
    quote_id: b.quote_id,
    client_name: b.client_name,
    contact_name: b.contact_name || null,
    contact_email: b.contact_email || null,
    channel: b.channel || null,
    op_type: b.op_type || null,
    quote_date: quoteDate,
    validity: b.validity || null,
    valid_until: resolveValidUntil(b.validity, quoteDate),
    prepared_by: b.prepared_by || null,
    owner: b.prepared_by || null,
    monthly_orders: num(b.monthly_orders),
    monthly_pallets: num(b.monthly_pallets),
    monthly_units: num(b.monthly_units),
    min_billing: num(b.min_billing),
    subtotal: num(b.subtotal),
    suggested: num(b.suggested),
    notes: b.notes || null,
    // Every line keeps its canonical service_code. That code is what lets a
    // won quote populate fr_client_rates without anyone retyping a rate.
    services: lines.map(l => ({
      code: l.code || null,
      service: l.service || null,
      category: l.cat || null,
      description: l.desc || null,
      unit: l.unit || null,
      qty: num(l.qty),
      rate: num(l.rate),
      total: num(l.total)
    })),
    source_lead_id: b.source_lead_id || null,
    updated_at: new Date().toISOString()
  };

  const existing = await sb(
    `quotes?quote_id=eq.${encodeURIComponent(b.quote_id)}&select=id,status`
  );

  if (!existing.length) {
    row.status = 'draft';
    const created = await sb('quotes', { method: 'POST', body: JSON.stringify(row) });
    return reply(200, { ok: true, created: true, quote: created[0] });
  }

  // Re-generating an existing quote refreshes the numbers but never rewinds
  // its stage.
  const current = existing[0].status || 'draft';
  if (RANK[current] > RANK.draft) delete row.status; else row.status = 'draft';

  const updated = await sb(`quotes?quote_id=eq.${encodeURIComponent(b.quote_id)}`, {
    method: 'PATCH', body: JSON.stringify(row)
  });
  return reply(200, { ok: true, created: false, quote: updated[0] });
}

async function advanceQuote(b) {
  if (!b.quote_id) return reply(400, { ok: false, error: 'quote_id is required' });
  if (!STATUSES.includes(b.status))
    return reply(400, { ok: false, error: `status must be one of ${STATUSES.join(', ')}` });

  const existing = await sb(`quotes?quote_id=eq.${encodeURIComponent(b.quote_id)}&select=id,status`);
  if (!existing.length) return reply(404, { ok: false, error: 'Quote not found' });

  // Sending the email advances a draft, but must not pull back a quote that
  // is already won, lost or in negotiation.
  if (RANK[existing[0].status] >= RANK[b.status] && b.status !== 'lost')
    return reply(200, { ok: true, unchanged: true, status: existing[0].status });

  const rows = await sb(`quotes?quote_id=eq.${encodeURIComponent(b.quote_id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: b.status, updated_at: new Date().toISOString() })
  });
  return reply(200, { ok: true, quote: rows[0] });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!tokenOk(event)) {
    return { statusCode: 401, headers: CORS,
      body: JSON.stringify({ ok: false, error: 'Unauthorized', need_token: true }) };
  }
  if (!SUPA_URL || !SUPA_KEY)
    return reply(500, { ok: false, error: 'SUPABASE_URL / SUPABASE_SERVICE_KEY are not configured' });

  try {
    const b = JSON.parse(event.body || '{}');
    if (event.httpMethod === 'POST') return await upsertQuote(b);
    if (event.httpMethod === 'PATCH') return await advanceQuote(b);
    return reply(405, { ok: false, error: 'Method not allowed' });
  } catch (err) {
    console.error('[quote-save]', err);
    return reply(500, { ok: false, error: String(err.message || err) });
  }
};
