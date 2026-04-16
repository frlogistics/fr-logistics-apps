// netlify/functions/billing-shipstation.js
// Returns shipped orders + carrier costs from ShipStation for a billing period
// Filters by store name — returns 0 if no match (no fallback to all stores)

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
  if (!apiKey || !apiSecret) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ShipStation credentials not configured' }) };
  }

  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  const ssHeaders = { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' };

  const p     = event.queryStringParameters || {};
  const start = p.start || '';
  const end   = p.end   || '';
  const store = (p.store || '').trim();

  if (!start || !end) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'start and end required (YYYY-MM-DD)' }) };
  }

  try {
    // Fetch all shipments in period (paginated)
    let page = 1, totalPages = 1;
    let allShipments = [];
    do {
      const url = `${SS_BASE}/shipments?shipDateStart=${start}&shipDateEnd=${end}&pageSize=500&page=${page}`;
      const resp = await fetch(url, { headers: ssHeaders });
      if (!resp.ok) {
        const txt = await resp.text();
        return { statusCode: resp.status, headers, body: txt };
      }
      const data = await resp.json();
      allShipments = allShipments.concat(data.shipments || []);
      totalPages = data.pages || 1;
      page++;
    } while (page <= totalPages && page <= 5);

    // Get store list for storeId → storeName mapping
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

    // All unique store names in this period — helps diagnose filter issues
    const storeNames = [...new Set(allShipments.map(s => s.storeName || 'Unknown'))].sort();

    // Filter by store — NO fallback. If no match → count = 0, user enters manually
    let filtered = allShipments;
    let storeMatched = !store; // if no store requested, all match

    if (store) {
      const pat = store.toLowerCase().trim();
      filtered = allShipments.filter(s => {
        const sName   = (s.storeName || '').toLowerCase();
        const sId     = String(s.advancedOptions?.storeId || '');
        const sIdName = storeMap[sId] || '';
        return sName.includes(pat) || sIdName.includes(pat);
      });
      storeMatched = filtered.length > 0;
      // If no match: filtered stays empty — count = 0, no fallback
    }

    const carrierCost      = filtered.reduce((sum, s) => sum + (s.shipmentCost || 0), 0);
    const totalCarrierCost = allShipments.reduce((sum, s) => sum + (s.shipmentCost || 0), 0);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        count:            filtered.length,
        totalCount:       allShipments.length,
        carrierCost:      Math.round(carrierCost * 100) / 100,
        totalCarrierCost: Math.round(totalCarrierCost * 100) / 100,
        storeMatched,
        storeNames,
        start, end, store,
      })
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
