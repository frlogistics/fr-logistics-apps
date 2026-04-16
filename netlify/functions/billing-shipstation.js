// netlify/functions/billing-shipstation.js
// Returns shipped orders from ShipStation for a custom date range
// Used by billing.html — separate from kpi-dash to avoid breaking it

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
  const ssHeaders = {
    'Authorization': `Basic ${auth}`,
    'Content-Type': 'application/json',
  };

  const p      = event.queryStringParameters || {};
  const start  = p.start  || '';
  const end    = p.end    || '';
  const store  = p.store  || ''; // optional store name filter

  if (!start || !end) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'start and end params required (YYYY-MM-DD)' }) };
  }

  try {
    // Fetch shipments in date range — paginate if needed
    let page = 1;
    let allShipments = [];
    let totalPages = 1;

    do {
      const url = `${SS_BASE}/shipments?shipDateStart=${start}&shipDateEnd=${end}&pageSize=500&page=${page}`;
      const resp = await fetch(url, { headers: ssHeaders });

      if (!resp.ok) {
        const errText = await resp.text();
        return { statusCode: resp.status, headers, body: errText };
      }

      const data = await resp.json();
      const shipments = data.shipments || [];
      allShipments = allShipments.concat(shipments);
      totalPages = data.pages || 1;
      page++;
    } while (page <= totalPages && page <= 5); // max 5 pages = 2500 shipments

    // Calculate total carrier cost
    const totalCarrierCost = allShipments.reduce((sum, s) => sum + (s.shipmentCost || 0), 0);

    // Filter by store if provided
    let filtered = allShipments;
    if (store) {
      const pat = store.toLowerCase();
      filtered = allShipments.filter(s =>
        (s.storeName     || '').toLowerCase().includes(pat) ||
        (s.advancedOptions?.storeId || '') === pat
      );
      // If filter yields 0, return all (store name might not match)
      if (filtered.length === 0) filtered = allShipments;
    }

    const filteredCarrierCost = filtered.reduce((sum, s) => sum + (s.shipmentCost || 0), 0);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        count:             filtered.length,
        totalCount:        allShipments.length,
        carrierCost:       Math.round(filteredCarrierCost * 100) / 100,
        totalCarrierCost:  Math.round(totalCarrierCost * 100) / 100,
        start, end, store,
        shipments: filtered.slice(0, 10), // first 10 for debugging
      })
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
