// netlify/functions/portal-tracking.js
// FR-Logistics Client Portal — Fase 3, Tracking tab
//
// Returns the last 30 days of SHIPPED orders for the client linked to
// ?portal_user=<email>, filtering according to fr_clients.billing_source:
//   - ss_cf1   → /orders?customField1=<value>&orderStatus=shipped
//   - ss_store → /orders?storeId=<id>&orderStatus=shipped
//   - portal   → 'unsupported' mode (no ShipStation integration yet)
//
// Why /orders (not /shipments):
//   ShipStation's /shipments endpoint does NOT include customField1 in its
//   response — that field lives on the Order object. /orders supports
//   server-side filtering by customField1 AND includes tracking + shipping
//   data on shipped orders, so a single call gives us everything we need.

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
// ShipStation /orders supports customField1, storeId, orderStatus, and
// shipDateStart/End server-side, so we don't need to download every order
// and filter client-side.
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

    // 3. Date window.
    const now = new Date();
    const start = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const startDate = fmtDate(start);
    const endDate = fmtDate(now);

    // 4. Portal mode: no ShipStation integration yet.
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

    // 5. Build the /orders filter. We use orderDateStart/End instead of
    //    shipDateStart/End because /orders supports them more reliably,
    //    and orderStatus=shipped already constrains us to shipped orders.
    const filterParams = {
      orderDateStart: startDate,
      orderDateEnd: endDate,
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
      filterParams.storeId = storeIds[0];
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Unsupported billing_source: ${billingSource}` }) };
    }

    // 6. Pull matching orders. Each shipped order in ShipStation includes
    //    the trackingNumber, carrierCode, serviceCode, and shipDate of its
    //    primary shipment — we don't need a second call to /shipments.
    const orders = await fetchOrders(filterParams);

    // 7. Project each shipped order to one tracking row.
    const rows = orders
      .filter((o) => o.trackingNumber)  // ignore orders that haven't been labeled yet
      .map((o) => {
        const carrier = o.carrierCode || '';
        const tn = o.trackingNumber || '';
        return {
          orderNumber: o.orderNumber || '',
          orderDate: o.orderDate || o.createDate || '',
          shipDate: o.shipDate || '',
          recipient: (o.shipTo && o.shipTo.name) || '',
          destination: o.shipTo
            ? [o.shipTo.city, o.shipTo.state].filter(Boolean).join(', ')
            : '',
          country: (o.shipTo && o.shipTo.country) || '',
          carrier,
          service: o.serviceCode || '',
          trackingNumber: tn,
          trackingUrl: trackingUrl(carrier, tn),
          status: 'Shipped',
        };
      });

    // Sort by shipDate desc (most recent first).
    rows.sort((a, b) => {
      const da = a.shipDate ? new Date(a.shipDate).getTime() : 0;
      const db = b.shipDate ? new Date(b.shipDate).getTime() : 0;
      return db - da;
    });

    // 8. KPIs.
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
