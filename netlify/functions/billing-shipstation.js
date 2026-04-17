// netlify/functions/billing-shipstation.js
// Mode 1 (store): filter shipments by storeId from stores list
// Mode 2 (cf1):   get ALL recent orders, filter by advancedOptions.customField1 client-side,
//                 then cross-reference with period shipments by orderId
//
// WHY client-side filter on orders (not shipments):
// - ShipStation /orders?customField1= API filter does NOT work (returns all orders regardless)
// - shipments.advancedOptions.customField1 is captured at label-creation time (before CF1 was set)
// - orders.advancedOptions.customField1 reflects the CURRENT state after retroactive tagging

const SS = 'https://ssapi.shipstation.com';

async function ssGet(url, auth) {
  const r = await fetch(url, { headers: auth });
  if (!r.ok) throw new Error(`SS ${r.status}: ${await r.text()}`);
  return r.json();
}

async function fetchAllPages(url, auth) {
  let page = 1, pages = 1, out = [];
  do {
    const sep = url.includes('?') ? '&' : '?';
    const d   = await ssGet(`${url}${sep}pageSize=500&page=${page}`, auth);
    out   = out.concat(d.shipments || d.orders || []);
    pages = d.pages || 1;
    page++;
  } while (page <= pages && page <= 10);
  return out;
}

exports.handler = async (event) => {
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: h, body: '' };

  const key = process.env.SS_API_KEY;
  const sec = process.env.SS_API_SECRET;
  if (!key || !sec) return { statusCode: 500, headers: h, body: JSON.stringify({ error: 'SS credentials missing' }) };

  const auth  = { 'Authorization': `Basic ${Buffer.from(`${key}:${sec}`).toString('base64')}` };
  const p     = event.queryStringParameters || {};
  const start = (p.start || '').trim();
  const end   = (p.end   || '').trim();
  const store = (p.store || '').trim();
  const cf1   = (p.cf1   || '').trim();

  if (!start || !end)      return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'start and end required' }) };
  if (!store && !cf1)      return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'store or cf1 required' }) };

  try {
    // ── Always fetch period shipments (used by both modes) ────────────────
    const [allShipments, storeList] = await Promise.all([
      fetchAllPages(`${SS}/shipments?shipDateStart=${start}&shipDateEnd=${end}`, auth),
      ssGet(`${SS}/stores?showInactive=false`, auth).catch(() => []),
    ]);

    // Build storeId → storeName map
    const storeMap = {};
    (Array.isArray(storeList) ? storeList : []).forEach(s => {
      storeMap[s.storeId] = (s.storeName || '').toLowerCase();
    });

    // Resolve storeName for each shipment (use stored name or resolve via storeId)
    const enriched = allShipments.map(s => ({
      ...s,
      _store: (s.storeName || storeMap[s.advancedOptions?.storeId] || '').toLowerCase(),
    }));

    const allStoreNames = [...new Set(enriched.map(s => s._store).filter(Boolean))].sort();

    // ══ MODE 1: Store filter ═══════════════════════════════════════════════
    if (store) {
      const pat      = store.toLowerCase();
      const filtered = enriched.filter(s => s._store === pat);
      const matched  = filtered.length > 0;

      return {
        statusCode: 200,
        headers: h,
        body: JSON.stringify({
          mode:         'store',
          store,
          count:        filtered.length,
          totalCount:   enriched.length,
          carrierCost:  round(filtered.reduce((s, x) => s + (x.shipmentCost || 0), 0)),
          storeMatched: matched,
          storeNames:   allStoreNames,
        })
      };
    }

    // ══ MODE 2: Custom Field 1 filter ══════════════════════════════════════
    // Step A: Get ALL shipped orders and filter by CF1 on the order object
    // This reads the CURRENT CF1 value — works even if tagged after label creation
    const allOrders = await fetchAllPages(
      `${SS}/orders?orderStatus=shipped`, auth
    );

    const cf1Lower = cf1.toLowerCase();
    const matchedOrders = allOrders.filter(o =>
      (o.advancedOptions?.customField1 || '').toLowerCase() === cf1Lower
    );

    if (matchedOrders.length === 0) {
      return {
        statusCode: 200,
        headers: h,
        body: JSON.stringify({
          mode:        'cf1',
          cf1,
          count:       0,
          carrierCost: 0,
          totalCount:  enriched.length,
          storeNames:  allStoreNames,
          note:        `No shipped orders found with Custom Field 1 = "${cf1}". Tag orders in ShipStation.`,
        })
      };
    }

    // Step B: Cross-reference with period shipments by orderId
    const orderIdSet       = new Set(matchedOrders.map(o => o.orderId));
    const matchedShipments = enriched.filter(s => orderIdSet.has(s.orderId));
    const carrierCost      = matchedShipments.reduce((sum, s) => sum + (s.shipmentCost || 0), 0);

    return {
      statusCode: 200,
      headers: h,
      body: JSON.stringify({
        mode:         'cf1',
        cf1,
        count:        matchedShipments.length,
        ordersTagged: matchedOrders.length,
        totalCount:   enriched.length,
        carrierCost:  round(carrierCost),
        storeNames:   allStoreNames,
      })
    };

  } catch (err) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: err.message }) };
  }
};

function round(n) { return Math.round(n * 100) / 100; }
