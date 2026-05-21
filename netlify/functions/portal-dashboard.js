// netlify/functions/portal-tracking.js
// FR-Logistics Client Portal — Fase 3, Tracking tab
//
// Returns the last 30 days of SHIPPED orders for the client linked to
// ?portal_user=<email>, filtering according to fr_clients.billing_source:
//   - ss_cf1   → cross-reference /orders (filtered by customField1) with
//                /shipments (filtered by date) — matching by orderId (unique).
//   - ss_store → filter /shipments directly by storeId.
//   - portal   → 'unsupported' mode (no ShipStation integration yet).
//
// Why orderId and not orderNumber:
//   orderNumber is a marketplace-supplied string and is NOT unique across
//   ShipStation. Generic IDs like "1047", "1048", "200014759678579" can
//   collide between different clients (different POS systems, different
//   Etsy stores, etc.). orderId is ShipStation's internal numeric primary
//   key — guaranteed unique. Match by orderId.
//
// Why two API calls for ss_cf1:
//   ShipStation's /orders endpoint exposes customField1 in the response
//   body (and accepts it as a filter param), but DOES NOT include
//   trackingNumber. /shipments has trackingNumber but does NOT include
//   customField1 in the shipment object (it always comes null on shipments
//   even when the underlying order has a value). So we cross-reference by
//   orderId.

const ALLOWED_ORIGINS = [
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
  'https://apps.fr-logistics.net',
];

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SS_BASE = 'https://ssapi.shipstation.com';
const SS_API_KEY = process.env.SS_API_KEY;
const SS_API_SECRET = process.env.SS_API_SECRET;

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // clientId → { data, ts }

const WINDOW_DAYS = 30;

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };
}

function ssHeaders() {
  const credentials = Buffer.from(`${SS_API_KEY}:${SS_API_SECRET}`).toString('base64');
  return {
    Authorization: `Basic ${credentials}`,
    'Content-Type': 'application/json',
  };
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

async function sbFetch(path) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
}

// Pull orders matching the supplied filter (server-side filtering by
// customField1 — confirmed to work in /orders despite past notes,
// because the past issue was billing-shipstation calling /orders without
// orderStatus=shipped; with orderStatus=shipped + customField1, /orders
// returns a properly filtered set, verified via debug returning 48 items
// for MXS).
async function fetchOrders(filterParams) {
  const all = [];
  let page = 1;
  const pageSize = 500;
  const maxPages = 10;

  while (page <= maxPages) {
    const params = new URLSearchParams({
      ...filterParams,
      pageSize: String(pageSize),
      page: String(page),
    });
    const url = `${SS_BASE}/orders?${params.toString()}`;
    const res = await fetch(url, { headers: ssHeaders() });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`ShipStation /orders ${res.status}: ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    const orders = data.orders || [];
    all.push(...orders);
    const totalPages = data.pages || 1;
    if (page >= totalPages || orders.length < pageSize) break;
    page++;
  }
  return all;
}

// Pull shipments for a date range.
async function fetchShipments(startDate, endDate) {
  const all = [];
  let page = 1;
  const pageSize = 500;
  const maxPages = 10;

  while (page <= maxPages) {
    const url = `${SS_BASE}/shipments?shipDateStart=${startDate}&shipDateEnd=${endDate}&pageSize=${pageSize}&page=${page}`;
    const res = await fetch(url, { headers: ssHeaders() });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`ShipStation /shipments ${res.status}: ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    const shipments = data.shipments || [];
    all.push(...shipments);
    const totalPages = data.pages || 1;
    if (page >= totalPages || shipments.length < pageSize) break;
    page++;
  }
  return all;
}

async function resolveStoreIds(storeName, aliases) {
  const candidates = [storeName, ...(aliases || [])]
    .filter(Boolean)
    .map((s) => String(s).trim().toLowerCase());
  if (!candidates.length) return [];
  const res = await fetch(`${SS_BASE}/stores?showInactive=false`, { headers: ssHeaders() });
  if (!res.ok) return [];
  const stores = await res.json();
  if (!Array.isArray(stores)) return [];
  return stores
    .filter((s) => candidates.includes(String(s.storeName || '').trim().toLowerCase()))
    .map((s) => String(s.storeId));
}

function trackingUrl(carrierCode, trackingNumber) {
  if (!trackingNumber) return '';
  const t = encodeURIComponent(trackingNumber);
  const c = (carrierCode || '').toLowerCase();
  if (c.includes('ups')) return `https://www.ups.com/track?tracknum=${t}`;
  if (c.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${t}`;
  if (c.includes('usps') || c.includes('stamps')) return `https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=${t}`;
  if (c.includes('dhl')) return `https://www.dhl.com/en/express/tracking.html?AWB=${t}`;
  return `https://www.google.com/search?q=${t}`;
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const headers = corsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const portalUser = (event.queryStringParameters || {}).portal_user;
  if (!portalUser) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing portal_user' }) };
  }
  if (!SS_API_KEY || !SS_API_SECRET) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ShipStation credentials not configured' }) };
  }

  try {
    const clientRes = await sbFetch(
      `fr_clients?portal_user=eq.${encodeURIComponent(portalUser)}` +
        `&select=id,name,company,billing_source,ss_custom_field_1,store_name,aliases`
    );
    if (!clientRes.ok) {
      const t = await clientRes.text();
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Client lookup failed', detail: t }) };
    }
    const clients = await clientRes.json();
    if (!clients.length) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No client linked to this portal user' }) };
    }
    const client = clients[0];
    const billingSource = (client.billing_source || '').toLowerCase().trim();
    const displayName = client.company || client.name;

    const cached = cache.get(client.id);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return { statusCode: 200, headers: { ...headers, 'X-Cache': 'HIT' }, body: JSON.stringify(cached.data) };
    }

    const now = new Date();
    const start = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const startDate = fmtDate(start);
    const endDate = fmtDate(now);

    if (billingSource === 'portal') {
      const payload = {
        client: { id: client.id, name: displayName },
        mode: 'unsupported_portal',
        windowDays: WINDOW_DAYS, windowStart: startDate, windowEnd: endDate,
        lastSync: new Date().toISOString(),
        kpis: { totalShipments: 0, carriers: 0 }, shipments: [],
      };
      cache.set(client.id, { data: payload, ts: Date.now() });
      return { statusCode: 200, headers, body: JSON.stringify(payload) };
    }

    // 5. Get the universe of shipments for the window.
    const allShipments = await fetchShipments(startDate, endDate);

    // 6. Build a Set of orderIds belonging to this client.
    //    Use orderId (numeric, unique) NOT orderNumber (string, can collide).
    let clientOrderIds = null;
    let storeIds = [];

    if (billingSource === 'ss_cf1') {
      const cf1 = (client.ss_custom_field_1 || '').trim();
      if (!cf1) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'ss_custom_field_1 empty' }) };
      }
      // modifyDate window catches orders shipped recently even if their
      // orderDate is older than 30 days (common with Wix orders imported
      // days before shipping).
      const orders = await fetchOrders({
        customField1: cf1,
        orderStatus: 'shipped',
        modifyDateStart: startDate,
        modifyDateEnd: endDate,
      });
      // Defense-in-depth: verify customField1 on each returned order
      // matches our client (in case ShipStation's filter is loose). Match
      // case-insensitive with trim, exactly like the billing system.
      const cf1Lower = cf1.toLowerCase();
      const matchingOrders = orders.filter((o) => {
        const v = (o.advancedOptions && o.advancedOptions.customField1) || '';
        return String(v).trim().toLowerCase() === cf1Lower;
      });
      clientOrderIds = new Set(matchingOrders.map((o) => o.orderId).filter(Boolean));
    } else if (billingSource === 'ss_store') {
      const storeName = (client.store_name || '').trim();
      if (!storeName) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'store_name empty' }) };
      }
      storeIds = await resolveStoreIds(storeName, client.aliases);
      if (!storeIds.length) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: `No ShipStation store matched "${storeName}"` }) };
      }
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Unsupported billing_source: ${billingSource}` }) };
    }

    // 7. Filter shipments to this client by orderId (unique) or storeId.
    let matched;
    if (billingSource === 'ss_cf1') {
      matched = allShipments.filter((sh) => clientOrderIds.has(sh.orderId));
    } else { // ss_store
      const idSet = new Set(storeIds);
      matched = allShipments.filter((sh) => {
        const id = sh.advancedOptions && sh.advancedOptions.storeId;
        return id != null && idSet.has(String(id));
      });
    }

    // 8. Keep only those with a tracking number and not voided.
    const shipped = matched.filter((sh) => sh.trackingNumber && !sh.voided);

    // 9. Project to UI rows.
    const rows = shipped.map((sh) => {
      const carrier = sh.carrierCode || '';
      const tn = sh.trackingNumber || '';
      return {
        orderNumber: sh.orderNumber || '',
        orderDate: sh.orderDate || sh.createDate || '',
        shipDate: sh.shipDate || '',
        recipient: (sh.shipTo && sh.shipTo.name) || '',
        destination: sh.shipTo
          ? [sh.shipTo.city, sh.shipTo.state].filter(Boolean).join(', ')
          : '',
        country: (sh.shipTo && sh.shipTo.country) || '',
        carrier,
        service: sh.serviceCode || '',
        trackingNumber: tn,
        trackingUrl: trackingUrl(carrier, tn),
        status: 'Shipped',
      };
    });

    rows.sort((a, b) => {
      const da = a.shipDate ? new Date(a.shipDate).getTime() : 0;
      const db = b.shipDate ? new Date(b.shipDate).getTime() : 0;
      return db - da;
    });

    const uniqueCarriers = new Set(rows.map((r) => r.carrier).filter(Boolean));
    const kpis = {
      totalShipments: rows.length,
      carriers: uniqueCarriers.size,
    };

    const payload = {
      client: { id: client.id, name: displayName },
      mode: billingSource,
      windowDays: WINDOW_DAYS, windowStart: startDate, windowEnd: endDate,
      lastSync: new Date().toISOString(),
      kpis, shipments: rows,
    };

    cache.set(client.id, { data: payload, ts: Date.now() });

    return {
      statusCode: 200,
      headers: { ...headers, 'X-Cache': 'MISS' },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'Failed to fetch tracking', detail: String(err) }),
    };
  }
};
