// netlify/functions/frm-lookup.js
// Read-only endpoint for FR Mobile — Lookup module (v3).
//
//   GET /frm-lookup?tracking=<scanned or typed code>      (alias: ?q=)
//
// Answers "what is this?" for one code, in one call. The code can be a
// carrier tracking OR an order number (WS4B235650, 111-4070015-1449810, 1099):
//   shipment  — its row in shipments_general (the receiving/outbound log)
//   dropship  — the DropShipments orders that ride under that tracking
//               (inbound tracking_number OR outbound_tracking) or that carry
//               that order_id, with status
//   pallet    — the returns pallet it was scanned into, if any
//   slip      — the Amazon packing slip read off its photo, if any
//   orders    — v3: fulfillment orders. Looked up three ways:
//               a) client_orders.order_number (exact; rows saved as
//                  "WS4B245363 Name" also match on the first token)
//               b) ShipStation /orders?orderNumber= when the order never went
//                  through Client Orders (Shopify stores that feed ShipStation
//                  directly), so those are found too
//               c) ShipStation /shipments?trackingNumber= when the code is an
//                  outbound label: client_orders has no tracking column, the
//                  tracking of a fulfillment order lives only in ShipStation
//               Every order comes back with its ShipStation shipments
//               (tracking, carrier, ship date).
// Reads with the service key (RLS stays closed) and never exposes billing
// columns or label cost. Same fetch pattern and CORS as frm-receive.js.
//
// ShipStation is called at most 3 times per lookup and only when it can add
// something: (b) only if client_orders had no hit, (c) only if the tracking
// is not a known inbound. If SS is slow, rate-limited or not configured the
// rest of the answer still comes back and the reason goes in `errors`.
//
// Why this is not just shipments-proxy?tracking=eq.<x>:
// the handheld stores the raw GS1 barcode for USPS labels
// ("(420)33172(92)0019…", sometimes with GS 0x1D separators), while the desktop
// stores the clean 22 digits when someone types it. An exact match fails
// across those two, so this endpoint matches in three passes:
//   1. exact  — the code as scanned
//   2. normalized — the tracking with routing prefix / separators stripped
//   3. suffix — ilike on the last digits, then re-normalize every candidate
//               and keep the ones whose normalized form equals the scan
// The response says which pass matched so the operator can see when the
// stored tracking differs from the label in hand.

const ALLOWED_ORIGINS = [
  'https://apps.fr-logistics.net',
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
];

// Never billed_at / billing_id: the floor does not need them and the
// operator must not see them on a handheld.
const COLUMNS = [
  'id', 'tracking', 'direction', 'carrier', 'type', 'client', 'client_id',
  'notes', 'received_at', 'created_at', 'photo_urls',
].join(',');

// Same normalization as portal-inbound.js (kept in sync by hand on purpose:
// this function has no build step and no shared module).
function normalizeTracking(raw) {
  const original = String(raw || '');
  const t = original.replace(/[\s()\u001d\u001e-]/g, '');
  if (!t) return { tracking: '', carrier: '', warning: '' };

  const routed = t.match(/^420\d{5}(9[2-5]\d{20})$/);
  if (routed) return { tracking: routed[1], carrier: 'USPS', warning: '' };
  if (/^9[2-5]\d{20}$/.test(t)) return { tracking: t, carrier: 'USPS', warning: '' };
  if (/^1Z[0-9A-Z]{16}$/i.test(t)) return { tracking: t.toUpperCase(), carrier: 'UPS', warning: '' };
  if (/^TBA\d+$/i.test(t)) return { tracking: t.toUpperCase(), carrier: 'Amazon', warning: '' };
  if (/^96\d{32}$/.test(t)) {
    return { tracking: t.slice(-12), carrier: 'FedEx', warning: 'Captured from a 34-digit barcode; last 12 digits used.' };
  }
  return { tracking: t, carrier: '', warning: 'Non-standard barcode format.' };
}

function trackingUrl(tracking, carrier) {
  if (!tracking) return '';
  const c = (carrier || '').toUpperCase();
  if (c === 'UPS') return 'https://www.ups.com/track?tracknum=' + encodeURIComponent(tracking);
  if (c === 'USPS') return 'https://tools.usps.com/go/TrackConfirmAction?tLabels=' + encodeURIComponent(tracking);
  if (c === 'AMAZON') return 'https://track.amazon.com/tracking/' + encodeURIComponent(tracking);
  if (c === 'FEDEX') return 'https://www.fedex.com/fedextrack/?trknbr=' + encodeURIComponent(tracking);
  return '';
}

// "Scanned via FR Mobile — Joe Raymond" -> operator "Joe Raymond", and the
// rest of the note (whatever the warehouse actually typed) kept apart.
function splitNotes(notes) {
  const s = String(notes || '');
  const m = s.match(/Scanned via FR Mobile(?:\s*[—-]\s*([^\n;|]+))?/);
  const operator = m && m[1] ? m[1].trim() : '';
  const rest = s.replace(/Scanned via FR Mobile(?:\s*[—-]\s*[^\n;|]+)?/, '')
    .replace(/^[\s;|,\-—]+|[\s;|,\-—]+$/g, '')
    .trim();
  return { operator, note: rest };
}

function shape(row, scannedNorm) {
  const stored = normalizeTracking(row.tracking);
  const { operator, note } = splitNotes(row.notes);
  const carrier = row.carrier && row.carrier !== 'Other' ? row.carrier : stored.carrier;
  return {
    id: row.id,
    tracking: row.tracking,
    tracking_clean: stored.tracking,
    tracking_url: trackingUrl(stored.tracking, carrier),
    direction: row.direction,
    carrier: row.carrier,
    type: row.type,
    client: row.client,
    client_id: row.client_id,
    operator,
    note,
    received_at: row.received_at || row.created_at,
    photo_urls: Array.isArray(row.photo_urls) ? row.photo_urls : [],
    // true when the label in hand and the stored value differ in text but
    // are the same tracking once normalized
    stored_differs: !!scannedNorm && stored.tracking === scannedNorm && row.tracking !== scannedNorm,
  };
}


// ---- v2 side tables ---------------------------------------------------------
// Every one of these is looked up the same way: exact on the scan, exact on
// the normalized code, then a suffix ilike whose hits are re-normalized and
// kept only when they equal the scan. pallet_packages in particular stores
// the raw GS1 string, so a clean USPS number only matches via the suffix.

function sameTracking(stored, norm, scanned) {
  if (!stored) return false;
  if (stored === scanned) return true;
  return !!norm && normalizeTracking(stored).tracking === norm;
}

function shapeDropship(r) {
  return {
    id: r.id,
    order_id: r.order_id,
    status: r.status,
    group_seq: r.group_seq,
    group_total: r.group_total,
    content: r.content,
    qty_boxes: r.qty_boxes,
    carrier: r.carrier,
    tracking_number: r.tracking_number,
    outbound_carrier: r.outbound_carrier,
    outbound_platform: r.outbound_platform,
    outbound_tracking: r.outbound_tracking,
    has_label: !!r.label_url,
    pack_suggested: r.pack_suggested || null,
    pack_used: r.pack_used || null,
    pack_status: r.pack_status || null,
    cancel_reason: r.cancel_reason || null,
    cancelled_at: r.cancelled_at || null,
    physical_received_at: r.physical_received_at,
    labeled_at: r.labeled_at,
    shipped_at: r.shipped_at,
    received_by: r.received_by,
    shipped_by: r.shipped_by,
    exception_reason: r.exception_reason,
    client_code: r.client_code,
    client_id: r.client_id,
    manifest_id: r.manifest_id,
  };
}

function shapePallet(p, pkgCount, addedAt) {
  return {
    pallet_id: p.pallet_id,
    client: p.client,
    client_code: p.client_code,
    status: p.status,
    pallet_size: p.pallet_size,
    packages: pkgCount,
    full_at: p.full_at,
    wrapped_at: p.wrapped_at,
    added_at: addedAt,
  };
}

function shapeSlip(x) {
  const items = Array.isArray(x.items) ? x.items : [];
  return {
    status: x.status,
    doc_type: x.doc_type,
    ra_number: x.ra_number,
    lpn: x.lpn,
    origin_fc: x.origin_fc,
    process_date: x.process_date,
    confidence: x.confidence,
    summary: x.summary,
    items: items.map((it) => ({
      fnsku: it.fnsku || null, lpn: it.lpn || null, upc: it.upc || null,
      qty: it.qty == null ? null : Number(it.qty),
      title: it.title ? String(it.title).slice(0, 90) : null,
    })),
    photo_url: x.photo_url,
    created_at: x.completed_at || x.created_at,
  };
}

const DS_COLS = [
  'id', 'client_id', 'client_code', 'tracking_number', 'order_id', 'carrier', 'content',
  'qty_boxes', 'label_url', 'outbound_carrier', 'outbound_platform', 'outbound_tracking',
  'status', 'physical_received_at', 'labeled_at', 'shipped_at', 'received_by', 'shipped_by',
  'exception_reason', 'group_seq', 'group_total', 'manifest_id',
  // 2026-11-18: packaging suggestion / confirmation and void (see dropshipments.js)
  'pack_suggested', 'pack_used', 'pack_status', 'cancel_reason', 'cancelled_at',
].join(',');
const SLIP_COLS = [
  'id', 'tracking', 'photo_url', 'status', 'doc_type', 'ra_number', 'lpn', 'origin_fc',
  'process_date', 'items', 'summary', 'confidence', 'created_at', 'completed_at',
].join(',');

// Builds the PostgREST filter list for one column: exact scan, exact
// normalized, and suffix. Executed as one OR so each table costs one round trip.
function orFilter(col, scanned, norm) {
  const parts = [`${col}.eq.${JSON.stringify(scanned)}`];
  if (norm && norm !== scanned) parts.push(`${col}.eq.${JSON.stringify(norm)}`);
  if (norm && norm.length >= 10) parts.push(`${col}.ilike.${JSON.stringify('*' + norm.slice(-12))}`);
  return 'or=' + encodeURIComponent('(' + parts.join(',') + ')');
}

async function fetchDropship(sb, scanned, norm) {
  // inbound side and outbound side, both matched the same way
  const q = 'or=' + encodeURIComponent('(' + [
    `tracking_number.eq.${JSON.stringify(scanned)}`,
    norm && norm !== scanned ? `tracking_number.eq.${JSON.stringify(norm)}` : null,
    norm && norm.length >= 10 ? `tracking_number.ilike.${JSON.stringify('*' + norm.slice(-12))}` : null,
    `outbound_tracking.eq.${JSON.stringify(scanned)}`,
    norm && norm !== scanned ? `outbound_tracking.eq.${JSON.stringify(norm)}` : null,
    norm && norm.length >= 10 ? `outbound_tracking.ilike.${JSON.stringify('*' + norm.slice(-12))}` : null,
  ].filter(Boolean).join(',') + ')');
  const rows = await sb('dropshipments', DS_COLS, `${q}&order=group_seq.asc.nullslast,created_at.asc&limit=20`);
  const inbound = rows.filter((r) => sameTracking(r.tracking_number, norm, scanned));
  const outbound = rows.filter((r) => !inbound.includes(r) && sameTracking(r.outbound_tracking, norm, scanned));
  // v3: the code can also be the marketplace order id of a DropShipment
  // (111-4070015-1449810, 200015313824569). Exact, case-insensitive.
  let byOrder = [];
  const token = orderToken(scanned);
  if (token) {
    const o = await sb('dropshipments', DS_COLS,
      `order_id=ilike.${encodeURIComponent(likeEscape(token))}&order=created_at.desc&limit=10`);
    byOrder = o.filter((r) => !inbound.some((x) => x.id === r.id) && !outbound.some((x) => x.id === r.id));
  }
  return {
    inbound: inbound.map(shapeDropship),
    outbound: outbound.map(shapeDropship),
    by_order: byOrder.map(shapeDropship),
  };
}

// ---- v3: fulfillment orders (client_orders + ShipStation) --------------------

// A typed/scanned code usable as an order number: trimmed, no control chars,
// 3..60 chars. Returns '' when it cannot be one (GS1 barcodes with
// parentheses/separators are trackings, never order numbers).
function orderToken(raw) {
  const t = String(raw || '').replace(/[\u0000-\u001f]/g, '').trim();
  if (t.length < 3 || t.length > 60) return '';
  if (/[()*,]/.test(t)) return '';
  return t;
}
// PostgREST ilike: * is the wildcard, and % _ \\ are LIKE specials.
function likeEscape(t) { return String(t).replace(/([\\%_])/g, '\\$1'); }

const SS_BASE = 'https://ssapi.shipstation.com';
const SS_TIMEOUT_MS = 6000;

function ssAuth() {
  const key = process.env.SS_API_KEY;
  const sec = process.env.SS_API_SECRET;
  if (!key || !sec) return null;
  return { Authorization: `Basic ${Buffer.from(`${key}:${sec}`).toString('base64')}` };
}

async function ssGet(path, auth) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SS_TIMEOUT_MS);
  try {
    const r = await fetch(`${SS_BASE}${path}`, { headers: auth, signal: ctl.signal });
    if (r.status === 404) return null;
    if (r.status === 429) throw new Error('ShipStation rate limit — try again in a minute');
    if (!r.ok) throw new Error(`ShipStation ${r.status}: ${(await r.text()).slice(0, 160)}`);
    return await r.json();
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('ShipStation did not answer in time');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function ssCarrierName(code) {
  const c = String(code || '').toLowerCase();
  if (c.includes('ups')) return 'UPS';
  if (c.includes('stamps') || c.includes('usps') || c.includes('endicia')) return 'USPS';
  if (c.includes('fedex')) return 'FedEx';
  if (c.includes('dhl')) return 'DHL';
  if (c.includes('amazon')) return 'Amazon';
  return code || '';
}

// Never shipmentCost / insuranceCost: same rule as the log columns.
function shapeSsShipment(sh) {
  const carrier = ssCarrierName(sh.carrierCode);
  return {
    tracking: sh.trackingNumber || null,
    carrier,
    service: sh.serviceCode ? String(sh.serviceCode).replace(/_/g, ' ') : null,
    ship_date: sh.shipDate || sh.createDate || null,
    voided: !!sh.voided,
    tracking_url: trackingUrl(sh.trackingNumber, carrier),
  };
}

async function ssShipmentsForOrder(orderId, auth) {
  const j = await ssGet(`/shipments?orderId=${encodeURIComponent(orderId)}&pageSize=50`, auth);
  return ((j && j.shipments) || []).map(shapeSsShipment);
}

function joinAddr(parts) { return parts.map((p) => String(p || '').trim()).filter(Boolean).join(', '); }

function shapeLocalOrder(o, clientName) {
  return {
    source: 'client_orders',
    order_number: o.order_number,
    client: clientName || null,
    client_id: o.client_id,
    client_code: o.client_code || null,
    status: o.ss_order_status || o.status,
    in_shipstation: !!o.ss_order_id,
    ss_order_id: o.ss_order_id || null,
    created_at: o.created_at,
    exported_at: o.exported_at,
    recipient: o.recipient_name,
    address: joinAddr([o.address_line1, o.address_line2, o.city, o.state, o.postal_code, o.country_code]),
    service: o.shipping_service,
    items: (o.client_order_items || []).map((i) => ({ sku: i.item_sku, name: i.item_name, qty: i.item_quantity })),
    shipments: [],
  };
}

function shapeSsOrder(o, clientName) {
  const st = o.shipTo || {};
  const adv = o.advancedOptions || {};
  return {
    source: 'shipstation',
    order_number: o.orderNumber,
    client: clientName || adv.customField1 || null,
    client_id: null,
    client_code: null,
    status: o.orderStatus,
    in_shipstation: true,
    ss_order_id: o.orderId,
    created_at: o.orderDate || o.createDate,
    exported_at: null,
    recipient: st.name || null,
    address: joinAddr([st.street1, st.street2, st.city, st.state, st.postalCode, st.country]),
    service: o.requestedShippingService || (o.serviceCode ? String(o.serviceCode).replace(/_/g, ' ') : null),
    items: (o.items || []).filter((i) => !i.adjustment).map((i) => ({ sku: i.sku, name: i.name, qty: i.quantity })),
    shipments: [],
  };
}

const ORDER_COLS = [
  'id', 'client_id', 'client_code', 'order_number', 'status', 'recipient_name',
  'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'country_code',
  'shipping_service', 'created_at', 'exported_at', 'ss_order_id', 'ss_order_status',
  'client_order_items(item_sku,item_name,item_quantity)',
].join(',');

// The first token of what is stored must equal the code: "WS4B245363 Name"
// matches WS4B245363, but WS4B24536 does not match WS4B245363.
function sameOrderNumber(stored, token) {
  const a = String(stored || '').trim().toLowerCase();
  const b = String(token || '').trim().toLowerCase();
  return a === b || a.startsWith(b + ' ');
}

async function localOrdersByNumber(sb, token) {
  const rows = await sb('client_orders', ORDER_COLS,
    `order_number=ilike.${encodeURIComponent(likeEscape(token) + '*')}&order=created_at.desc&limit=20`);
  return rows.filter((r) => sameOrderNumber(r.order_number, token)).slice(0, 5);
}

async function localOrderBySsId(sb, ssOrderId) {
  const rows = await sb('client_orders', ORDER_COLS, `ss_order_id=eq.${encodeURIComponent(ssOrderId)}&limit=1`);
  return rows[0] || null;
}

// a) + b): the code as an order number.
async function fetchOrdersByNumber(sb, scanned, looksLikeTracking, errors) {
  const token = orderToken(scanned);
  if (!token) return [];
  const auth = ssAuth();
  const local = await localOrdersByNumber(sb, token);
  const out = [];
  for (const o of local) {
    const shaped = shapeLocalOrder(o, await fetchClientName(sb, o.client_id).catch(() => null));
    if (o.ss_order_id && auth) {
      try { shaped.shipments = await ssShipmentsForOrder(o.ss_order_id, auth); }
      catch (e) { errors.push(`shipstation: ${String(e.message || e)}`); }
    }
    out.push(shaped);
  }
  if (out.length) return out;
  // A code with a carrier's shape (1Z…, TBA…, USPS 22 digits) is a package,
  // not an order number: do not spend a ShipStation call on every scan.
  if (looksLikeTracking) return out;
  if (!auth) { errors.push('shipstation: not configured (SS_API_KEY / SS_API_SECRET)'); return out; }

  // Not in Client Orders: ask ShipStation. orderNumber is a "starts with"
  // search there, so the result is filtered to the exact number.
  try {
    const j = await ssGet(`/orders?orderNumber=${encodeURIComponent(token)}&pageSize=50`, auth);
    const want = token.toLowerCase();
    const hits = ((j && j.orders) || []).filter((o) => String(o.orderNumber || '').trim().toLowerCase() === want);
    hits.sort((a, b) => (a.orderStatus === 'cancelled') - (b.orderStatus === 'cancelled'));
    for (const o of hits.slice(0, 3)) {
      const shaped = shapeSsOrder(o, null);
      if (o.orderStatus === 'shipped') {
        try { shaped.shipments = await ssShipmentsForOrder(o.orderId, auth); }
        catch (e) { errors.push(`shipstation: ${String(e.message || e)}`); }
      }
      out.push(shaped);
    }
  } catch (e) { errors.push(`shipstation: ${String(e.message || e)}`); }
  return out;
}

// c): the code as the outbound label of a fulfillment order.
async function fetchOrdersByTracking(sb, tracking, errors) {
  const auth = ssAuth();
  if (!auth || !tracking) return [];
  try {
    const j = await ssGet(`/shipments?trackingNumber=${encodeURIComponent(tracking)}&pageSize=10`, auth);
    const ships = ((j && j.shipments) || []).filter((s) => s.orderId);
    if (!ships.length) return [];
    const sh = ships.find((s) => !s.voided) || ships[0];
    // A reship is a NEW ShipStation order with the same order number
    // (WS4B235559, 18-nov-2026: original 336017228, reship 340649939), so the
    // ss_order_id match misses it. Fall back to the order number before
    // declaring the order "ShipStation only".
    let local = await localOrderBySsId(sb, sh.orderId);
    if (!local && sh.orderNumber) {
      const byNum = await localOrdersByNumber(sb, String(sh.orderNumber).trim()).catch(() => []);
      if (byNum.length) local = byNum[0];
    }
    let shaped;
    if (local) {
      shaped = shapeLocalOrder(local, await fetchClientName(sb, local.client_id).catch(() => null));
    } else {
      const o = await ssGet(`/orders/${encodeURIComponent(sh.orderId)}`, auth);
      shaped = o ? shapeSsOrder(o, null) : {
        source: 'shipstation', order_number: sh.orderNumber, client: null, client_id: null, client_code: null,
        status: 'shipped', in_shipstation: true, ss_order_id: sh.orderId, created_at: sh.createDate || null,
        exported_at: null, recipient: (sh.shipTo && sh.shipTo.name) || null, address: '', service: null, items: [], shipments: [],
      };
    }
    shaped.shipments = ships.filter((s) => s.orderId === sh.orderId).map(shapeSsShipment);
    shaped.matched_by = 'tracking';
    return [shaped];
  } catch (e) { errors.push(`shipstation: ${String(e.message || e)}`); return []; }
}

async function fetchPallet(sb, scanned, norm) {
  const links = await sb('pallet_packages', 'id,tracking,pallet_id,created_at',
    `${orFilter('tracking', scanned, norm)}&order=created_at.desc&limit=10`);
  const hit = links.find((l) => sameTracking(l.tracking, norm, scanned));
  if (!hit) return null;
  const pals = await sb('pallets', 'pallet_id,client,client_code,status,pallet_size,full_at,wrapped_at,packages',
    `pallet_id=eq.${encodeURIComponent(hit.pallet_id)}&limit=1`);
  const p = pals[0];
  if (!p) return { pallet_id: hit.pallet_id, status: null, client: null, packages: null, added_at: hit.created_at };
  // package count: count rows in pallet_packages (source of truth on the handheld)
  const cnt = await sb('pallet_packages', 'id', `pallet_id=eq.${encodeURIComponent(hit.pallet_id)}&limit=500`);
  return shapePallet(p, cnt.length, hit.created_at);
}

async function fetchSlip(sb, scanned, norm) {
  const rows = await sb('wh_slip_extractions', SLIP_COLS,
    `${orFilter('tracking', scanned, norm)}&order=created_at.desc&limit=5`);
  const hit = rows.find((x) => sameTracking(x.tracking, norm, scanned));
  return hit ? shapeSlip(hit) : null;
}

async function fetchClientName(sb, clientId) {
  if (!clientId) return null;
  const rows = await sb('fr_clients', 'id,company,name,store_name', `id=eq.${encodeURIComponent(clientId)}&limit=1`);
  const c = rows[0];
  return c ? (c.company || c.name || c.store_name || null) : null;
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase not configured' }) };

  const q = event.queryStringParameters || {};
  const scanned = String(q.tracking || q.q || '').trim();
  if (!scanned)
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'tracking or order number is required' }) };
  if (scanned.length > 120)
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'code too long' }) };

  const norm = normalizeTracking(scanned);

  const sbAny = async (table, cols, query) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${cols}&${query}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!r.ok) throw new Error(`Supabase ${table} ${r.status}: ${await r.text()}`);
    return r.json();
  };
  const sb = (query) => sbAny('shipments_general', COLUMNS, query);

  try {
    // Side tables are independent of which pass finds the log row, so they
    // run in parallel with the main chain. A failure in one of them must not
    // hide the log row: each settles to null and is reported in `errors`.
    const errors = [];
    const side = Promise.allSettled([
      fetchDropship(sbAny, scanned, norm.tracking),
      fetchPallet(sbAny, scanned, norm.tracking),
      fetchSlip(sbAny, scanned, norm.tracking),
      fetchOrdersByNumber(sbAny, scanned, !!norm.carrier, errors),
    ]);

    // Pass 1 — exact, as scanned.
    let rows = await sb(`tracking=eq.${encodeURIComponent(scanned)}&limit=2`);
    let match = 'exact';

    // Pass 2 — normalized form (covers desktop-typed clean numbers).
    if (!rows.length && norm.tracking && norm.tracking !== scanned) {
      rows = await sb(`tracking=eq.${encodeURIComponent(norm.tracking)}&limit=2`);
      match = 'normalized';
    }

    // Pass 3 — suffix search, then verify each candidate by normalization.
    // Only when the normalized code is long enough that a suffix means
    // something (10+ chars); short codes would pull in unrelated rows.
    let candidates = [];
    if (!rows.length && norm.tracking.length >= 10) {
      const suffix = norm.tracking.slice(-12);
      const pool = await sb(`tracking=ilike.${encodeURIComponent('*' + suffix)}&order=received_at.desc&limit=10`);
      const same = pool.filter((r) => normalizeTracking(r.tracking).tracking === norm.tracking);
      if (same.length) { rows = same; match = 'suffix'; }
      else if (pool.length) { candidates = pool; match = 'none'; }
      else match = 'none';
    } else if (!rows.length) {
      match = 'none';
    }

    const [dsR, palR, slipR, ordR] = await side;
    const pick = (r, name) => { if (r.status === 'fulfilled') return r.value; errors.push(`${name}: ${String(r.reason && r.reason.message || r.reason)}`); return null; };
    const dropship = pick(dsR, 'dropship') || { inbound: [], outbound: [], by_order: [] };
    const pallet = pick(palR, 'pallet');
    const slip = pick(slipR, 'slip');
    let orders = pick(ordR, 'orders') || [];

    // v3 (c): outbound label of a fulfillment order. Only asked when it can
    // add something — the code looks like a carrier tracking, no order matched
    // by number, and it is not a known inbound (an inbound never has a
    // ShipStation shipment, and Receiving-style scanning must not burn the
    // ShipStation rate limit).
    const knownInbound = (rows.length && rows[0].direction !== 'Outbound')
      || dropship.inbound.length > 0 || !!pallet || !!slip;
    if (!orders.length && norm.carrier && !knownInbound && !dropship.outbound.length) {
      orders = await fetchOrdersByTracking(sbAny, norm.tracking, errors);
    }

    // Client name for the "not in the log" case: a DropShipments row or a
    // pallet already knows the owner even when nobody scanned the package
    // into shipments_general (orphan / pre-registered inbound).
    let owner = rows.length ? rows[0].client : null;
    if (!owner) {
      const first = dropship.inbound[0] || dropship.outbound[0];
      if (first) owner = await fetchClientName(sbAny, first.client_id).catch(() => null);
      if (!owner && pallet && pallet.client) owner = pallet.client;
      if (!owner && dropship.by_order[0]) owner = await fetchClientName(sbAny, dropship.by_order[0].client_id).catch(() => null);
      if (!owner && orders[0]) owner = orders[0].client;
    }

    const body = {
      found: rows.length > 0,
      found_any: rows.length > 0 || dropship.inbound.length > 0 || dropship.outbound.length > 0
        || dropship.by_order.length > 0 || orders.length > 0 || !!pallet || !!slip,
      // true when the code resolved as an ORDER (fulfillment or DropShipment)
      // rather than as a package: the handheld shows the order card and does
      // not offer "Receive it now".
      is_order: orders.length > 0 || dropship.by_order.length > 0,
      owner,
      orders,
      dropship,
      pallet,
      slip,
      errors,
      match,
      scanned,
      tracking_clean: norm.tracking,
      carrier_guess: norm.carrier,
      tracking_url: trackingUrl(norm.tracking, norm.carrier),
      warning: norm.warning,
      shipment: rows.length ? shape(rows[0], norm.tracking) : null,
      // more than one row is unexpected (tracking is unique) but a suffix
      // match can legitimately return the same tracking under two spellings
      others: rows.slice(1).map((r) => shape(r, norm.tracking)),
      // near misses: same last digits, different tracking once normalized —
      // shown so the operator can tell "wrong label" from "not logged"
      candidates: candidates.slice(0, 5).map((r) => shape(r, '')),
    };
    return { statusCode: 200, headers, body: JSON.stringify(body) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
