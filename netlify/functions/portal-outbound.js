// netlify/functions/portal-outbound.js
// FR-Logistics Client Portal — "Outbound" tab.
//
// The client's pickup and B2B orders that leave in our boxes, each with its
// packing list: what they asked for, what we packed, box by box. Same data the
// warehouse sees in packlist.html — the report itself is built by
// frm-packlist.js (exports.core), so the portal and the office can never show
// two different packing lists for the same order.
//
// Auth contract: identical to portal-inbound.js.
//   CLIENT MODE: ?portal_user=<email> → only that client's orders.
//   ADMIN MODE (warehouse@fr-logistics.net): every client's orders, or exactly
//   one client's view with ?as_client=<fr_clients.id>. as_client is ignored
//   for anybody who is not the admin email.
//
// GET ?portal_user=…[&as_client=…]                       → { ok, orders:[…] }
// GET ?portal_user=…&id=<uuid>[&format=json|html|xlsx]   → one packing list
//
// Only kind pickup / b2b. FBA shipments have their own module and manifest.

const { core } = require('./frm-packlist.js');

const ALLOWED_ORIGINS = [
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
  'https://apps.fr-logistics.net',
];
const ADMIN_EMAIL = 'warehouse@fr-logistics.net';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Internal fields that never reach a client payload.
const REF_PUBLIC = ['id', 'reference', 'kind', 'status', 'created_at', 'closed_at', 'client_name'];

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    Vary: 'Origin',
  };
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const json = (code, obj) => ({ statusCode: code, headers: { ...cors(origin), 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(origin), body: '' };
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'Method not allowed' });

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return json(500, { ok: false, error: 'Supabase not configured' });
  const sb = core.makeSb(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { getRef, buildReport } = core.makeCore(sb);
  const enc = encodeURIComponent;

  try {
    const qs = event.queryStringParameters || {};
    const portalUser = String(qs.portal_user || '').trim();
    if (!portalUser) return json(400, { ok: false, error: 'missing portal_user' });

    const isAdmin = portalUser.toLowerCase() === ADMIN_EMAIL;
    const viewingAs = isAdmin && UUID_RE.test(String(qs.as_client || '')) ? String(qs.as_client) : '';
    const allClients = isAdmin && !viewingAs;

    // Resolve the client the caller is allowed to see.
    let client = null;
    if (!allClients) {
      const lookup = viewingAs ? `id=eq.${enc(viewingAs)}` : `portal_user=eq.${enc(portalUser)}`;
      const rows = await sb(`fr_clients?${lookup}&select=id,name,company&limit=1`);
      client = rows && rows[0];
      if (!client) return json(200, { ok: true, mode: 'no_client', isAdmin: false, orders: [] });
    }

    // ── one packing list ────────────────────────────────────────────────
    if (qs.id) {
      const ref = await getRef(qs.id);
      // Same answer for "not yours" and "does not exist".
      if (!ref || !['pickup', 'b2b'].includes(ref.kind) || (!allClients && ref.client_id !== client.id)) {
        return json(404, { ok: false, error: 'Order not found' });
      }
      const rep = await buildReport(ref);
      const safe = String(ref.reference).replace(/[^\w.-]+/g, '_');
      if (qs.format === 'html') {
        return { statusCode: 200, headers: { ...cors(origin), 'Content-Type': 'text/html; charset=utf-8' }, body: core.renderHtml(rep) };
      }
      if (qs.format === 'xlsx') {
        return {
          statusCode: 200, isBase64Encoded: true,
          headers: {
            ...cors(origin),
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="PackingList_${safe}.xlsx"`,
          },
          body: core.renderXlsx(rep).toString('base64'),
        };
      }
      const pub = Object.fromEntries(REF_PUBLIC.map((k) => [k, rep.ref[k]]));
      return json(200, {
        ok: true,
        ref: pub,
        totals: rep.totals,
        total_weight_lb: rep.total_weight_lb,
        boxes: rep.boxes.map((b) => ({ code: b.code, status: b.status, sealed_at: b.sealed_at, weight_lb: b.weight_lb, dims: b.dims, lines: b.lines })),
        compare: rep.compare.map((r) => ({
          sku: r.sku, asin: r.asin, fnsku: r.fnsku, description: r.description,
          qty_requested: r.qty_requested, qty_packed: r.qty_packed, diff: r.diff, state: r.state,
        })),
      });
    }

    // ── list ────────────────────────────────────────────────────────────
    const f = ['kind=in.(pickup,b2b)'];
    if (!allClients) f.push(`client_id=eq.${enc(client.id)}`);
    const since = new Date(Date.now() - 400 * 86400 * 1000).toISOString();
    f.push(`created_at=gte.${since}`);
    const refs = await sb(`fba_shipments?${f.join('&')}&select=id,reference,kind,status,created_at,closed_at,client_id,client:fr_clients(company,name)&order=created_at.desc&limit=200`);
    const list = refs || [];
    const ids = list.map((r) => r.id);

    let cmp = []; let boxes = [];
    if (ids.length) {
      const inIds = `in.(${ids.map(enc).join(',')})`;
      [cmp, boxes] = await Promise.all([
        sb(`v_outbound_packlist_compare?shipment_id=${inIds}&select=shipment_id,qty_requested,qty_packed,state&limit=20000`),
        sb(`wh_containers?fba_shipment_id=${inIds}&status=neq.consumed&select=fba_shipment_id&limit=5000`),
      ]);
    }
    const orders = list.map((r) => {
      const rows = (cmp || []).filter((x) => x.shipment_id === r.id);
      return {
        id: r.id, reference: r.reference, kind: r.kind, status: r.status,
        created_at: r.created_at, closed_at: r.closed_at,
        ...(allClients ? { client: r.client ? (r.client.company || r.client.name) : '' } : {}),
        boxes: (boxes || []).filter((b) => b.fba_shipment_id === r.id).length,
        units_requested: rows.reduce((n, x) => n + (x.qty_requested || 0), 0),
        units_packed: rows.reduce((n, x) => n + (x.qty_packed || 0), 0),
        differences: rows.filter((x) => x.state !== 'OK').length,
      };
    });
    return json(200, { ok: true, isAdmin: allClients, client: client ? { id: client.id, name: client.company || client.name } : null, orders });
  } catch (err) {
    console.error('[portal-outbound]', err);
    return json(500, { ok: false, error: 'Request failed' });
  }
};
