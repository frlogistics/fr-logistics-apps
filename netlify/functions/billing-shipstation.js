// netlify/functions/billing-shipstation.js
// APPROACH: Fetch ALL shipments once, filter client-side using advancedOptions
// - Mode store: filter by storeId (resolved from stores list) 
// - Mode cf1:   filter by advancedOptions.customField1 (exact, case-insensitive)
// This avoids ShipStation /orders endpoint which does NOT support customField1 filtering

const SS = 'https://ssapi.shipstation.com';

async function fetchAll(url, headers) {
  let page = 1, pages = 1, out = [];
  do {
    const sep = url.includes('?') ? '&' : '?';
    const r = await fetch(`${url}${sep}pageSize=500&page=${page}`, { headers });
    if (!r.ok) throw new Error(`ShipStation ${r.status}: ${await r.text()}`);
    const d = await r.json();
    out = out.concat(d.shipments || d.orders || []);
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

  const auth = { 'Authorization': `Basic ${Buffer.from(`${key}:${sec}`).toString('base64')}` };
  const p     = event.queryStringParameters || {};
  const start = (p.start || '').trim();
  const end   = (p.end   || '').trim();
  const store = (p.store || '').trim();   // exact SS store name (e.g. "Daizzy Gear")
  const cf1   = (p.cf1   || '').trim();   // Custom Field 1 value (e.g. "MXS Overseas Ltd")

  if (!start || !end) return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'start and end required' }) };
  if (!store && !cf1) return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'store or cf1 required' }) };

  try {
    // ── Fetch stores list → build storeId→storeName map ───────────────────
    const storeMap = {};   // storeId (number) → storeName (string)
    const storeNameToId = {}; // storeName.lower → storeId
    try {
      const sr = await fetch(`${SS}/stores?showInactive=false`, { headers: auth });
      if (sr.ok) {
        const stores = await sr.json();
        (Array.isArray(stores) ? stores : []).forEach(s => {
          storeMap[s.storeId] = s.storeName || '';
          storeNameToId[(s.storeName || '').toLowerCase()] = s.storeId;
        });
      }
    } catch (_) {}

    // ── Fetch ALL shipments in billing period ─────────────────────────────
    const allShipments = await fetchAll(
      `${SS}/shipments?shipDateStart=${start}&shipDateEnd=${end}`, auth
    );

    // Enrich shipments with resolved storeName
    const shipments = allShipments.map(s => ({
      ...s,
      _storeName: s.storeName || storeMap[s.advancedOptions?.storeId] || '',
      _cf1: (s.advancedOptions?.customField1 || '').trim(),
    }));

    const allStoreNames = [...new Set(shipments.map(s => s._storeName).filter(Boolean))].sort();

    // ══ MODE 1: Filter by store name ═════════════════════════════════════
    if (store) {
      const pat      = store.toLowerCase();
      const filtered = shipments.filter(s => s._storeName.toLowerCase() === pat);
      const matched  = filtered.length > 0;

      return {
        statusCode: 200,
        headers: h,
        body: JSON.stringify({
          mode:         'store',
          store,
          count:        filtered.length,
          totalCount:   shipments.length,
          carrierCost:  round(filtered.reduce((s, x) => s + (x.shipmentCost || 0), 0)),
          storeMatched: matched,
          storeNames:   allStoreNames,
        })
      };
    }

    // ══ MODE 2: Filter by Custom Field 1 on shipments ════════════════════
    // advancedOptions.customField1 comes from the original order and is
    // included in every shipment record — no /orders API call needed
    const cf1Lower  = cf1.toLowerCase();
    const filtered  = shipments.filter(s => s._cf1.toLowerCase() === cf1Lower);
    const carrierCost = filtered.reduce((sum, s) => sum + (s.shipmentCost || 0), 0);

    if (filtered.length === 0) {
      return {
        statusCode: 200,
        headers: h,
        body: JSON.stringify({
          mode:        'cf1',
          cf1,
          count:       0,
          carrierCost: 0,
          totalCount:  shipments.length,
          storeNames:  allStoreNames,
          note: `No shipments found with Custom Field 1 = "${cf1}" in this period. Tag orders in ShipStation before generating labels.`,
        })
      };
    }

    return {
      statusCode: 200,
      headers: h,
      body: JSON.stringify({
        mode:        'cf1',
        cf1,
        count:       filtered.length,
        totalCount:  shipments.length,
        carrierCost: round(carrierCost),
        storeNames:  allStoreNames,
      })
    };

  } catch (err) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: err.message }) };
  }
};

function round(n) { return Math.round(n * 100) / 100; }
