// ════════════════════════════════════════════════════════════════════════════
// ss-debug.js — TEMPORARY diagnostic endpoint for ShipStation
// 
// Returns raw ShipStation /shipments response for a date range, listing every
// unique storeName and order count. Use this to see what storeName ShipStation
// actually reports for our orders, so we can match it correctly in fr_clients.
//
// Endpoint:
//   GET /.netlify/functions/ss-debug?from=2026-04-01&to=2026-04-30
// 
// Returns:
//   { total_shipments, stores: [{storeName, count, sample_advanced_options}], ... }
// ════════════════════════════════════════════════════════════════════════════

const SS_KEY    = process.env.SS_API_KEY;
const SS_SECRET = process.env.SS_API_SECRET;
const SS_BASE   = "https://ssapi.shipstation.com";

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const from = params.from || '2026-04-01';
  const to   = params.to   || '2026-04-30';

  const env_check = {
    has_ss_key:    !!SS_KEY,
    has_ss_secret: !!SS_SECRET,
    ss_key_length: SS_KEY ? SS_KEY.length : 0,
  };

  if (!SS_KEY || !SS_SECRET) {
    return resp(500, {
      error: "ShipStation env vars missing",
      env_check,
      tip: "Add SS_API_KEY and SS_API_SECRET to Netlify env vars",
    });
  }

  const auth = Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString('base64');
  const headers = { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' };

  try {
    let page = 1, totalPages = 1;
    let allShipments = [];
    do {
      const url = `${SS_BASE}/shipments?shipDateStart=${from}&shipDateEnd=${to}&pageSize=500&page=${page}`;
      const r = await fetch(url, { headers });
      if (!r.ok) {
        const errBody = await r.text();
        return resp(r.status, {
          error: "ShipStation API call failed",
          status: r.status,
          response: errBody.slice(0, 500),
          env_check,
        });
      }
      const d = await r.json();
      allShipments = allShipments.concat(d.shipments || []);
      totalPages = d.pages || 1;
      page++;
    } while (page <= totalPages && page <= 5);

    // Group by storeName and count
    const byStore = {};
    allShipments.forEach(s => {
      const name = s.storeName || '(null)';
      if (!byStore[name]) {
        byStore[name] = {
          storeName:               name,
          count:                   0,
          totalCarrierCost:        0,
          sample_storeId:          s.advancedOptions?.storeId,
          sample_customField1:     s.advancedOptions?.customField1,
          sample_orderNumber:      s.orderNumber,
        };
      }
      byStore[name].count += 1;
      byStore[name].totalCarrierCost += (s.shipmentCost || 0);
    });

    const stores = Object.values(byStore).sort((a, b) => b.count - a.count);

    return resp(200, {
      env_check,
      date_range: { from, to },
      total_shipments: allShipments.length,
      total_pages: totalPages,
      stores,
    });
  } catch (err) {
    return resp(500, { error: err.message, env_check });
  }
};

function resp(statusCode, payload) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
}
