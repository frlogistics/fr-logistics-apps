// netlify/functions/portal-inbound-detail.js
// FR-Logistics Client Portal — line-level inbound detail for the Excel export.
//
// The Inbound tab is package level (one row per box). This endpoint is item
// level: it takes the readings of the Amazon packing slips (wh_slip_extractions,
// fed by slip-extract.js from the photo the warehouse takes) and turns them into
// one row per product line, with the client's own SKU resolved from wh_fnsku_map.
//
// IMPORTANT — what the quantity means:
// qty_declared is the number PRINTED BY AMAZON on the slip. It is not a count
// done by us. A short box still says what Amazon shipped, and that gap is
// precisely what a client needs to open a reimbursement case. The counted
// column is intentionally left empty until somebody physically counts, so the
// report never certifies something nobody verified.
//
// GET params: portal_user (required), days (default 90, max 400),
//             as_client (admin only — see clientFilter)
// Returns: { ok, client, window_days, lines, by_sku, coverage }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ALLOWED_ORIGINS = [
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
  'https://apps.fr-logistics.net',
];

const DEFAULT_DAYS = 90;
const MAX_DAYS = 400;

// --- "View as client" (internal use only) ----------------------------------
// Same contract as the other portal-* functions: honored only for the admin
// email, ignored for anybody else, so a client cannot read another client's
// detail by adding the parameter.
const PORTAL_ADMIN_EMAIL = 'warehouse@fr-logistics.net';
const AS_CLIENT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clientFilter(portalUser, params) {
  const asClient = String((params || {}).as_client || '').trim();
  const isAdmin =
    String(portalUser || '').trim().toLowerCase() === PORTAL_ADMIN_EMAIL;
  if (isAdmin && AS_CLIENT_UUID_RE.test(asClient)) return `id=eq.${asClient}`;
  return `portal_user=eq.${encodeURIComponent(portalUser)}`;
}

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };
}

function json(statusCode, body, origin) {
  return { statusCode, headers: corsHeaders(origin), body: JSON.stringify(body) };
}

async function sb(path) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
}

// FNSKU / barcode -> the client's own SKU. The map is synced daily from the
// WMS; resolving at REPORT time (not at extraction time) means a corrected or
// newly synced SKU shows up in reports generated from then on.
async function loadSkuMap() {
  const map = new Map();
  try {
    const res = await sb('wh_fnsku_map?select=code,sku,code_type&limit=5000');
    if (!res.ok) return map;
    const rows = await res.json();
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r.code) continue;
      const key = String(r.code).trim().toUpperCase();
      // 'code' is the authoritative barcode; alt_sku/part_number only fill gaps.
      if (r.code_type === 'code' || !map.has(key)) map.set(key, r.sku || '');
    }
  } catch {
    /* the report still works without SKUs, it just shows the FNSKU */
  }
  return map;
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  }

  try {
    const params = event.queryStringParameters || {};
    const portalUser = String(params.portal_user || '').trim();
    if (!portalUser) return json(400, { ok: false, error: 'missing portal_user' }, origin);

    const isAdmin = portalUser.toLowerCase() === PORTAL_ADMIN_EMAIL;

    let days = parseInt(params.days || '', 10);
    if (!Number.isFinite(days) || days <= 0) days = DEFAULT_DAYS;
    if (days > MAX_DAYS) days = MAX_DAYS;
    const since = new Date(Date.now() - days * 86400 * 1000).toISOString();

    // 1. Which client?
    const clientRes = await sb(
      `fr_clients?${clientFilter(portalUser, params)}&select=id,name,company&limit=1`
    );
    const clientRows = await clientRes.json();
    if (!Array.isArray(clientRows) || !clientRows.length) {
      return json(200, { ok: true, mode: 'no_client', lines: [], by_sku: [] }, origin);
    }
    const client = clientRows[0];

    // 2. Their inbound packages in the window.
    const shipRes = await sb(
      `shipments_general?direction=eq.Inbound&client_id=eq.${client.id}` +
        `&or=(received_at.gte.${since},and(received_at.is.null,created_at.gte.${since}))` +
        `&select=id,received_at,created_at,tracking,type,notes,photo_urls` +
        `&order=received_at.desc.nullslast`
    );
    if (!shipRes.ok) {
      return json(502, { ok: false, error: 'supabase_error', detail: await shipRes.text() }, origin);
    }
    const shipments = await shipRes.json();
    const byId = new Map((Array.isArray(shipments) ? shipments : []).map((s) => [s.id, s]));

    // 3. Slip readings in the same window. Clients only ever see confident
    //    readings; the internal user also sees the ones queued for review.
    const statusFilter = isAdmin ? 'in.(ok,low_confidence)' : 'eq.ok';
    const slipRes = await sb(
      `wh_slip_extractions?status=${statusFilter}&created_at=gte.${since}` +
        `&select=shipment_id,status,items,ra_number,vret_id,amz_shipment_id,origin_fc,process_date,confidence,photo_url,lpn` +
        `&order=created_at.desc`
    );
    const slips = slipRes.ok ? await slipRes.json() : [];

    const skuMap = await loadSkuMap();

    // 4. Flatten to one row per product line.
    const lines = [];
    const seenShipments = new Set();
    for (const s of Array.isArray(slips) ? slips : []) {
      const ship = byId.get(s.shipment_id);
      if (!ship) continue; // belongs to another client, or outside the window
      if (seenShipments.has(s.shipment_id)) continue; // newest reading wins
      seenShipments.add(s.shipment_id);

      const items = Array.isArray(s.items) ? s.items : [];
      for (const it of items) {
        const code = String(it.fnsku || it.asin || it.upc || '').trim();
        const sku = code ? skuMap.get(code.toUpperCase()) || '' : '';
        const ts = ship.received_at || ship.created_at || '';
        lines.push({
          date: ts ? ts.slice(0, 10) : '',
          tracking: ship.tracking || '',
          type: ship.type || '',
          sku,
          fnsku: it.fnsku || '',
          asin: it.asin || '',
          upc: it.upc || '',
          // Per-item LPN when the slip lists one per line; otherwise the
          // document-level one. Customer returns are identified by this.
          lpn: it.lpn || s.lpn || '',
          title: it.title || '',
          qty_declared:
            it.qty === null || it.qty === undefined || it.qty === '' ? null : Number(it.qty),
          qty_counted: null, // stays empty on purpose — nobody counted this yet
          ra_number: s.ra_number || '',
          vret_id: s.vret_id || '',
          origin_fc: s.origin_fc || '',
          process_date: s.process_date || '',
          photo_url: s.photo_url || '',
          needs_review: s.status === 'low_confidence',
          confidence: s.confidence === null || s.confidence === undefined ? null : Number(s.confidence),
        });
      }
    }

    // 5. Rollup by SKU — the view a client actually asks for: "how many units
    //    of my SKU arrived this month".
    const rollup = new Map();
    for (const l of lines) {
      const key = l.sku || l.fnsku || l.upc || l.lpn || '(unidentified)';
      const cur = rollup.get(key) || {
        sku: l.sku,
        fnsku: l.fnsku,
        title: l.title,
        packages: new Set(),
        qty_declared: 0,
      };
      cur.packages.add(l.tracking);
      if (Number.isFinite(l.qty_declared)) cur.qty_declared += l.qty_declared;
      if (!cur.title && l.title) cur.title = l.title;
      rollup.set(key, cur);
    }
    const bySku = [...rollup.entries()]
      .map(([key, v]) => ({
        key,
        sku: v.sku,
        fnsku: v.fnsku,
        title: v.title,
        packages: v.packages.size,
        qty_declared: v.qty_declared,
      }))
      .sort((a, b) => b.qty_declared - a.qty_declared);

    // 6. Be explicit about how much of the period this detail actually covers,
    //    so nobody reads a partial report as a complete one.
    const totalPackages = Array.isArray(shipments) ? shipments.length : 0;
    const coverage = {
      packages_total: totalPackages,
      packages_with_slip: seenShipments.size,
      packages_without_slip: Math.max(0, totalPackages - seenShipments.size),
    };

    return json(
      200,
      {
        ok: true,
        mode: 'ok',
        client: { id: client.id, name: client.name || '', company: client.company || '' },
        window_days: days,
        generated_at: new Date().toISOString(),
        coverage,
        lines,
        by_sku: bySku,
      },
      origin
    );
  } catch (err) {
    return json(500, { ok: false, error: String((err && err.message) || err) }, origin);
  }
};
