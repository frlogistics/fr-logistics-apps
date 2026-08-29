// ════════════════════════════════════════════════════════════════════════════
// quote-convert.js — FR-Logistics: turn a won quote into a client
// Storage: Supabase (quotes -> fr_clients + fr_client_rates, wa_leads)
// Pattern: same as billing-rates.js / quote-save.js (CommonJS, Lambda compat)
//
// Endpoints:
//   POST { quote_id, preview:true }   -> what it WOULD create, writes nothing
//   POST { quote_id, confirm:true }   -> creates the client and its rate row
//
// Always preview before confirming. The preview is the whole point: it shows
// the operator every rate that is about to become contractual, next to the
// catalog default it replaces.
//
// RATE_COLUMN_MAP below is copied verbatim from billing-rates.js, which is the
// single source of truth in production, plus four codes that exist as columns
// but were never mapped there (see MAP_GAP_NOTE) and tec_custom, added
// 2026-08-29.
//
// Uses only SUPABASE_URL + SUPABASE_SERVICE_KEY.
// ════════════════════════════════════════════════════════════════════════════

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

const RATE_COLUMN_MAP = {
  // Inbound
  INB_CARTON: 'inbound_carton', INB_PALLET: 'inbound_pallet', INB_FLOOR: 'inbound_floor',
  INB_ECO: 'ecopack', INB_XDOCK_PKG: 'xdock_pkg', INB_XDOCK_PAL: 'xdock_pal',
  // Storage
  STO_RACK: 'storage_rack', STO_LBIN: 'storage_lbin', STO_SBIN: 'storage_sbin', STO_LT: 'storage_lt',
  // Prep
  PRP_FNSKU: 'labeling', PRP_POLY: 'poly_bag', PRP_BUBBLE: 'bubble_wrap', PRP_BOXING: 'boxing',
  PRP_KIT: 'kitting', PRP_BUNDLE: 'complex_bundle', PRP_SORT_UNIT: 'sorting',
  PRP_SORT_BOX: 'sorting_box', PRP_ROL: 'label_removal', PRP_PALLETIZE: 'palletizing',
  PRP_STRETCH: 'stretch_wrap', PRP_PALREPACK: 'pal_repack', PRP_HANGTAG: 'hang_tag',
  PRP_INSERT: 'marketing_insert', PRP_DEKIT: 'de_kitting',
  // QC
  QC_HOUR: 'qc', QC_PHOTO: 'qc_photo', QC_SAMPLE: 'sku_intake',
  // Fulfillment
  FUL_PP_SM: 'pick_pack_sm', FUL_PP_STD: 'pick_pack_st', FUL_PP_OVS: 'pick_pack_ov',
  FUL_PP_ADD: 'pick_pack_add', FUL_PP1: 'pick_pack_sm', FUL_PPN: 'pick_pack_add',
  FUL_LABEL_APP: 'shipping_label_app', FUL_CONSOL: 'order_consol',
  FUL_OUT_CART: 'outbound_carton', FUL_OUT_PAL: 'outbound_pallet',
  FUL_OUT_OVS: 'oversized_pallet', FUL_OUT_DROP: 'drop_shipment',
  FUL_PICKUP: 'carrier_pickup', FUL_RUSH: 'rush_surcharge', FUL_HEAVY: 'heavy_surcharge',
  FUL_BOX_UP: 'box_upgrade', FUL_ADDR_FIX: 'address_correction',
  FUL_LMDP: 'last_mile_prep', FUL_ODPD: 'on_demand_delivery',
  // Returns
  RET_PROC: 'return_proc', RET_REFURB: 'refurb', RET_DISPOSE: 'disposal',
  RET_REMOVAL: 'removal_order',
  // B2B
  B2B_CART: 'b2b_master_carton', B2B_PALLET: 'b2b_pallet_build', B2B_RETAIL: 'retail_dist',
  // Casillero / DropShipments
  DS_INTAKE: 'ds_intake', DS_STORAGE: 'ds_storage', DS_CONSOL: 'ds_consol', DS_PHOTO: 'ds_photo',
  DS_REPACK_XL: 'ds_repack_xl', DS_RTS: 'ds_rts', DS_DISPOSAL: 'ds_disposal',
  DS_ADDITIONAL_PKG: 'ds_additional_pkg',
  // Special & supplies
  SPC_SKU_SUR: 'sku_surcharge', SUP_CARTON: 'carton_supply', SUP_PALLET: 'pallet_supply',
  // Technology
  TEC_SETUP: 'setup_fee', TEC_INTEG: 'marketplace', TEC_WMS: 'wms',
  TEC_PORTAL_PREM: 'tec_portal_prem', TEC_AMZ_PLAN: 'amz_shipment_plan',
  TEC_CUSTOM: 'tec_custom'
};

// FUL_LMDP, FUL_ODPD, SUP_CARTON and SUP_PALLET are mapped here but NOT in
// billing-rates.js. Their columns exist and only DEFAULT holds a value today,
// so nothing is mis-billed right now — but a negotiated rate written by this
// function would be ignored by the billing resolver until that map is updated.
const MAP_GAP_NOTE = ['FUL_LMDP', 'FUL_ODPD', 'SUP_CARTON', 'SUP_PALLET'];

// fr_clients.services is free text. These are the labels already in use.
const CATEGORY_TO_SERVICE = {
  Inbound: 'Storage', Storage: 'Storage', Prep: 'FBA Prep',
  Fulfillment: 'FBM / DTC Fulfillment', Returns: 'Returns / Reverse Logistics',
  Casillero: 'Dropship', B2B: 'B2B / Wholesale', QC: 'FBA Prep',
  Supplies: null, Special: null, Technology: null
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Content-Type': 'application/json'
};
const reply = (c, b) => ({ statusCode: c, headers: CORS, body: JSON.stringify(b) });

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
      ...(opts.headers || {})
    }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : [];
}

const enc = encodeURIComponent;
const num = v => (v === null || v === undefined || v === '' ? null : Number(v));

// Quote ids are built as <CLIENT_CODE>-<YYMMDD>, so the code is the prefix.
function clientCodeFrom(quoteId, clientName) {
  const m = String(quoteId || '').match(/^(.+)-\d{6}$/);
  if (m) return m[1].toUpperCase();
  return String(clientName || 'CLIENT').replace(/\s+/g, '_').toUpperCase().slice(0, 8);
}

async function build(quoteId) {
  const quotes = await sb(`quotes?quote_id=eq.${enc(quoteId)}&select=*`);
  if (!quotes.length) return { error: 'Quote not found', code: 404 };
  const q = quotes[0];

  const code = clientCodeFrom(q.quote_id, q.client_name);
  const lines = Array.isArray(q.services) ? q.services : [];

  // Rates: last line wins if a code somehow repeats, and a line with no rate
  // is skipped rather than written as zero.
  const rates = {};
  const mapped = [], unmapped = [];
  for (const l of lines) {
    const col = RATE_COLUMN_MAP[l.code];
    const rate = num(l.rate);
    if (!col) { if (l.code) unmapped.push({ code: l.code, service: l.service, rate }); continue; }
    if (rate === null) continue;
    rates[col] = rate;
    mapped.push({ code: l.code, column: col, service: l.service, rate,
                  billing_gap: MAP_GAP_NOTE.includes(l.code) });
  }

  const services = [...new Set(lines
    .map(l => CATEGORY_TO_SERVICE[l.category])
    .filter(Boolean))];

  const client = {
    name: q.contact_name || q.client_name,
    company: q.client_name,
    email: q.contact_email || '',
    phone: '',
    country: 'US',
    lang: 'EN',
    type: 'Business',
    status: 'Onboarding',
    active: true,
    services: services.length ? services : null,
    mmb: num(q.min_billing) || 0,
    billing_cadence: 'monthly',
    shipping_markup: 10,
    ss_custom_field_1: code,
    billing_source: 'ss_cf1',
    notes: `Created from quote ${q.quote_id} on ${new Date().toISOString().slice(0, 10)}. `
         + `Client code ${code}.` + (q.notes ? ` Quote notes: ${q.notes}` : '')
  };

  // Duplicate check across every identifier the ecosystem matches on.
  const orParts = [`company.eq.${enc(q.client_name)}`, `ss_custom_field_1.eq.${enc(code)}`];
  if (q.contact_email) orParts.push(`email.eq.${enc(q.contact_email)}`);
  const dupes = await sb(`fr_clients?or=(${orParts.join(',')})&select=id,name,company,email,status,ss_custom_field_1`);
  const rateDupes = await sb(`fr_client_rates?client_name=eq.${enc(q.client_name)}&select=id,client_name`);

  return {
    quote: q, code, client,
    // fr_client_rates is matched by name string, and company is the canonical
    // identifier across every FR app.
    rate_row: { client_name: q.client_name, ...rates },
    mapped, unmapped, services,
    existing_clients: dupes,
    existing_rate_rows: rateDupes,
    source_lead_id: q.source_lead_id || null
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  if (!SUPA_URL || !SUPA_KEY)
    return reply(500, { ok: false, error: 'SUPABASE_URL / SUPABASE_SERVICE_KEY are not configured' });

  try {
    const b = JSON.parse(event.body || '{}');
    if (!b.quote_id) return reply(400, { ok: false, error: 'quote_id is required' });

    const p = await build(b.quote_id);
    if (p.error) return reply(p.code || 400, { ok: false, error: p.error });

    const warnings = [];
    if (p.quote.status !== 'won')
      warnings.push(`This quote is "${p.quote.status}", not won. Mark it won before converting.`);
    if (!p.quote.contact_email) warnings.push('The quote has no contact email — the portal user cannot be provisioned later without one.');
    if (!p.mapped.length) warnings.push('No quoted line maps to a rate column, so the client would be created with no negotiated rates.');
    if (p.unmapped.length) warnings.push(`${p.unmapped.length} quoted line(s) have no rate column and will not be saved: ${p.unmapped.map(u => u.code).join(', ')}.`);
    if (p.mapped.some(m => m.billing_gap)) warnings.push('Some rates use codes the billing resolver does not map yet (FUL_LMDP, FUL_ODPD, SUP_CARTON, SUP_PALLET) — they will be stored but ignored at billing time until billing-rates.js is updated.');
    if (p.existing_clients.length) warnings.push(`${p.existing_clients.length} client record(s) already match this company, code or email.`);
    if (p.existing_rate_rows.length) warnings.push('A rate row already exists for this client name and would be overwritten.');

    // ── Preview: writes nothing ──────────────────────────────────────────────
    if (!b.confirm) {
      return reply(200, {
        ok: true, preview: true,
        quote_id: p.quote.quote_id, quote_status: p.quote.status,
        client_code: p.code, client: p.client, rates: p.mapped,
        unmapped: p.unmapped, services: p.services,
        existing_clients: p.existing_clients,
        source_lead_id: p.source_lead_id,
        blocking: p.quote.status !== 'won' || (p.existing_clients.length > 0 && !b.allow_duplicate),
        warnings
      });
    }

    // ── Confirm: guards, then write ──────────────────────────────────────────
    if (p.quote.status !== 'won')
      return reply(409, { ok: false, error: `Quote is "${p.quote.status}". Mark it won first.`, warnings });
    if (p.existing_clients.length && !b.allow_duplicate)
      return reply(409, { ok: false, error: 'A client already matches this company, code or email.',
                          existing_clients: p.existing_clients, warnings,
                          hint: 'Send allow_duplicate:true only if you are sure this is a different account.' });

    const created = await sb('fr_clients', { method: 'POST', body: JSON.stringify(p.client) });

    let rateRow = null;
    if (p.mapped.length) {
      rateRow = p.existing_rate_rows.length
        ? (await sb(`fr_client_rates?client_name=eq.${enc(p.quote.client_name)}`,
            { method: 'PATCH', body: JSON.stringify({ ...p.rate_row, updated_at: new Date().toISOString() }) }))[0]
        : (await sb('fr_client_rates',
            { method: 'POST', body: JSON.stringify({ ...p.rate_row, updated_at: new Date().toISOString() }) }))[0];
    }

    // The originating lead follows the quote.
    let leadUpdated = false;
    if (p.source_lead_id) {
      try {
        await sb(`wa_leads?id=eq.${enc(p.source_lead_id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'won',
            next_action: `Converted to client ${p.code} from quote ${p.quote.quote_id}`,
            next_action_date: null, updated_at: new Date().toISOString() })
        });
        leadUpdated = true;
      } catch (e) { console.warn('[quote-convert] lead update failed', e); }
    }

    return reply(200, {
      ok: true, created: true,
      client: created[0], client_code: p.code,
      rate_row: rateRow, rates_written: p.mapped.length,
      unmapped: p.unmapped, lead_updated: leadUpdated, warnings
    });
  } catch (err) {
    console.error('[quote-convert]', err);
    return reply(500, { ok: false, error: String(err.message || err) });
  }
};
