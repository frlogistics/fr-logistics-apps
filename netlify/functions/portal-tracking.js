// netlify/functions/portal-tracking.js
// FR-Logistics Client Portal — Fase 3, Tracking tab
// 🔧 DEBUG VERSION v4 — exposes raw /orders response when ?debug=1
//
// Pass ?debug=1 to inspect:
//   - filterParams sent to ShipStation
//   - rawOrderCount returned by ShipStation
//   - sample of the first 2 orders (so we can see field names + values)
//   - knownOrderFound for WS4B234173

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
const cache = new Map();
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
  return { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json' };
}

function fmtDate(d) { return d.toISOString().slice(0, 10); }

async function sbFetch(path) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
}

async function fetchOrders(filterParams) {
  const all = [];
  let page = 1;
  const maxPages = 10;
  while (page <= maxPages) {
    const params = new URLSearchParams({ ...filterParams, pageSize: '500', page: String(page) });
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
    if (page >= totalPages || orders.length < 500) break;
    page++;
  }
  return all;
}

async function resolveStoreIds(storeName, aliases) {
  const candidates = [storeName, ...(aliases || [])].filter(Boolean).map((s) => String(s).trim().toLowerCase());
  if (!candidates.length) return [];
  const res = await fetch(`${SS_BASE}/stores?showInactive=false`, { headers: ssHeaders() });
  if (!res.ok) return [];
  const stores = await res.json();
  if (!Array.isArray(stores)) return [];
  return stores.filter((s) => candidates.includes(String(s.storeName || '').trim().toLowerCase())).map((s) => String(s.storeId));
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
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const qs = event.queryStringParameters || {};
  const portalUser = qs.portal_user;
  const isDebug = qs.debug === '1';

  if (!portalUser) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing portal_user' }) };
  if (!SS_API_KEY || !SS_API_SECRET) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ShipStation credentials not configured' }) };

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
    if (!clients.length) return { statusCode: 404, headers, body: JSON.stringify({ error: 'No client linked to this portal user' }) };

    const client = clients[0];
    const billingSource = (client.billing_source || '').toLowerCase().trim();
    const displayName = client.company || client.name;

    if (!isDebug) {
      const cached = cache.get(client.id);
      if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        return { statusCode: 200, headers: { ...headers, 'X-Cache': 'HIT' }, body: JSON.stringify(cached.data) };
      }
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

    // ---- 🔧 DEBUG: try BOTH date filter strategies and report each count ----
    let filterParams;
    let debugInfo = null;

    if (isDebug) {
      // Run 3 different filter combinations to see which one works
      const baseFilter = { orderStatus: 'shipped' };
      if (billingSource === 'ss_cf1') baseFilter.customField1 = (client.ss_custom_field_1 || '').trim();
      else if (billingSource === 'ss_store') {
        const storeIds = await resolveStoreIds((client.store_name || '').trim(), client.aliases);
        if (storeIds.length) baseFilter.storeId = storeIds[0];
      }

      const tries = [
        { label: 'no_date_filter', params: { ...baseFilter } },
        { label: 'order_date', params: { ...baseFilter, orderDateStart: startDate, orderDateEnd: endDate } },
        { label: 'modify_date', params: { ...baseFilter, modifyDateStart: startDate, modifyDateEnd: endDate } },
      ];

      const tryResults = [];
      for (const t of tries) {
        try {
          const orders = await fetchOrders(t.params);
          const withTracking = orders.filter((o) => o.trackingNumber);
          const knownOrder = orders.find((o) => o.orderNumber === 'WS4B234173');
          tryResults.push({
            label: t.label,
            params: t.params,
            orderCount: orders.length,
            withTrackingCount: withTracking.length,
            knownOrderFound: !!knownOrder,
            knownOrderSample: knownOrder ? {
              orderNumber: knownOrder.orderNumber,
              orderDate: knownOrder.orderDate,
              shipDate: knownOrder.shipDate,
              orderStatus: knownOrder.orderStatus,
              trackingNumber: knownOrder.trackingNumber,
              carrierCode: knownOrder.carrierCode,
              customField1: knownOrder.advancedOptions ? knownOrder.advancedOptions.customField1 : null,
              allKeys: Object.keys(knownOrder),
            } : null,
            firstOrderSample: orders[0] ? {
              orderNumber: orders[0].orderNumber,
              orderDate: orders[0].orderDate,
              shipDate: orders[0].shipDate,
              customField1: orders[0].advancedOptions ? orders[0].advancedOptions.customField1 : null,
              trackingNumber: orders[0].trackingNumber,
            } : null,
          });
        } catch (e) {
          tryResults.push({ label: t.label, params: t.params, error: String(e) });
        }
      }

      return {
        statusCode: 200,
        headers: { ...headers, 'X-Cache': 'DEBUG' },
        body: JSON.stringify({
          client: { id: client.id, name: displayName, billing_source: client.billing_source, ss_custom_field_1: client.ss_custom_field_1 },
          window: { startDate, endDate, days: WINDOW_DAYS },
          tryResults,
        }, null, 2),
      };
    }

    // ---- NORMAL FLOW (debug not requested) ----
    filterParams = { orderDateStart: startDate, orderDateEnd: endDate, orderStatus: 'shipped' };

    if (billingSource === 'ss_cf1') {
      const cf1 = (client.ss_custom_field_1 || '').trim();
      if (!cf1) return { statusCode: 400, headers, body: JSON.stringify({ error: 'ss_custom_field_1 empty' }) };
      filterParams.customField1 = cf1;
    } else if (billingSource === 'ss_store') {
      const storeName = (client.store_name || '').trim();
      if (!storeName) return { statusCode: 400, headers, body: JSON.stringify({ error: 'store_name empty' }) };
      const storeIds = await resolveStoreIds(storeName, client.aliases);
      if (!storeIds.length) return { statusCode: 404, headers, body: JSON.stringify({ error: `No store matched "${storeName}"` }) };
      filterParams.storeId = storeIds[0];
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Unsupported billing_source: ${billingSource}` }) };
    }

    const orders = await fetchOrders(filterParams);
    const rows = orders.filter((o) => o.trackingNumber).map((o) => {
      const carrier = o.carrierCode || '';
      const tn = o.trackingNumber || '';
      return {
        orderNumber: o.orderNumber || '',
        orderDate: o.orderDate || o.createDate || '',
        shipDate: o.shipDate || '',
        recipient: (o.shipTo && o.shipTo.name) || '',
        destination: o.shipTo ? [o.shipTo.city, o.shipTo.state].filter(Boolean).join(', ') : '',
        country: (o.shipTo && o.shipTo.country) || '',
        carrier, service: o.serviceCode || '',
        trackingNumber: tn, trackingUrl: trackingUrl(carrier, tn),
        status: 'Shipped',
      };
    });
    rows.sort((a, b) => (new Date(b.shipDate || 0).getTime()) - (new Date(a.shipDate || 0).getTime()));

    const uniqueCarriers = new Set(rows.map((r) => r.carrier).filter(Boolean));
    const kpis = { totalShipments: rows.length, carriers: uniqueCarriers.size };

    const payload = {
      client: { id: client.id, name: displayName },
      mode: billingSource,
      windowDays: WINDOW_DAYS, windowStart: startDate, windowEnd: endDate,
      lastSync: new Date().toISOString(),
      kpis, shipments: rows,
    };

    cache.set(client.id, { data: payload, ts: Date.now() });
    return { statusCode: 200, headers: { ...headers, 'X-Cache': 'MISS' }, body: JSON.stringify(payload) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Failed to fetch tracking', detail: String(err) }) };
  }
};
