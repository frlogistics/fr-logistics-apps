// netlify/functions/billing-shipstation.js
// PURPOSE: Fetch ShipStation data for billing period
// STRICT: Returns error if no valid filter provided — never returns unfiltered data

const SS = 'https://ssapi.shipstation.com';

// Fetch all pages from ShipStation endpoint
async function fetchAll(url, headers) {
  let page = 1, pages = 1, results = [];
  do {
    const sep = url.includes('?') ? '&' : '?';
    const res = await fetch(`${url}${sep}pageSize=500&page=${page}`, { headers });
    if (!res.ok) throw new Error(`ShipStation ${res.status}: ${await res.text()}`);
    const data = await res.json();
    results = results.concat(data.shipments || data.orders || []);
    pages = data.pages || 1;
    page++;
  } while (page <= pages && page <= 10);
  return results;
}

exports.handler = async (event) => {
  const h = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: h, body: '' };

  const key = process.env.SS_API_KEY;
  const sec = process.env.SS_API_SECRET;
  if (!key || !sec) return { statusCode: 500, headers: h, body: JSON.stringify({ error: 'SS credentials missing' }) };

  const auth = { 'Authorization': `Basic ${Buffer.from(`${key}:${sec}`).toString('base64')}` };
  const p = event.queryStringParameters || {};
  const start = (p.start || '').trim();
  const end   = (p.end   || '').trim();
  const store = (p.store || '').trim();
  const cf1   = (p.cf1   || '').trim();

  // ── Validate ────────────────────────────────────────────────────────────────
  if (!start || !end) return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'start and end required' }) };
  if (!store && !cf1) return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'store or cf1 required — no unfiltered requests allowed' }) };

  try {
    // ── Fetch all shipments in period (used by both modes) ───────────────────
    const allShipments = await fetchAll(
      `${SS}/shipments?shipDateStart=${start}&shipDateEnd=${end}`, auth
    );
    const allStoreNames = [...new Set(allShipments.map(s => s.storeName || 'Unknown'))].sort();

    // ══ MODE 1: Store filter ═════════════════════════════════════════════════
    if (store) {
      const pat      = store.toLowerCase();
      const filtered = allShipments.filter(s => (s.storeName || '').toLowerCase().includes(pat));
      const matched  = filtered.length > 0;

      return {
        statusCode: 200,
        headers: h,
        body: JSON.stringify({
          mode:         'store',
          store,
          count:        filtered.length,
          totalCount:   allShipments.length,
          carrierCost:  round(filtered.reduce((s, x) => s + (x.shipmentCost || 0), 0)),
          storeMatched: matched,
          storeNames:   allStoreNames,
        })
      };
    }

    // ══ MODE 2: Custom Field 1 filter ════════════════════════════════════════
    // Step A: Get ALL shipped orders with this CF1 tag (no date filter on orders)
    const orders = await fetchAll(
      `${SS}/orders?customField1=${encodeURIComponent(cf1)}&orderStatus=shipped`, auth
    );

    if (orders.length === 0) {
      return {
        statusCode: 200,
        headers: h,
        body: JSON.stringify({
          mode:        'cf1',
          cf1,
          count:       0,
          carrierCost: 0,
          totalCount:  allShipments.length,
          note:        `No shipped orders found with Custom Field 1 = "${cf1}". Tag orders in ShipStation.`,
        })
      };
    }

    // Step B: Cross-reference by orderId — only shipments that shipped in the period
    const orderIds = new Set(orders.map(o => o.orderId));
    const matched  = allShipments.filter(s => orderIds.has(s.orderId));

    return {
      statusCode: 200,
      headers: h,
      body: JSON.stringify({
        mode:         'cf1',
        cf1,
        count:        matched.length,
        ordersTagged: orders.length,
        totalCount:   allShipments.length,
        carrierCost:  round(matched.reduce((s, x) => s + (x.shipmentCost || 0), 0)),
      })
    };

  } catch (err) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: err.message }) };
  }
};

function round(n) { return Math.round(n * 100) / 100; }
