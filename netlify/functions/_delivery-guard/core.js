// netlify/functions/_delivery-guard/core.js
// ─────────────────────────────────────────────────────────────────────────────
// FR-Logistics — DELIVERY GUARD (23-nov-2026)
//
// Shared engine (NOT a function: files inside a "_folder" are only bundled
// into the functions that require them, same pattern as _agent-helpers/).
//
// WHY IT EXISTS: two 4BLANC/MXS orders in Nov-2026 (WS4B235559 returned for a
// "missing apartment number" on a house; WS4B235537 sitting 17 days in a UPS
// Access Point) were discovered by the CLIENT, days later, and handled in long
// email threads. The guard moves that to the system:
//
//   1. PRE-SHIP  — when an order of a guarded client lands in ShipStation and
//      ShipStation's own address validation returns a warning/failure, the
//      order is put ON HOLD in ShipStation and an exception of kind
//      'address_pre_ship' is opened. The client confirms ("the address is
//      right, it is a house") or corrects it from the portal; both release the
//      hold automatically.
//   2. POST-SHIP — every shipped label of a guarded client is tracked through
//      ShipStation API V2 /tracking. Returns to sender, address problems,
//      Access Point deliveries and failed attempts open an exception, the
//      client is emailed, and decides in the portal (reship / return to stock
//      / reroute) approving the carrier cost.
//   3. DEFAULT ACTION — no decision within 2 business days: post-ship cases
//      are decided as 'default_return' (let it come back, restock); pre-ship
//      cases get one reminder and the staff is told to call.
//
// Which clients: fr_clients.delivery_guard = true (capabilities rule: client
// behaviour lives in fr_clients, never hard-coded in an app).
//
// Environment: SUPABASE_URL, SUPABASE_SERVICE_KEY, SS_API_KEY, SS_API_SECRET,
// SS_V2_API_KEY, RESEND_API_KEY — all already exist. Adds NONE (4 KB limit).
// ─────────────────────────────────────────────────────────────────────────────

const SS_V1 = 'https://ssapi.shipstation.com';
const SS_V2 = 'https://api.shipstation.com/v2';
const PORTAL_URL = 'https://fr-logistics.net/app/';
const STAFF_EMAILS = ['warehouse@fr-logistics.net', 'josefuentes@fr-logistics.net'];
const MAIL_FROM = 'FR-Logistics <alerts@fr-logistics.net>';
const MAIL_FROM_FALLBACK = 'onboarding@resend.dev';

const DECISION_DAYS = 2;            // business days the client has to decide
const HOLD_DAYS = 7;                // ShipStation hold for a flagged address
const TRACK_LOOKBACK_DAYS = 21;     // shipments followed after ship date
const ORDER_LOOKBACK_DAYS = 45;     // client_orders considered "recent"
const RECHECK_HOURS = 2;            // minimum gap between two tracking polls
const STALE_EVENT_HOURS = 72;       // older carrier events open the case without emailing
const OPEN_STATES = ['awaiting_client', 'decided', 'in_progress'];

const PRE_SHIP_DECISIONS = ['confirm_address', 'correct_address'];
const POST_SHIP_DECISIONS = ['reship', 'return_to_stock', 'reroute'];

// ─── small utils ─────────────────────────────────────────────────────────────
const env = (k) => process.env[k];
const enc = encodeURIComponent;
const isoDaysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();
const ymd = (d) => d.toISOString().slice(0, 10);
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Adds n business days (Mon–Fri) to a date. Weekends do not count; US
// holidays are not modelled (the staff can extend due_at by hand).
function addBusinessDays(from, n) {
  const d = new Date(from.getTime());
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d;
}

// Address Line 2 placeholders that carriers read as a real (wrong) unit.
const LINE2_PLACEHOLDER_RE = /^\s*(n\/?a|none|null|house|home|no|nil|-+|\.+|0|#)\s*$/i;
function cleanLine2(v) {
  if (v === undefined || v === null) return v;
  const s = String(v).trim();
  return LINE2_PLACEHOLDER_RE.test(s) ? '' : s;
}

function cleanEmail(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return EMAIL_RE.test(s) ? s : '';
}

// ─── Supabase ────────────────────────────────────────────────────────────────
async function sb(path, opts = {}) {
  const r = await fetch(`${env('SUPABASE_URL')}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: env('SUPABASE_SERVICE_KEY'),
      Authorization: `Bearer ${env('SUPABASE_SERVICE_KEY')}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${opts.method || 'GET'} ${path.split('?')[0]} ${r.status}: ${text.slice(0, 240)}`);
  return text ? JSON.parse(text) : null;
}
const sbPatch = (path, data) => sb(path, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(data) });
const sbInsert = (table, row) => sb(table, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });

// ─── ShipStation V1 (orders, shipments, holds) ──────────────────────────────
function ssV1Auth() {
  const k = env('SS_API_KEY'); const s = env('SS_API_SECRET');
  if (!k || !s) throw new Error('SS_API_KEY / SS_API_SECRET missing');
  return { Authorization: `Basic ${Buffer.from(`${k}:${s}`).toString('base64')}` };
}
async function ssV1(path, { method = 'GET', body } = {}) {
  const r = await fetch(`${SS_V1}${path}`, {
    method,
    headers: { ...ssV1Auth(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 429) { const e = new Error('ShipStation rate limit'); e.rateLimited = true; throw e; }
  const text = await r.text();
  if (!r.ok) throw new Error(`ShipStation ${method} ${path.split('?')[0]} ${r.status}: ${text.slice(0, 240)}`);
  return text ? JSON.parse(text) : null;
}
const ssGetOrder = (orderId) => ssV1(`/orders/${enc(orderId)}`);
function ssHold(orderId, days = HOLD_DAYS) {
  const until = new Date(Date.now() + days * 86400000);
  return ssV1('/orders/holduntil', { method: 'POST', body: { orderId: Number(orderId), holdUntilDate: ymd(until) } });
}
const ssRestore = (orderId) => ssV1('/orders/restorefromhold', { method: 'POST', body: { orderId: Number(orderId) } });

// Replace the ship-to of an OPEN ShipStation order. V1 createorder updates
// the order identified by orderKey and needs the whole object, so the order is
// read first and posted back with only shipTo changed.
async function ssUpdateShipTo(orderId, addr) {
  const o = await ssGetOrder(orderId);
  if (!o) throw new Error(`ShipStation order ${orderId} not found`);
  if (!['awaiting_shipment', 'on_hold', 'awaiting_payment'].includes(o.orderStatus)) {
    throw new Error(`ShipStation order is ${o.orderStatus}; only open orders can be corrected`);
  }
  const st = { ...(o.shipTo || {}) };
  for (const [k, v] of Object.entries(addr)) if (v !== undefined) st[k] = v;
  const body = { ...o, shipTo: st };
  return ssV1('/orders/createorder', { method: 'POST', body });
}

// 'warning' | 'failed' | 'ok' | 'pending' from ShipStation's shipTo.addressVerified
function addressVerdict(shipTo) {
  const v = String((shipTo && shipTo.addressVerified) || '').toLowerCase();
  if (!v) return 'pending';
  if (v.includes('warning')) return 'warning';
  if (v.includes('fail') || v.includes('invalid')) return 'failed';
  if (v.includes('not yet')) return 'pending';
  if (v.includes('valid')) return 'ok';
  return 'pending';
}

function shipToSnapshot(st) {
  st = st || {};
  return {
    name: st.name || null, company: st.company || null, street1: st.street1 || null,
    street2: st.street2 || null, city: st.city || null, state: st.state || null,
    postalCode: st.postalCode || null, country: st.country || null, phone: st.phone || null,
    residential: st.residential === undefined ? null : st.residential,
    addressVerified: st.addressVerified || null,
  };
}

// ─── ShipStation V2 tracking ────────────────────────────────────────────────
// V1 carrierCode → V2 carrier_code. ShipStation-funded accounts come as
// "ups_walleted" / "stamps_com"; V2 tracking wants the carrier family.
function v2CarrierCode(v1Code) {
  const c = String(v1Code || '').toLowerCase();
  if (c.includes('ups')) return 'ups';
  if (c.includes('fedex')) return 'fedex';
  if (c.includes('stamps') || c.includes('usps') || c.includes('endicia')) return 'stamps_com';
  if (c.includes('dhl')) return 'dhl_express';
  return c || null;
}
function carrierLabel(v1Code) {
  const c = String(v1Code || '').toLowerCase();
  if (c.includes('ups')) return 'UPS';
  if (c.includes('fedex')) return 'FedEx';
  if (c.includes('stamps') || c.includes('usps') || c.includes('endicia')) return 'USPS';
  if (c.includes('dhl')) return 'DHL';
  return v1Code || '';
}
function trackingUrl(carrier, tn) {
  const t = enc(tn || '');
  const c = String(carrier || '').toLowerCase();
  if (c.includes('ups')) return `https://www.ups.com/track?tracknum=${t}`;
  if (c.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${t}`;
  if (c.includes('usps') || c.includes('stamps')) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}`;
  return '';
}
async function ssTrack(carrierCode, trackingNumber) {
  const key = env('SS_V2_API_KEY');
  if (!key) throw new Error('SS_V2_API_KEY missing');
  const url = `${SS_V2}/tracking?carrier_code=${enc(carrierCode)}&tracking_number=${enc(trackingNumber)}`;
  const r = await fetch(url, { headers: { 'API-Key': key } });
  if (r.status === 429) { const e = new Error('ShipStation V2 rate limit'); e.rateLimited = true; throw e; }
  const text = await r.text();
  if (!r.ok) throw new Error(`V2 tracking ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

// Decides whether a tracking state is a case for the client. Returns the
// exception kind or null. Order matters: the most specific reading wins.
function classifyTracking(t) {
  const code = String(t.status_code || '').toUpperCase();
  const text = [t.status_description, t.carrier_status_description, t.exception_description]
    .concat((t.events || []).slice(0, 3).map((e) => e && e.description))
    .filter(Boolean).join(' | ').toLowerCase();

  if (/return(ed|ing)? to (the )?(sender|shipper)|returning to shipper|rts\b/.test(text)) return 'return_to_sender';
  if (/apartment|suite|unit number|address (is )?(incorrect|incomplete|insufficient|invalid)|bad address|address correction|incorrect address/.test(text)) return 'address';
  if (/access point|awaiting customer pick ?up|held for (customer )?pick ?up|ready for (customer )?pick ?up/.test(text)) {
    // "picked up by customer" at an Access Point is a delivery, not a case
    if (/picked up by (the )?customer|customer picked up/.test(text)) return null;
    return 'access_point';
  }
  if (code === 'DE') return null;
  if (code === 'AT' || /unable to deliver|delivery attempt|attempted delivery|no one (was )?available|not available to sign|signature (is )?required/.test(text)) return 'attempt';
  if (code === 'EX') return 'exception';
  return null;
}

// Plain-English line for each kind, shown to the client.
const KIND_TEXT = {
  address_pre_ship: {
    en: 'The carrier\'s address validation flagged this address before shipping. The order is on hold until you confirm or correct it.',
    es: 'La validación de direcciones del carrier marcó esta dirección antes del despacho. La orden queda retenida hasta que la confirmes o la corrijas.',
  },
  address: {
    en: 'The carrier reports an address problem (for example a missing or invalid apartment number).',
    es: 'El carrier reporta un problema con la dirección (por ejemplo, número de apartamento faltante o inválido).',
  },
  access_point: {
    en: 'The package could not be delivered to the door and is being held at a UPS Access Point. Only the person named on the label can pick it up, with a photo ID.',
    es: 'El paquete no se pudo entregar en la puerta y está retenido en un UPS Access Point. Solo la persona del label puede retirarlo, con ID con foto.',
  },
  attempt: {
    en: 'The carrier attempted delivery and could not complete it (often: signature required and nobody available).',
    es: 'El carrier intentó la entrega y no pudo completarla (frecuentemente: firma requerida y nadie disponible).',
  },
  return_to_sender: {
    en: 'The carrier is returning the package to our warehouse.',
    es: 'El carrier está devolviendo el paquete a nuestro almacén.',
  },
  exception: {
    en: 'The carrier reports a delivery exception on this package.',
    es: 'El carrier reporta una excepción de entrega en este paquete.',
  },
};

const DECISION_TEXT = {
  confirm_address: 'Address confirmed as correct — order released',
  correct_address: 'Address corrected — order released',
  reship: 'Reship a new unit now',
  return_to_stock: 'Let it return and put it back in stock',
  reroute: 'Send to a new address',
  default_return: 'No decision received in time — default: return to stock',
};

// ─── clients ─────────────────────────────────────────────────────────────────
async function guardedClients() {
  return (await sb('fr_clients?delivery_guard=eq.true&select=id,name,company,email,ship_notify_emails,email_notifications,lang')) || [];
}
const clientLabel = (c) => (c && ((c.company && c.company.trim()) || c.name)) || '';

function clientRecipients(c) {
  const list = [c.email].concat(Array.isArray(c.ship_notify_emails) ? c.ship_notify_emails : []);
  const out = [];
  for (const e of list) { const v = cleanEmail(e); if (v && !out.includes(v)) out.push(v); }
  return out;
}

// ─── email ───────────────────────────────────────────────────────────────────
async function sendEmail({ to, cc, subject, html, from = MAIL_FROM }) {
  const key = env('RESEND_API_KEY');
  if (!key) throw new Error('RESEND_API_KEY missing');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, cc: cc && cc.length ? cc : undefined, subject, html }),
  });
  if (!r.ok) {
    const t = await r.text();
    if (from !== MAIL_FROM_FALLBACK) return sendEmail({ to, cc, subject, html, from: MAIL_FROM_FALLBACK });
    throw new Error(`Resend ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

function mailShell(title, inner) {
  return `<!DOCTYPE html><html><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0F172A">
<table width="620" align="center" cellpadding="0" cellspacing="0" style="width:620px;max-width:620px;background:#fff;margin:20px auto;border-collapse:collapse">
<tr><td style="background:#065F46;padding:18px 24px;color:#fff;font-weight:800;font-size:20px;letter-spacing:1px">FR-LOGISTICS
<span style="float:right;font-weight:400;font-size:11px;letter-spacing:0;margin-top:6px">Delivery Guard</span></td></tr>
<tr><td style="padding:22px 24px 6px 24px;font-size:16px;font-weight:700;color:#065F46">${esc(title)}</td></tr>
<tr><td style="padding:6px 24px 22px 24px;font-size:14px;line-height:21px">${inner}</td></tr>
<tr><td style="background:#f1f5f9;padding:12px 24px;font-size:11px;color:#94a3b8">FR Logistics Miami Inc, d/b/a FR-Logistics · 10893 NW 17th Street, Unit 121, Miami, FL 33172 · Automatic message from the FR-Logistics Delivery Guard.</td></tr>
</table></body></html>`;
}

function excRows(e) {
  const rows = [
    ['Order', e.order_number],
    e.tracking_number ? ['Tracking', `${esc(e.carrier || '')} ${esc(e.tracking_number)}`] : null,
    e.carrier_status ? ['Carrier status', esc(e.carrier_status)] : null,
    e.carrier_detail ? ['Detail', esc(e.carrier_detail)] : null,
  ].filter(Boolean);
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;margin:10px 0">${rows.map(([k, v], i) =>
    `<tr style="background:${i % 2 ? '#f8fafc' : '#fff'}"><td style="padding:7px 10px;border-bottom:1px solid #e2e8f0;width:130px;color:#475569">${esc(k)}</td><td style="padding:7px 10px;border-bottom:1px solid #e2e8f0">${typeof v === 'string' && v.startsWith('<') ? v : v}</td></tr>`).join('')}</table>`;
}

async function notifyClientNew(client, e) {
  const to = clientRecipients(client);
  if (!to.length || client.email_notifications === false) return false;
  const es = String(client.lang || '').toUpperCase() === 'ES';
  const due = e.due_at ? new Date(e.due_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' }) : '';
  const what = (KIND_TEXT[e.kind] || KIND_TEXT.exception)[es ? 'es' : 'en'];
  const title = es ? `Acción requerida · Orden ${e.order_number}` : `Action needed · Order ${e.order_number}`;
  const inner = es
    ? `<p>${esc(what)}</p>${excRows(e)}<p>Entra al <a href="${PORTAL_URL}" style="color:#065F46;font-weight:700">Client Portal</a> → pestaña <b>Exceptions</b> y elige qué hacer${due ? ` antes del <b>${esc(due)}</b>` : ''}.</p>
       <p style="color:#92400e;background:#fffbeb;border:1px solid #fde68a;padding:10px 12px;border-radius:6px">${e.kind === 'address_pre_ship'
         ? 'La orden no se despacha hasta que confirmes o corrijas la dirección.'
         : 'Si no recibimos tu decisión a tiempo, el paquete se deja regresar y vuelve a tu inventario. Los cargos del carrier se facturan al costo + el % acordado.'}</p>`
    : `<p>${esc(what)}</p>${excRows(e)}<p>Please open the <a href="${PORTAL_URL}" style="color:#065F46;font-weight:700">Client Portal</a> → <b>Exceptions</b> tab and choose what to do${due ? ` by <b>${esc(due)}</b>` : ''}.</p>
       <p style="color:#92400e;background:#fffbeb;border:1px solid #fde68a;padding:10px 12px;border-radius:6px">${e.kind === 'address_pre_ship'
         ? 'The order will not ship until the address is confirmed or corrected.'
         : 'If we do not receive a decision in time, the package is left to return and goes back to your inventory. Carrier charges are billed at carrier cost plus the agreed %.'}</p>`;
  await sendEmail({ to, cc: STAFF_EMAILS, subject: `${title} — ${e.kind === 'address_pre_ship' ? 'address check' : 'delivery exception'}`, html: mailShell(title, inner) });
  return true;
}

async function notifyStaff(subject, inner) {
  try { await sendEmail({ to: STAFF_EMAILS, subject, html: mailShell(subject, inner) }); } catch (e) { console.warn('[delivery-guard] staff email failed:', e.message); }
}

// ─── exceptions ──────────────────────────────────────────────────────────────
async function findOpenException(key) {
  const rows = await sb(`shipment_exceptions?dedupe_key=eq.${enc(key)}&state=in.(${OPEN_STATES.join(',')})&select=*&limit=1`);
  return rows && rows[0];
}

// Opens (or returns the existing open) exception. Never two open cases for the
// same key: the partial unique index enforces it; a 409 means a parallel run
// won the race and the existing row is returned.
async function openException(row, client, { notify = true } = {}) {
  const existing = await findOpenException(row.dedupe_key);
  if (existing) return { exc: existing, created: false };
  const now = new Date();
  const toInsert = {
    ...row,
    state: 'awaiting_client',
    detected_at: now.toISOString(),
    due_at: addBusinessDays(now, DECISION_DAYS).toISOString(),
    updated_at: now.toISOString(),
  };
  let exc;
  try {
    exc = (await sbInsert('shipment_exceptions', toInsert))[0];
  } catch (e) {
    if (/23505|duplicate/i.test(e.message)) return { exc: await findOpenException(row.dedupe_key), created: false };
    throw e;
  }
  if (notify && client) {
    try {
      if (await notifyClientNew(client, exc)) {
        exc = (await sbPatch(`shipment_exceptions?id=eq.${exc.id}`, { notified_at: new Date().toISOString() }))[0];
      }
    } catch (e) { console.warn('[delivery-guard] client email failed:', e.message); }
  }
  return { exc, created: true };
}

// ─── PRE-SHIP: address check of one ShipStation order ───────────────────────
// ssOrder = ShipStation V1 order object; local = client_orders row (id,
// order_number, client_id, address_check); client = fr_clients row.
// Returns 'held' | 'ok' | 'pending' | 'skipped'.
async function evaluateAddress(ssOrder, local, client) {
  if (!ssOrder || !local || !client) return 'skipped';
  if (local.address_check && local.address_check !== 'warning') return 'skipped'; // already decided
  const verdict = addressVerdict(ssOrder.shipTo);
  const nowIso = new Date().toISOString();
  if (verdict === 'pending') return 'pending';
  if (verdict === 'ok') {
    if (!local.address_check) await sbPatch(`client_orders?id=eq.${local.id}`, { address_check: 'ok', address_checked_at: nowIso });
    return 'ok';
  }
  // warning / failed
  const open = ['awaiting_shipment', 'awaiting_payment', 'on_hold'].includes(ssOrder.orderStatus);
  if (!open) return 'skipped'; // already shipped or cancelled: post-ship tracking takes over
  if (ssOrder.orderStatus !== 'on_hold') await ssHold(ssOrder.orderId);
  const note = ssOrder.shipTo && ssOrder.shipTo.addressVerified;
  await sbPatch(`client_orders?id=eq.${local.id}`, {
    address_check: 'warning', address_check_note: note || verdict, address_checked_at: nowIso,
    ss_order_status: 'on_hold',
  });
  await openException({
    dedupe_key: `pre:${local.id}`,
    client_id: client.id,
    client_order_id: local.id,
    order_number: local.order_number,
    ss_order_id: ssOrder.orderId,
    kind: 'address_pre_ship',
    carrier_status: 'Held before shipping',
    carrier_detail: note || 'Address validation warning',
    ship_to: shipToSnapshot(ssOrder.shipTo),
  }, client);
  return 'held';
}

// ─── decisions ───────────────────────────────────────────────────────────────
function pickAddress(data) {
  const d = data || {};
  const a = {
    name: d.name, street1: d.street1, street2: d.street2 === undefined ? undefined : cleanLine2(d.street2),
    city: d.city, state: d.state, postalCode: d.postalCode, phone: d.phone,
  };
  for (const k of Object.keys(a)) if (typeof a[k] === 'string') a[k] = a[k].trim();
  return a;
}
function validateAddress(a) {
  const missing = ['street1', 'city', 'state', 'postalCode'].filter((k) => !a[k]);
  if (missing.length) return `Missing: ${missing.join(', ')}`;
  if (!/^[A-Za-z]{2}$/.test(a.state)) return 'State must be the 2-letter code (e.g. NY)';
  if (!/^\d{5}(-\d{4})?$/.test(a.postalCode)) return 'ZIP code must be 5 digits (or ZIP+4)';
  return null;
}

// Applies a client (or staff) decision. Throws Error with .status on refusal.
async function applyDecision(exc, decision, data, actor, costApproved) {
  const fail = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };
  if (!exc) fail(404, 'Exception not found');
  if (exc.state !== 'awaiting_client') fail(409, 'This case is no longer waiting for a decision');
  const pre = exc.kind === 'address_pre_ship';
  const allowed = pre ? PRE_SHIP_DECISIONS : POST_SHIP_DECISIONS;
  if (!allowed.includes(decision)) fail(400, `Decision must be one of: ${allowed.join(', ')}`);
  const nowIso = new Date().toISOString();

  if (pre) {
    if (!exc.ss_order_id) fail(409, 'No ShipStation order linked to this case');
    let addr = null;
    if (decision === 'correct_address') {
      addr = pickAddress(data);
      const err = validateAddress(addr);
      if (err) fail(400, err);
      await ssUpdateShipTo(exc.ss_order_id, addr);
    }
    await ssRestore(exc.ss_order_id);
    if (exc.client_order_id) {
      const patch = { address_check: decision === 'confirm_address' ? 'confirmed' : 'corrected', address_confirmed_at: nowIso, address_confirmed_by: actor, ss_order_status: 'awaiting_shipment' };
      if (addr) Object.assign(patch, {
        ...(addr.name ? { recipient_name: addr.name } : {}),
        address_line1: addr.street1, address_line2: addr.street2 || null, city: addr.city,
        state: addr.state.toUpperCase(), postal_code: addr.postalCode, ...(addr.phone ? { recipient_phone: addr.phone } : {}),
      });
      await sbPatch(`client_orders?id=eq.${exc.client_order_id}`, patch);
    }
    const out = (await sbPatch(`shipment_exceptions?id=eq.${exc.id}`, {
      decision, decision_data: addr, decided_by: actor, decided_at: nowIso, cost_approved: null,
      state: 'resolved', resolved_at: nowIso, resolved_by: actor, resolution_note: DECISION_TEXT[decision], updated_at: nowIso,
    }))[0];
    return out;
  }

  // post-ship: FR executes; the client approves the carrier cost
  if (costApproved !== true) fail(400, 'Please approve the carrier charges to continue');
  let payload = null;
  if (decision === 'reroute' || decision === 'reship') {
    if (data && (data.street1 || data.city || data.postalCode)) {
      payload = pickAddress(data);
      const err = validateAddress(payload);
      if (err) fail(400, err);
    } else if (decision === 'reroute') fail(400, 'A new address is required to reroute');
  }
  if (data && data.note) payload = { ...(payload || {}), note: String(data.note).slice(0, 500) };
  const out = (await sbPatch(`shipment_exceptions?id=eq.${exc.id}`, {
    decision, decision_data: payload, cost_approved: true, decided_by: actor, decided_at: nowIso,
    state: 'decided', updated_at: nowIso,
  }))[0];
  await notifyStaff(`Delivery Guard · ${exc.order_number}: client decided "${DECISION_TEXT[decision]}"`,
    `${excRows(exc)}<p><b>Decision:</b> ${esc(DECISION_TEXT[decision])}<br><b>By:</b> ${esc(actor)}</p>${payload ? `<pre style="font-size:12px;background:#f8fafc;padding:10px">${esc(JSON.stringify(payload, null, 2))}</pre>` : ''}<p>Open <b>Delivery Exceptions</b> in apps.fr-logistics.net to carry it out and close the case.</p>`);
  return out;
}

// Fields a client may see.
function publicException(e) {
  return {
    id: e.id, order_number: e.order_number, kind: e.kind, state: e.state,
    tracking_number: e.tracking_number, carrier: e.carrier,
    tracking_url: e.tracking_number ? trackingUrl(e.carrier, e.tracking_number) : '',
    carrier_status: e.carrier_status, carrier_detail: e.carrier_detail, event_at: e.event_at,
    ship_to: e.ship_to, detected_at: e.detected_at, due_at: e.due_at,
    decision: e.decision, decision_label: e.decision ? DECISION_TEXT[e.decision] : null,
    decision_data: e.decision_data, decided_at: e.decided_at, decided_by: e.decided_by,
    resolved_at: e.resolved_at, resolution_note: e.resolution_note,
    allowed_decisions: e.state === 'awaiting_client' ? (e.kind === 'address_pre_ship' ? PRE_SHIP_DECISIONS : POST_SHIP_DECISIONS) : [],
    explanation: (KIND_TEXT[e.kind] || KIND_TEXT.exception).en,
  };
}

// ─── MONITOR ─────────────────────────────────────────────────────────────────
// One pass: (a) open orders → status + pre-ship address, (b) new shipments →
// shipment_tracking, (c) tracking polls → exceptions, (d) overdue cases.
async function runMonitor({ timeBudgetMs = 20000 } = {}) {
  const started = Date.now();
  const left = () => timeBudgetMs - (Date.now() - started);
  const report = { orders_checked: 0, held: 0, shipments_linked: 0, tracked: 0, exceptions_opened: 0, auto_resolved: 0, defaults_applied: 0, reminders: 0, errors: [] };
  const err = (where, e) => report.errors.push(`${where}: ${String((e && e.message) || e).slice(0, 200)}`);

  const clients = await guardedClients();
  if (!clients.length) return { ...report, note: 'No client has delivery_guard enabled' };
  const byId = Object.fromEntries(clients.map((c) => [c.id, c]));
  const ids = clients.map((c) => c.id).join(',');
  const since = isoDaysAgo(ORDER_LOOKBACK_DAYS);

  // (a) open orders in ShipStation
  try {
    const open = await sb(
      `client_orders?client_id=in.(${ids})&status=eq.exported&ss_order_id=not.is.null` +
      `&or=(ss_order_status.is.null,ss_order_status.in.(awaiting_shipment,on_hold,awaiting_payment))` +
      `&exported_at=gte.${enc(since)}&select=id,client_id,order_number,ss_order_id,address_check,ss_order_status` +
      `&order=ss_checked_at.asc.nullsfirst&limit=25`);
    for (const o of open || []) {
      if (left() < timeBudgetMs * 0.6) break;
      try {
        const so = await ssGetOrder(o.ss_order_id);
        report.orders_checked++;
        const patch = { ss_checked_at: new Date().toISOString() };
        if (so) {
          patch.ss_order_status = so.orderStatus;
          if (so.orderStatus === 'shipped' && so.shipDate) patch.ss_shipped_at = new Date(so.shipDate).toISOString();
          await sbPatch(`client_orders?id=eq.${o.id}`, patch);
          if (await evaluateAddress(so, o, byId[o.client_id]) === 'held') report.held++;
        } else {
          await sbPatch(`client_orders?id=eq.${o.id}`, patch);
        }
      } catch (e) { if (e.rateLimited) break; err(`order ${o.order_number}`, e); }
    }
  } catch (e) { err('open orders', e); }

  // (b) shipments of the last TRACK_LOOKBACK_DAYS → shipment_tracking
  try {
    const recent = await sb(`client_orders?client_id=in.(${ids})&exported_at=gte.${enc(since)}&select=id,client_id,order_number,ss_order_id&limit=5000`);
    const byNumber = new Map();
    for (const o of recent || []) byNumber.set(String(o.order_number || '').trim().toLowerCase(), o);
    const known = new Set(((await sb(`shipment_tracking?ship_date=gte.${ymd(new Date(Date.now() - (TRACK_LOOKBACK_DAYS + 2) * 86400000))}&select=tracking_number&limit=10000`)) || []).map((r) => r.tracking_number));
    const shipStart = ymd(new Date(Date.now() - TRACK_LOOKBACK_DAYS * 86400000));
    for (let page = 1; page <= 4 && left() > timeBudgetMs * 0.45; page++) {
      const j = await ssV1(`/shipments?shipDateStart=${shipStart}&pageSize=500&page=${page}&sortBy=ShipDate&sortDir=DESC`);
      const ships = (j && j.shipments) || [];
      for (const sh of ships) {
        if (!sh.trackingNumber) continue;
        const local = byNumber.get(String(sh.orderNumber || '').trim().toLowerCase());
        if (!local) continue;
        if (known.has(sh.trackingNumber)) {
          if (sh.voided) await sbPatch(`shipment_tracking?tracking_number=eq.${enc(sh.trackingNumber)}`, { voided: true });
          continue;
        }
        await sb('shipment_tracking', {
          method: 'POST',
          headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify({
            tracking_number: sh.trackingNumber, client_id: local.client_id, client_order_id: local.id,
            order_number: local.order_number, ss_order_id: sh.orderId, ss_shipment_id: sh.shipmentId,
            carrier_code: sh.carrierCode, service_code: sh.serviceCode,
            ship_date: sh.shipDate ? String(sh.shipDate).slice(0, 10) : null, voided: !!sh.voided,
          }),
        });
        known.add(sh.trackingNumber);
        report.shipments_linked++;
        // status sync of the client order (the reship of an order is a new
        // ShipStation order with the same number: never overwrite ss_order_id)
        await sbPatch(`client_orders?id=eq.${local.id}`, {
          ss_tracking_number: sh.trackingNumber, ss_order_status: 'shipped',
          ss_shipped_at: sh.shipDate ? new Date(sh.shipDate).toISOString() : new Date().toISOString(),
        });
      }
      if (j && j.pages && page >= j.pages) break;
    }
  } catch (e) { err('shipments', e); }

  // (c) tracking polls
  try {
    const cutoff = new Date(Date.now() - RECHECK_HOURS * 3600000).toISOString();
    const due = await sb(
      `shipment_tracking?client_id=in.(${ids})&delivered_at=is.null&voided=eq.false` +
      `&ship_date=gte.${ymd(new Date(Date.now() - TRACK_LOOKBACK_DAYS * 86400000))}` +
      `&or=(checked_at.is.null,checked_at.lt.${enc(cutoff)})&order=checked_at.asc.nullsfirst&limit=40&select=*`);
    const queue = (due || []).slice();
    const worker = async () => {
      while (queue.length && left() > 2500) {
        const t = queue.shift();
        const nowIso = new Date().toISOString();
        try {
          const r = await ssTrack(v2CarrierCode(t.carrier_code), t.tracking_number);
          report.tracked++;
          const events = Array.isArray(r.events) ? r.events : [];
          const last = events[0] || {};
          const upd = {
            checked_at: nowIso, check_error: null,
            status_code: r.status_code || null, status_description: r.status_description || null,
            carrier_status_description: r.carrier_status_description || null,
            exception_description: r.exception_description || null,
            last_event_at: last.occurred_at || null,
          };
          const kind = classifyTracking({ ...r, events });
          if (String(r.status_code || '').toUpperCase() === 'DE' && kind !== 'access_point') {
            upd.delivered_at = r.actual_delivery_date ? new Date(r.actual_delivery_date).toISOString() : nowIso;
          }
          await sbPatch(`shipment_tracking?tracking_number=eq.${enc(t.tracking_number)}`, upd);

          const key = `trk:${t.tracking_number}`;
          if (upd.delivered_at) {
            const open = await findOpenException(key);
            if (open && open.state === 'awaiting_client') {
              await sbPatch(`shipment_exceptions?id=eq.${open.id}`, { state: 'resolved', resolved_at: nowIso, resolved_by: 'system', resolution_note: 'Delivered per carrier tracking', updated_at: nowIso });
              report.auto_resolved++;
            }
          } else if (kind) {
            const existing = await findOpenException(key);
            if (existing) {
              // a case can escalate (attempt → access point → return); keep one row, update the reading
              if (existing.kind !== kind || existing.carrier_status !== (r.status_description || null)) {
                await sbPatch(`shipment_exceptions?id=eq.${existing.id}`, {
                  kind, status_code: r.status_code || null, carrier_status: r.status_description || r.carrier_status_description || null,
                  carrier_detail: r.exception_description || last.description || null, event_at: last.occurred_at || null, updated_at: nowIso,
                });
              }
            } else {
              const { created } = await openException({
                dedupe_key: key, client_id: t.client_id, client_order_id: t.client_order_id,
                order_number: t.order_number, ss_order_id: t.ss_order_id, ss_shipment_id: t.ss_shipment_id,
                tracking_number: t.tracking_number, carrier: carrierLabel(t.carrier_code), kind,
                status_code: r.status_code || null,
                carrier_status: r.status_description || r.carrier_status_description || null,
                carrier_detail: r.exception_description || last.description || r.carrier_status_description || null,
                event_at: last.occurred_at || null,
              }, byId[t.client_id], {
                // A carrier event older than STALE_EVENT_HOURS (e.g. the first
                // pass after the guard is switched on finds a package that has
                // sat in an Access Point for days) opens the case silently: it
                // shows in the portal and on the staff page, but the client is
                // not emailed about something that may already be handled.
                notify: !last.occurred_at || (Date.now() - Date.parse(last.occurred_at)) < STALE_EVENT_HOURS * 3600000,
              });
              if (created) report.exceptions_opened++;
            }
          }
        } catch (e) {
          if (e.rateLimited) { queue.length = 0; break; }
          await sbPatch(`shipment_tracking?tracking_number=eq.${enc(t.tracking_number)}`, { checked_at: nowIso, check_error: String(e.message || e).slice(0, 300) }).catch(() => {});
          err(`track ${t.tracking_number}`, e);
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  } catch (e) { err('tracking', e); }

  // (d) overdue cases
  try {
    const overdue = await sb(`shipment_exceptions?state=eq.awaiting_client&due_at=lt.${enc(new Date().toISOString())}&select=*&limit=50`);
    for (const e of overdue || []) {
      const nowIso = new Date().toISOString();
      if (e.kind === 'address_pre_ship') {
        if (e.reminded_at) continue;
        await sbPatch(`shipment_exceptions?id=eq.${e.id}`, { reminded_at: nowIso, updated_at: nowIso });
        const c = byId[e.client_id];
        if (c) { try { await notifyClientNew(c, { ...e, due_at: null }); } catch (x) { err('reminder', x); } }
        await notifyStaff(`Delivery Guard · ${e.order_number}: address still not confirmed`,
          `${excRows(e)}<p>The client has not confirmed or corrected the address within ${DECISION_DAYS} business days. The order stays on hold in ShipStation. Please call the client.</p>`);
        report.reminders++;
      } else {
        await sbPatch(`shipment_exceptions?id=eq.${e.id}`, {
          decision: 'default_return', decided_by: 'system', decided_at: nowIso, state: 'decided', updated_at: nowIso,
        });
        await notifyStaff(`Delivery Guard · ${e.order_number}: default action applied (return to stock)`,
          `${excRows(e)}<p>No decision from the client within ${DECISION_DAYS} business days. Default: let the package return and restock it when it arrives. Close the case in <b>Delivery Exceptions</b> once it is received.</p>`);
        report.defaults_applied++;
      }
    }
  } catch (e) { err('overdue', e); }

  report.elapsed_ms = Date.now() - started;
  return report;
}

module.exports = {
  // constants
  OPEN_STATES, PRE_SHIP_DECISIONS, POST_SHIP_DECISIONS, DECISION_TEXT, KIND_TEXT, STAFF_EMAILS,
  // utils
  addBusinessDays, cleanLine2, cleanEmail, esc, addressVerdict, classifyTracking, v2CarrierCode, carrierLabel, trackingUrl,
  pickAddress, validateAddress, shipToSnapshot,
  // data
  sb, sbPatch, guardedClients, clientLabel,
  // actions
  evaluateAddress, applyDecision, publicException, runMonitor, openException,
};
