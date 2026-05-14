// netlify/functions/portal-orders-list.js
// FR-Logistics Client Portal — Paso 3
// Returns all orders (with items) for the client linked to ?portal_user=<email>
// Same pattern as clients-list.js / portal-dashboard.js

const ALLOWED_ORIGINS = [
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
  'https://apps.fr-logistics.net',
];

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };
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

  try {
    // 1. Resolve client by portal_user
    const clientRes = await fetch(
      `${SUPABASE_URL}/rest/v1/fr_clients?portal_user=eq.${encodeURIComponent(portalUser)}&select=id,name`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    if (!clientRes.ok) {
      const t = await clientRes.text();
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Supabase client lookup failed', detail: t }) };
    }
    const clients = await clientRes.json();
    if (!clients.length) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No client linked to this portal user' }) };
    }
    const client = clients[0];

    // 2. Fetch orders for that client, newest first, with nested items
    const ordersRes = await fetch(
      `${SUPABASE_URL}/rest/v1/client_orders` +
        `?client_id=eq.${client.id}` +
        `&select=id,order_number,status,recipient_name,recipient_phone,` +
        `address_line1,address_line2,city,state,postal_code,country_code,` +
        `shipping_service,notes_to_buyer,created_at,exported_at,` +
        `client_order_items(id,item_sku,item_name,item_quantity,item_unit_price,sku_validated)` +
        `&order=created_at.desc`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    if (!ordersRes.ok) {
      const t = await ordersRes.text();
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Supabase orders fetch failed', detail: t }) };
    }
    const orders = await ordersRes.json();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        client: { id: client.id, name: client.name },
        orders,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error', detail: String(err) }) };
  }
};
