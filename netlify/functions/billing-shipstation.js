// netlify/functions/billing-shipstation.js
// FR-Logistics Billing — ShipStation data fetcher
// TWO MODES:
//   Mode 1 (integrated): store param → filter shipments by storeName
//   Mode 2 (manual):     customField1 param → orders by CF1, cross-ref shipments for carrier cost

const SS_BASE = 'https://ssapi.shipstation.com';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const apiKey    = process.env.SS_API_KEY;
  const apiSecret = process.env.SS_API_SECRET;
  if (!apiKey || !apiSecret)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ShipStation credentials not configured' }) };

  const auth      = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  const ssHeaders = { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' };

  const p            = event.queryStringParameters || {};
  const start        = p.start        || '';
  const end          = p.end          || '';
  const store        = (p.store        || '').trim();
  const customField1 = (p.customField1 || '').trim();

  if (!start || !end)
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'start and end required (YYYY-MM-DD)' }) };

  // ─── Helper: paginated fetch ────────────────────────────────────────────────
  async function fetchAllPages(urlBase) {
    let page = 1, totalPages = 1, results = [];
    do {
      const sep = urlBase.includes('?') ? '&' : '?';
      const resp = await fetch(`${urlBase}${sep}pageSize=500&page=${page}`, { headers: ssHeaders });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`ShipStation ${resp.status}: ${txt.slice(0, 200)}`);
      }
      const data = await resp.json();
      // Orders endpoint returns data.orders, shipments returns data.shipments
      results = results.concat(data.orders || data.shipments || []);
      totalPages = data.pages || 1;
      page++;
    } while (page <= totalPages && page <= 10); // max 5000 records
    return results;
  }

  try {
    // ══════════════════════════════════════════════════════════════════════════
    // MODE 1 — Integrated store: filter by storeName
    // ══════════════════════════════════════════════════════════════════════════
    if (store) {
      // Get all shipments in period
      const allShipments = await fetchAllPages(
        `${SS_BASE}/shipments?shipDateStart=${start}&shipDateEnd=${end}`
      );

      // Get store list for ID → name mapping
      let storeMap = {};
      try {
        const stResp = await fetch(`${SS_BASE}/stores?showInactive=false`, { headers: ssHeaders });
        if (stResp.ok) {
          const stores = await stResp.json();
          (Array.isArray(stores) ? stores : []).forEach(s => {
            storeMap[String(s.storeId)] = (s.storeName || '').toLowerCase();
          });
        }
      } catch(_) {}

      const allStoreNames = [...new Set(allShipments.map(s => s.storeName || 'Unknown'))].sort();

      const pat = store.toLowerCase();
      const filtered = allShipments.filter(s => {
        const sName   = (s.storeName || '').toLowerCase();
        const sId     = String(s.advancedOptions?.storeId || '');
        const sIdName = storeMap[sId] || '';
        return sName.includes(pat) || sIdName.includes(pat);
      });

      const storeMatched  = filtered.length > 0;
      const carrierCost   = filtered.reduce((sum, s) => sum + (s.shipmentCost || 0), 0);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          mode:             'store',
          count:            filtered.length,
          totalCount:       allShipments.length,
          carrierCost:      Math.round(carrierCost * 100) / 100,
          storeMatched,
          storeNames:       allStoreNames,
          start, end, store,
        })
      };
    }

    // ══════════════════════════════════════════════════════════════════════════
    // MODE 2 — Manual orders: filter by Custom Field 1, cross-ref shipments
    // ══════════════════════════════════════════════════════════════════════════
    if (customField1) {
      // Step A: Get orders tagged with this client's Custom Field 1
      // Use modifyDate range so shipped orders in the period are captured
      const ordersUrl = `${SS_BASE}/orders?customField1=${encodeURIComponent(customField1)}&orderStatus=shipped&modifyDateStart=${start}&modifyDateEnd=${end}`;
      const orders = await fetchAllPages(ordersUrl);
      const orderCount = orders.length;

      if (orderCount === 0) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            mode:         'customField1',
            count:         0,
            totalCount:    0,
            carrierCost:   0,
            customField1,
            note:          `No shipped orders found with Custom Field 1 = "${customField1}" in this period. Make sure orders are tagged in ShipStation.`,
            start, end,
          })
        };
      }

      // Step B: Get all shipments in the period and cross-reference by orderId
      const orderIdSet    = new Set(orders.map(o => o.orderId));
      const allShipments  = await fetchAllPages(
        `${SS_BASE}/shipments?shipDateStart=${start}&shipDateEnd=${end}`
      );
      const matchedShipments = allShipments.filter(s => orderIdSet.has(s.orderId));
      const carrierCost      = matchedShipments.reduce((sum, s) => sum + (s.shipmentCost || 0), 0);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          mode:              'customField1',
          count:             orderCount,
          totalCount:        allShipments.length,
          carrierCost:       Math.round(carrierCost * 100) / 100,
          matchedShipments:  matchedShipments.length,
          customField1,
          start, end,
        })
      };
    }

    // ══════════════════════════════════════════════════════════════════════════
    // NO FILTER — return summary only (no client filter applied)
    // ══════════════════════════════════════════════════════════════════════════
    const allShipments  = await fetchAllPages(
      `${SS_BASE}/shipments?shipDateStart=${start}&shipDateEnd=${end}`
    );
    const allStoreNames = [...new Set(allShipments.map(s => s.storeName || 'Unknown'))].sort();
    const totalCost     = allShipments.reduce((sum, s) => sum + (s.shipmentCost || 0), 0);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        mode:        'unfiltered',
        count:        allShipments.length,
        totalCount:   allShipments.length,
        carrierCost:  Math.round(totalCost * 100) / 100,
        storeNames:   allStoreNames,
        note:         'No store or customField1 filter applied. Configure ssStore or ssCustomField1 in client settings.',
        start, end,
      })
    };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
