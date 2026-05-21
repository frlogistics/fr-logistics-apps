// netlify/functions/portal-tracking.js
// 🔧 DEBUG v7 — diagnostica por qué v6 trae 42 cuando deberían ser 14
//
// Pass ?debug=1 to receive:
//   - ordersCount: cuántas órdenes devolvió /orders?customField1=...
//   - ordersAfterFilter: cuántas pasaron defense-in-depth (CF1 verify)
//   - orderIdsCount: tamaño del Set de orderIds
//   - allShipmentsCount: total shipments en la ventana de 30 días
//   - matchedShipmentsCount: shipments cuyo orderId está en el Set
//   - withTrackingCount: matched que tienen trackingNumber
//   - sampleOrders: primeras 3 órdenes (orderId, orderNumber, CF1)
//   - sampleMatchedShipments: primeros 5 shipments matched (orderId, orderNumber, tracking, CF1 from advancedOptions)
//   - orphanShipments: shipments que matchean orderId pero su orderNumber NO está en la lista de Wix/MXS (señal de cruce mal)

const ALLOWED_ORIGINS = ['https://fr-logistics.net','https://www.fr-logistics.net','https://apps.fr-logistics.net'];
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SS_BASE = 'https://ssapi.shipstation.com';
const SS_API_KEY = process.env.SS_API_KEY;
const SS_API_SECRET = process.env.SS_API_SECRET;
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
  return { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json' };
}
function fmtDate(d) { return d.toISOString().slice(0, 10); }

async function sbFetch(path) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
}

async function fetchOrders(filterParams) {
  const all = [];
  let page = 1;
  while (page <= 10) {
    const params = new URLSearchParams({ ...filterParams, pageSize: '500', page: String(page) });
    const res = await fetch(`${SS_BASE}/orders?${params.toString()}`, { headers: ssHeaders() });
    if (!res.ok) throw new Error(`/orders ${res.status}`);
    const data = await res.json();
    const orders = data.orders || [];
    all.push(...orders);
    if (page >= (data.pages || 1) || orders.length < 500) break;
    page++;
  }
  return all;
}

async function fetchShipments(startDate, endDate) {
  const all = [];
  let page = 1;
  while (page <= 10) {
    const url = `${SS_BASE}/shipments?shipDateStart=${startDate}&shipDateEnd=${endDate}&pageSize=500&page=${page}`;
    const res = await fetch(url, { headers: ssHeaders() });
    if (!res.ok) throw new Error(`/shipments ${res.status}`);
    const data = await res.json();
    const shipments = data.shipments || [];
    all.push(...shipments);
    if (page >= (data.pages || 1) || shipments.length < 500) break;
    page++;
  }
  return all;
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const headers = corsHeaders(origin);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const qs = event.queryStringParameters || {};
  const portalUser = qs.portal_user;
  const isDebug = qs.debug === '1';

  if (!portalUser) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing portal_user' }) };

  try {
    const clientRes = await sbFetch(
      `fr_clients?portal_user=eq.${encodeURIComponent(portalUser)}&select=id,name,company,billing_source,ss_custom_field_1,store_name,aliases`
    );
    const clients = await clientRes.json();
    if (!clients.length) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };

    const client = clients[0];
    const cf1 = (client.ss_custom_field_1 || '').trim();
    const cf1Lower = cf1.toLowerCase();
    const displayName = client.company || client.name;

    const now = new Date();
    const start = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const startDate = fmtDate(start);
    const endDate = fmtDate(now);

    // Step 1: get orders matching CF1
    const orders = await fetchOrders({
      customField1: cf1,
      orderStatus: 'shipped',
      modifyDateStart: startDate,
      modifyDateEnd: endDate,
    });

    // Step 2: defense-in-depth filter
    const matchingOrders = orders.filter((o) => {
      const v = (o.advancedOptions && o.advancedOptions.customField1) || '';
      return String(v).trim().toLowerCase() === cf1Lower;
    });

    const orderIdSet = new Set(matchingOrders.map((o) => o.orderId).filter(Boolean));
    const orderNumberSetFromOrders = new Set(matchingOrders.map((o) => o.orderNumber).filter(Boolean));

    // Step 3: get shipments
    const allShipments = await fetchShipments(startDate, endDate);

    // Step 4: match by orderId (v6 logic)
    const matchedByOrderId = allShipments.filter((sh) => orderIdSet.has(sh.orderId));
    const matchedWithTracking = matchedByOrderId.filter((sh) => sh.trackingNumber && !sh.voided);

    // Step 5: also compute match by orderNumber for comparison
    const matchedByOrderNumber = allShipments.filter((sh) => orderNumberSetFromOrders.has(sh.orderNumber));

    // Step 6: find "orphans" — shipments whose orderId matches but whose
    // orderNumber is NOT in the MXS list (would indicate orderId collision
    // or some other bug)
    const orphans = matchedByOrderId.filter((sh) => !orderNumberSetFromOrders.has(sh.orderNumber));

    if (isDebug) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          client: { id: client.id, name: displayName, cf1 },
          window: { startDate, endDate },
          step1_orders: {
            count: orders.length,
            sampleFirst3: orders.slice(0, 3).map((o) => ({
              orderId: o.orderId,
              orderNumber: o.orderNumber,
              modifyDate: o.modifyDate,
              orderStatus: o.orderStatus,
              cf1FromAdvOpts: o.advancedOptions && o.advancedOptions.customField1,
            })),
          },
          step2_afterDefenseFilter: {
            count: matchingOrders.length,
            orderIdSetSize: orderIdSet.size,
            orderNumberSetSize: orderNumberSetFromOrders.size,
          },
          step3_allShipments: {
            count: allShipments.length,
          },
          step4_matchedByOrderId: {
            count: matchedByOrderId.length,
            withTracking: matchedWithTracking.length,
          },
          step5_matchedByOrderNumber: {
            count: matchedByOrderNumber.length,
          },
          step6_orphans: {
            count: orphans.length,
            description: 'shipments whose orderId is in MXS set but orderNumber is NOT (collision indicator)',
            samples: orphans.slice(0, 5).map((sh) => ({
              orderId: sh.orderId,
              orderNumber: sh.orderNumber,
              trackingNumber: sh.trackingNumber,
              recipientName: sh.shipTo && sh.shipTo.name,
              storeId: sh.advancedOptions && sh.advancedOptions.storeId,
            })),
          },
          sampleMatchedShipments: matchedWithTracking.slice(0, 5).map((sh) => ({
            orderId: sh.orderId,
            orderNumber: sh.orderNumber,
            trackingNumber: sh.trackingNumber,
            shipDate: sh.shipDate,
            recipientName: sh.shipTo && sh.shipTo.name,
            storeId: sh.advancedOptions && sh.advancedOptions.storeId,
            cf1OnShipment: sh.advancedOptions && sh.advancedOptions.customField1,
          })),
        }, null, 2),
      };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ totalShipments: matchedWithTracking.length }) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: String(err) }) };
  }
};
