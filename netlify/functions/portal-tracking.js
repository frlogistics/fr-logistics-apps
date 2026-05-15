// netlify/functions/portal-tracking.js
// FR-Logistics Client Portal — Fase 3, Tracking tab
//
// Returns the last 30 days of SHIPPED shipments (those with a trackingNumber)
// for the client linked to ?portal_user=<email>, filtering according to the
// fr_clients billing_source contract:
//   - ss_cf1   → filter shipments where advancedOptions.customField1 matches
//                fr_clients.ss_custom_field_1 (case-insensitive trim).
//   - ss_store → resolve fr_clients.store_name (+ aliases) to a ShipStation
//                storeId via /stores, then filter shipments by advancedOptions.storeId.
//   - portal   → for clients whose orders are born in our own portal (not
//                ShipStation yet). Returns 'unsupported' mode so the UI can
//                show a "feature coming soon" message instead of an empty
//                state that looks like a bug.
//
// Pattern: calques shipstation.js (Basic Auth, /shipments endpoint, env vars
// SS_API_KEY + SS_API_SECRET). Auth and ShipStation base URL identical.

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
// Cache keyed by client id. Never serve one client's cache to another.
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

// Pull shipments from ShipStation for a date range. The /shipments endpoint
// returns up to 500 per page; with <50 shipments/day we fit a 30-day window
// in a single page (~1500 max). Paginate defensively in case volume grows.
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
    // ShipStation returns 'pages' in the response when paginating.
    const totalPages = data.pages || 1;
    if (page >= totalPages || shipments.length < pageSize) break;
    page++;
  }
  return all;
}

// Look up the storeId for a client in ss_store mode. The fr_clients contract
// stores store_name (canonical) plus aliases (array of alternative names).
// We match any of them case-insensitively against ShipStation's store list.
async function resolveStoreIds(storeName, aliases) {
  const candidates = [storeName, ...(aliases || [])]
    .filter(Boolean)
    .map((s) => String(s).trim().toLowerCase());
  if (!candidates.length) return [];

  const res = await fetch(`${SS_BASE}/stores?showInactive=false`, { headers: ssHeaders() });
  if (!res.ok) return [];
  const stores = await res.json();
  if (!Array.isArray(stores)) return [];

  const matchedIds = stores
    .filter((s) => {
      const name = String(s.storeName || '').trim().toLowerCase();
      return candidates.includes(name);
    })
    .map((s) => String(s.storeId));
  return matchedIds;
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
  // Fallback: Google search of the tracking number.
  return `https://www.google.com/search?q=${t}`;
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const headers = corsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
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
    // 1. Resolve client by portal_user. We need id, name, billing_source,
    //    ss_custom_field_1, store_name, aliases.
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

    // 2. Cache check (by client id).
    const cached = cache.get(client.id);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return {
        statusCode: 200,
        headers: { ...headers, 'X-Cache': 'HIT' },
        body: JSON.stringify(cached.data),
      };
    }

    // 3. Compute date window: last 30 days.
    const now = new Date();
    const start = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const startDate = fmtDate(start);
    const endDate = fmtDate(now);

    // 4. Branch by billing_source.
    //    - portal: not yet supported by Tracking. Return empty + 'unsupported'
    //      mode so the UI shows "feature coming soon" instead of an empty
    //      state that looks like a bug.
    if (billingSource === 'portal') {
      const payload = {
        client: { id: client.id, name: client.name },
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

    // 5. Pull shipments from ShipStation.
    const rawShipments = await fetchShipments(startDate, endDate);

    // 6. Filter by client according to billing_source.
    let matched = [];
    let storeMatched = false;
    let storeIds = [];

    if (billingSource === 'ss_cf1') {
      const cf1 = (client.ss_custom_field_1 || '').trim().toLowerCase();
      if (!cf1) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Client has billing_source=ss_cf1 but ss_custom_field_1 is empty' }),
        };
      }
      matched = rawShipments.filter((sh) => {
        const v = (sh.advancedOptions && sh.advancedOptions.customField1) || '';
        return String(v).trim().toLowerCase() === cf1;
      });
    } else if (billingSource === 'ss_store') {
      const storeName = (client.store_name || '').trim();
      if (!storeName) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Client has billing_source=ss_store but store_name is empty' }),
        };
      }
      storeIds = await resolveStoreIds(storeName, client.aliases);
      if (!storeIds.length) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: `No ShipStation store matched "${storeName}"` }),
        };
      }
      const idSet = new Set(storeIds);
      matched = rawShipments.filter((sh) => {
        const id = sh.advancedOptions && sh.advancedOptions.storeId;
        return id != null && idSet.has(String(id));
      });
      storeMatched = true;
    } else {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: `Unsupported billing_source: ${billingSource}` }),
      };
    }

    // 7. Keep only SHIPPED ones — those with a tracking number. Drop voids
    //    and shipments still being processed by the carrier.
    const shipped = matched.filter((sh) => sh.trackingNumber && !sh.voided);

    // 8. Project each shipment to the shape the portal needs (8 columns +
    //    extras for sorting/filtering).
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
        // ShipStation does not expose live delivery status in /shipments;
        // we present "Shipped" uniformly. Future work: hit a tracking
        // provider for live transit/delivered status.
        status: 'Shipped',
      };
    });

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
      client: { id: client.id, name: client.name },
      mode: billingSource,
      windowDays: WINDOW_DAYS,
      windowStart: startDate,
      windowEnd: endDate,
      lastSync: new Date().toISOString(),
      storeMatched,
      storeIds,
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
