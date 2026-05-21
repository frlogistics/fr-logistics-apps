// netlify/functions/portal-tracking.js
// FR-Logistics Client Portal — Fase 3, Tracking tab
//
// Returns the last 30 days of SHIPPED orders for the client linked to
// ?portal_user=<email>, filtering according to fr_clients.billing_source:
//   - ss_cf1   → /orders?customField1=<value> (ShipStation filters server-side)
//   - ss_store → /orders?storeId=<id> (resolved from store_name + aliases)
//   - portal   → 'unsupported' mode (no ShipStation integration yet)
//
// Why /orders and not /shipments:
// ShipStation's /shipments endpoint does NOT include customField1 in its
// response — that field lives on the Order object, not the Shipment.
// Filtering /shipments by CF1 client-side returns 0 because the value
// is always null. Using /orders instead solves this AND lets ShipStation
// do the filtering server-side, which is faster and more accurate.
// Each /orders result includes a `shipments` array with tracking data
// once the label has been bought.

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
    'Authorization': `Basic ${credentials}`,
    'Content-Type': 'application/json',
  };
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function sbFetch(path) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
}

// Pull orders from ShipStation matching the supplied filter params.
// ShipStation's /orders endpoint supports customField1, storeId, and date
// filters server-side, so we don't need to download every order in the
// warehouse and filter client-side (which was the previous bug).
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

// Fetch shipments for a specific list of orderIds. ShipStation /shipments
// supports comma-separated orderIds in the query string.
async function fetchShipmentsForOrders(orderIds) {
  if (!orderIds.length) return [];
  const all = [];
  // Chunk into batches of 100 to keep URLs short.
  for (let i = 0; i < orderIds.length; i += 100) {
    const chunk = orderIds.slice(i, i + 100);
    let page = 1;
    while (page <= 10) {
      const params = new URLSearchParams({
        orderId: chunk.join(','),
        pageSize: '500',
        page: String(page),
      });
      const url = `${SS_BASE}/shipments?${params.toString()}`;
      const res = await fetch(url, { headers: ssHeaders() });
      if (!res.ok) throw new Error(`ShipStation /shipments ${res.status}`);
      const data = await res.json();
      const shipments = data.shipments || [];
      all.push(...shipments);
      const totalPages = data.pages || 1;
      if (page >= totalPages || shipments.length < 500) break;
      page++;
    }
  }
  return all;
}

// Resolve storeIds from fr_clients.store_name (and aliases) by listing
// ShipStation stores and matching by name case-insensitively.
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

// Map a ShipStation carrier code to a public tracking URL.
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
    // 1. Resolve client by portal_user.
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
    // Display name in the response uses company (canonical) when available.
    const displayName = client.company || client.name;

    // 2. Cache check.
    const cached = cache.get(client.id);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return {
        statusCode: 200,
        headers: { ...headers, 'X-Cache': 'HIT' },
        body: JSON.stringify(cached.data),
      };
    }

    // 3. Compute date window: last 30 days, in ISO with time to match
    //    ShipStation's expected format for orderDateStart.
    const now = new Date();
    const start = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const startDate = fmtDate(start);
    const endDate = fmtDate(now);

    // 4. Branch by billing_source.
    if (billingSource === 'portal') {
      const payload = {
        client: { id: client.id, name: displayName },
        mode: 'unsupported_portal',
        windowDays: WINDOW_DAYS,
        windowStart: startDate,
        windowEnd: endDate,
        lastSync: new Date().toISOString(),
        kpis: { totalShipments: 0, carriers: 0 },
        shipments: [],
      };
      cache.set(client.id, { data: payload, ts: Date.now() });
      return {
        statusCode: 200,
        headers: { ...headers, 'X-Cache': 'MISS' },
        body: JSON.stringify(payload),
      };
    }

    // 5. Build the /orders filter based on billing_source.
    //    /orders supports customField1 and storeId filtering server-side,
    //    which is more efficient and avoids the /shipments customField1
    //    null bug.
    let filterParams = {
      // Use shipDateStart/End on /orders to scope to recently-shipped
      // orders, matching the 30-day "shipped" window semantics.
      shipDateStart: startDate,
      shipDateEnd: endDate,
      orderStatus: 'shipped',
    };

    if (billingSource === 'ss_cf1') {
      const cf1 = (client.ss_custom_field_1 || '').trim();
      if (!cf1) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'ss_custom_field_1 empty' }) };
      }
      filterParams.customField1 = cf1;
    } else if (billingSource === 'ss_store') {
      const storeName = (client.store_name || '').trim();
      if (!storeName) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'store_name empty' }) };
      }
      const storeIds = await resolveStoreIds(storeName, client.aliases);
      if (!storeIds.length) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: `No ShipStation store matched "${storeName}"` }) };
      }
      // ShipStation /orders accepts one storeId per call. For multi-store
      // clients (aliases), we'd need parallel calls. For now most clients
      // map to one store, so take the first match.
      filterParams.storeId = storeIds[0];
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Unsupported billing_source: ${billingSource}` }) };
    }

    // 6. Pull matching orders from ShipStation.
    const orders = await fetchOrders(filterParams);

    // 7. For each order, look up its shipments to get tracking + ship date.
    //    /orders does NOT include shipments inline; we have to fetch them.
    const orderIds = orders.map((o) => o.orderId).filter(Boolean);
    const allShipments = await fetchShipmentsForOrders(orderIds);

    // Index shipments by orderId so we can pair them back with orders.
    const shipmentsByOrder = new Map();
    for (const sh of allShipments) {
      if (!shipmentsByOrder.has(sh.orderId)) shipmentsByOrder.set(sh.orderId, []);
      shipmentsByOrder.get(sh.orderId).push(sh);
    }

    // 8. Project each order to one row. If an order has multiple shipments
    //    (split shipments), take the most recent non-voided one.
    const rows = orders.map((o) => {
      const shipments = (shipmentsByOrder.get(o.orderId) || [])
        .filter((sh) => !sh.voided && sh.trackingNumber);
      if (shipments.length === 0) return null;
      // Most recent shipment by shipDate.
      shipments.sort((a, b) => {
        const da = a.shipDate ? new Date(a.shipDate).getTime() : 0;
        const db = b.shipDate ? new Date(b.shipDate).getTime() : 0;
        return db - da;
      });
      const sh = shipments[0];
      const carrier = sh.carrierCode || o.carrierCode || '';
      const tn = sh.trackingNumber || '';
      return {
        orderNumber: o.orderNumber || '',
        orderDate: o.orderDate || o.createDate || '',
        shipDate: sh.shipDate || '',
        recipient: (o.shipTo && o.shipTo.name) || (sh.shipTo && sh.shipTo.name) || '',
        destination: o.shipTo
          ? [o.shipTo.city, o.shipTo.state].filter(Boolean).join(', ')
          : '',
        country: (o.shipTo && o.shipTo.country) || '',
        carrier,
        service: sh.serviceCode || o.serviceCode || '',
        trackingNumber: tn,
        trackingUrl: trackingUrl(carrier, tn),
        status: 'Shipped',
      };
    }).filter(Boolean);

    // Sort by shipDate desc (most recent first).
    rows.sort((a, b) => {
      const da = a.shipDate ? new Date(a.shipDate).getTime() : 0;
      const db = b.shipDate ? new Date(b.shipDate).getTime() : 0;
      return db - da;
    });

    // 9. KPIs.
    const uniqueCarriers = new Set(rows.map((r) => r.carrier).filter(Boolean));
    const kpis = {
      totalShipments: rows.length,
      carriers: uniqueCarriers.size,
    };

    const payload = {
      client: { id: client.id, name: displayName },
      mode: billingSource,
      windowDays: WINDOW_DAYS,
      windowStart: startDate,
      windowEnd: endDate,
      lastSync: new Date().toISOString(),
      kpis,
      shipments: rows,
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
