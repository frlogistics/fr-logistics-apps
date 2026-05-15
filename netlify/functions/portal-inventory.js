// netlify/functions/portal-inventory.js
// FR-Logistics Client Portal — Fase 2, Inventory tab
// Returns the inventory in SkuVault that belongs to the client linked to
// ?portal_user=<email>, filtered by the SkuVault product field "Client"
// matching fr_clients.name exactly.
//
// Pattern: calques inventory.js (the internal dashboard's SkuVault proxy),
// adds the portal_user → client resolution from portal-orders-list.js, and
// scopes everything to that client.
//
// CORS, auth and SkuVault calls follow the same shape as the existing
// portal-* functions, so deploy/env vars don't need any changes:
//   - SUPABASE_URL, SUPABASE_SERVICE_KEY (already set)
//   - SKUVAULT_TENANT_TOKEN (already set, format "tenant|user")

const ALLOWED_ORIGINS = [
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
  'https://apps.fr-logistics.net',
];

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SKUVAULT_BASE = 'https://app.skuvault.com/api';

const CACHE_TTL_MS = 5 * 60 * 1000;
// Cache keyed by client name. We never serve one client's cache to another.
const cache = new Map(); // clientName → { data, ts }

const LOW_STOCK_THRESHOLD = 10;

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };
}

async function sbFetch(path) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
}

// Pull all products from SkuVault in a single call (PageSize 10000), matching
// the pattern used by inventory.js. SkuVault's PageNumber semantics are
// unreliable across endpoints and our loop-based pagination was producing
// duplicates that doubled the result count. A single large page is simpler
// and consistent with the rest of the codebase.
async function fetchAllProducts(tenantToken, userToken) {
  const res = await fetch(`${SKUVAULT_BASE}/products/getProducts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      TenantToken: tenantToken,
      UserToken: userToken,
      PageNumber: 0,
      PageSize: 10000,
    }),
  });
  if (!res.ok) throw new Error(`SkuVault getProducts ${res.status}`);
  const data = await res.json();
  return data.Products || [];
}

async function fetchQuantities(tenantToken, userToken) {
  const res = await fetch(`${SKUVAULT_BASE}/inventory/getItemQuantities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      TenantToken: tenantToken,
      UserToken: userToken,
      PageNumber: 0,
      PageSize: 10000,
    }),
  });
  if (!res.ok) throw new Error(`SkuVault getItemQuantities ${res.status}`);
  const data = await res.json();
  return data.Items || [];
}

async function fetchLocations(tenantToken, userToken) {
  const res = await fetch(`${SKUVAULT_BASE}/inventory/getInventoryByLocation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      TenantToken: tenantToken,
      UserToken: userToken,
      PageNumber: 0,
      PageSize: 10000,
    }),
  });
  if (!res.ok) return {}; // locations are nice-to-have, not critical
  const data = await res.json();
  return data.Items || {};
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

  const svToken = process.env.SKUVAULT_TENANT_TOKEN;
  if (!svToken) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'SKUVAULT_TENANT_TOKEN not configured' }) };
  }
  const [tenantToken, userToken] = svToken.split('|');

  try {
    // 1. Resolve client by portal_user.
    const clientRes = await sbFetch(
      `fr_clients?portal_user=eq.${encodeURIComponent(portalUser)}&select=id,name`
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
    const clientName = client.name;

    // 2. Per-client cache check.
    const cached = cache.get(clientName);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return {
        statusCode: 200,
        headers: { ...headers, 'X-Cache': 'HIT' },
        body: JSON.stringify(cached.data),
      };
    }

    // 3. Pull everything from SkuVault in parallel.
    //    - All products (paginated) — we need .Client to filter.
    //    - All quantities (single call up to 10k) — on hand, available, etc.
    //    - All locations (single call up to 10k) — warehouse codes per SKU.
    const [allProducts, allQuantities, locItems] = await Promise.all([
      fetchAllProducts(tenantToken, userToken),
      fetchQuantities(tenantToken, userToken),
      fetchLocations(tenantToken, userToken),
    ]);

    // 4. Filter products by exact match on Client field, AND exclude alternate
    //    SKUs. In SkuVault, a product can have multiple alternate SKUs sharing
    //    the same physical stock (one label per sales channel: Amazon, eBay,
    //    Shopify, etc.). The catalog UI and CSV reports show PRIMARY SKUs only,
    //    aggregating alternates under their primary. But getProducts returns
    //    primary + every alternate as separate rows (flagged with
    //    IsAlternateSKU: true). Counting them all multi-counts stock — for
    //    example, JDK's 225 primaries become 472 rows if alternates are kept.
    //    See memory: "SkuVault Alternate SKUs" and the SkuVault docs on
    //    "Alternate SKUs" for full background.
    const myProducts = allProducts.filter(
      (p) => p.Client === clientName && p.IsAlternateSKU !== true
    );
    const mySkuSet = new Set(myProducts.map((p) => p.Sku));

    // 5. Build a quantities lookup keyed by SKU.
    const qtyBySku = new Map();
    for (const q of allQuantities) {
      if (q.Sku) qtyBySku.set(q.Sku, q);
    }

    // 6. Build a locations map keyed by SKU code → array of WarehouseCodes.
    const locBySku = {};
    for (const [skuCode, locs] of Object.entries(locItems)) {
      if (!Array.isArray(locs)) continue;
      locBySku[skuCode] = [...new Set(locs.map((l) => l.WarehouseCode).filter(Boolean))];
    }

    // 7. Project each of the client's products to the shape the portal needs.
    //    We drive iteration off myProducts (the filtered set), not off the
    //    full quantities list, so we never accidentally include another
    //    client's SKU just because it has a quantity row.
    const skus = myProducts.map((p) => {
      const q = qtyBySku.get(p.Sku) || {};
      const onHand = q.TotalOnHand != null ? q.TotalOnHand : (p.QuantityOnHand || 0);
      const allocated = q.HeldQuantity || q.PickedQuantity || p.QuantityOnHold || 0;
      const available = q.AvailableQuantity != null
        ? q.AvailableQuantity
        : (p.QuantityAvailable != null ? p.QuantityAvailable : Math.max(0, onHand - allocated));
      const locations = locBySku[p.Sku] || [];

      let status = 'ok';
      if (available <= 0) status = 'out';
      else if (available < LOW_STOCK_THRESHOLD) status = 'low';

      return {
        sku: p.Sku || '',
        title: p.Description || p.ShortDescription || p.Sku || '',
        brand: p.Brand || '',
        classification: p.Classification || '',
        onHand,
        allocated,
        available,
        status,
        locations,
      };
    }).filter((s) => s.sku); // drop any malformed row without a SKU

    // Sort: out of stock first (most urgent), then low, then by on-hand desc.
    const statusOrder = { out: 0, low: 1, ok: 2 };
    skus.sort((a, b) => {
      const so = statusOrder[a.status] - statusOrder[b.status];
      if (so !== 0) return so;
      return b.onHand - a.onHand;
    });

    // 8. KPIs.
    const kpis = {
      totalSKUs: skus.length,
      totalUnits: skus.reduce((s, x) => s + (x.onHand || 0), 0),
      lowStock: skus.filter((s) => s.status === 'low').length,
      outOfStock: skus.filter((s) => s.status === 'out').length,
    };

    const payload = {
      client: { id: client.id, name: client.name },
      lastSync: new Date().toISOString(),
      lowStockThreshold: LOW_STOCK_THRESHOLD,
      kpis,
      skus,
    };

    cache.set(clientName, { data: payload, ts: Date.now() });

    return {
      statusCode: 200,
      headers: { ...headers, 'X-Cache': 'MISS' },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    // If we have a stale cache for this client, serve it rather than failing.
    const portalUser = (event.queryStringParameters || {}).portal_user;
    // We don't have clientName here if the lookup itself failed, so check by
    // iterating cache — only one entry maps to this portal_user implicitly.
    // Simpler: just return the error; portal will show a friendly message.
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'Failed to fetch inventory', detail: String(err) }),
    };
  }
};
