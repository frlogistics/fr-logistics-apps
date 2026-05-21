// netlify/functions/portal-tracking.js
// FR-Logistics Client Portal — Fase 3, Tracking tab
//
// 🔧 TEMPORARY DEBUG VERSION — passes ?debug=1 to get raw ShipStation sample
//
// Pass ?debug=1 in addition to portal_user to receive:
//   - rawSampleCount: how many shipments came from ShipStation
//   - sampleCF1Values: array of all unique customField1 values seen
//   - sampleShipments: first 3 raw shipments (truncated) for inspection
//
// Once the issue is identified, remove the debug branch and redeploy.

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
  return {
    'Authorization': `Basic ${credentials}`,
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

async function fetchShipments(startDate, endDate) {
  const all = [];
  let page = 1;
  const pageSize = 500;
  const maxPages = 10;

  while (page <= maxPages) {
    const url = `${SS_BASE}/shipments?shipDateStart=${startDate}&shipDateEnd=${endDate}&pageSize=${pageSize}&page=${page}`;
    const res = await fetch(url, { headers: ssHeaders() });
    if (!res.ok) throw new Error(`ShipStation /shipments ${res.status}`);
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

  const qs = event.queryStringParameters || {};
  const portalUser = qs.portal_user;
  const isDebug = qs.debug === '1';

  if (!portalUser) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing portal_user' }) };
  }
  if (!SS_API_KEY || !SS_API_SECRET) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ShipStation credentials not configured' }) };
  }

  try {
    const clientRes = await sbFetch(
      `fr_clients?portal_user=eq.${encodeURIComponent(portalUser)}` +
        `&select=id,name,billing_source,ss_custom_field_1,store_name,aliases`
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

    // SKIP cache in debug mode so we always get fresh data.
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
        client: { id: client.id, name: client.name },
        mode: 'unsupported_portal',
        windowDays: WINDOW_DAYS, windowStart: startDate, windowEnd: endDate,
        lastSync: new Date().toISOString(),
        kpis: { totalShipments: 0, carriers: 0 }, shipments: [],
      };
      cache.set(client.id, { data: payload, ts: Date.now() });
      return { statusCode: 200, headers, body: JSON.stringify(payload) };
    }

    const rawShipments = await fetchShipments(startDate, endDate);

    // 🔧 DEBUG: collect diagnostic info before filtering
    let debugInfo = null;
    if (isDebug) {
      const allCF1Values = {};
      for (const sh of rawShipments) {
        const v = (sh.advancedOptions && sh.advancedOptions.customField1) || '(null)';
        allCF1Values[v] = (allCF1Values[v] || 0) + 1;
      }
      // Search specifically for the WS4B234173 order we KNOW exists
      const knownOrder = rawShipments.find((sh) => sh.orderNumber === 'WS4B234173');
      debugInfo = {
        rawSampleCount: rawShipments.length,
        clientLookup: {
          id: client.id,
          name: client.name,
          billing_source: client.billing_source,
          ss_custom_field_1: client.ss_custom_field_1,
          store_name: client.store_name,
        },
        targetCF1Normalized: (client.ss_custom_field_1 || '').trim().toLowerCase(),
        // How many distinct customField1 values exist in raw, with counts
        allCF1ValuesSeen: allCF1Values,
        // The specific WS4B234173 order we know is MXS — full structure
        knownOrderFound: !!knownOrder,
        knownOrderDump: knownOrder ? {
          orderNumber: knownOrder.orderNumber,
          shipDate: knownOrder.shipDate,
          trackingNumber: knownOrder.trackingNumber,
          carrierCode: knownOrder.carrierCode,
          voided: knownOrder.voided,
          advancedOptions: knownOrder.advancedOptions,
          // ShipStation sometimes puts customField1 directly on shipment too
          customField1Direct: knownOrder.customField1,
          // List all top-level keys to spot if cf1 lives elsewhere
          allKeys: Object.keys(knownOrder),
        } : null,
      };
    }

    let matched = [];
    let storeMatched = false;
    let storeIds = [];

    if (billingSource === 'ss_cf1') {
      const cf1 = (client.ss_custom_field_1 || '').trim().toLowerCase();
      if (!cf1) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'ss_custom_field_1 empty', debug: debugInfo }) };
      }
      matched = rawShipments.filter((sh) => {
        const v = (sh.advancedOptions && sh.advancedOptions.customField1) || '';
        return String(v).trim().toLowerCase() === cf1;
      });
    } else if (billingSource === 'ss_store') {
      const storeName = (client.store_name || '').trim();
      if (!storeName) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'store_name empty', debug: debugInfo }) };
      }
      storeIds = await resolveStoreIds(storeName, client.aliases);
      if (!storeIds.length) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: `No store matched "${storeName}"`, debug: debugInfo }) };
      }
      const idSet = new Set(storeIds);
      matched = rawShipments.filter((sh) => {
        const id = sh.advancedOptions && sh.advancedOptions.storeId;
        return id != null && idSet.has(String(id));
      });
      storeMatched = true;
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Unsupported billing_source: ${billingSource}`, debug: debugInfo }) };
    }

    const shipped = matched.filter((sh) => sh.trackingNumber && !sh.voided);

    const rows = shipped.map((sh) => {
      const carrier = sh.carrierCode || '';
      const tn = sh.trackingNumber || '';
      return {
        orderNumber: sh.orderNumber || '',
        orderDate: sh.orderDate || sh.createDate || '',
        shipDate: sh.shipDate || '',
        recipient: (sh.shipTo && sh.shipTo.name) || '',
        destination: sh.shipTo ? [sh.shipTo.city, sh.shipTo.state].filter(Boolean).join(', ') : '',
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
    const kpis = { totalShipments: rows.length, carriers: uniqueCarriers.size };

    const payload = {
      client: { id: client.id, name: client.name },
      mode: billingSource,
      windowDays: WINDOW_DAYS, windowStart: startDate, windowEnd: endDate,
      lastSync: new Date().toISOString(),
      storeMatched, storeIds, kpis, shipments: rows,
      ...(isDebug && { debug: debugInfo }),
    };

    if (!isDebug) cache.set(client.id, { data: payload, ts: Date.now() });

    return {
      statusCode: 200,
      headers: { ...headers, 'X-Cache': isDebug ? 'DEBUG' : 'MISS' },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Failed to fetch tracking', detail: String(err) }) };
  }
};
