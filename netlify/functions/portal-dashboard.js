// netlify/functions/portal-dashboard.js
// Client Portal — Phase 1 Step 2
// Resolves a logged-in portal user to their client record and returns
// a minimal dashboard payload (client name + order counts).
//
// Called cross-origin from https://fr-logistics.net/client
// Pattern mirrors clients-list.js (CORS allowlist + Supabase REST + service key).
//
// Query param:  ?portal_user=<email>   (the email of the authenticated Supabase user)

const ALLOWED_ORIGINS = [
  'https://apps.fr-logistics.net',
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
];

// --- "View as client" (internal use only) ----------------------------------
// warehouse@fr-logistics.net can add ?as_client=<fr_clients.id> to read the
// portal exactly as that client sees it. The parameter is honored ONLY for
// that email: any other caller's as_client is ignored and the lookup falls
// back to their own portal_user, so a client can never reach another client's
// data by adding it to the URL. Read-only by design — no write function
// (portal-order-create, portal-orders-bulk-create) accepts as_client, so an
// internal user cannot create an order while viewing as somebody else.
const PORTAL_ADMIN_EMAIL = 'warehouse@fr-logistics.net';
const AS_CLIENT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clientFilter(portalUser, params) {
  const asClient = String((params || {}).as_client || '').trim();
  const isAdmin =
    String(portalUser || '').trim().toLowerCase() === PORTAL_ADMIN_EMAIL;
  if (isAdmin && AS_CLIENT_UUID_RE.test(asClient)) {
    return `id=eq.${asClient}`;
  }
  return `portal_user=eq.${encodeURIComponent(portalUser)}`;
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin)
    ? origin
    : ALLOWED_ORIGINS[0];

  const headers = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase not configured' }) };

  const params = event.queryStringParameters || {};
  const portalUser = (params.portal_user || '').trim().toLowerCase();
  if (!portalUser)
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing portal_user' }) };

  const supaHeaders = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    // 1. Resolve the portal user to a client record in fr_clients.
    //    Uses eq (exact match) instead of ilike because PostgREST decodes
    //    '+' as space inside ilike filter values, which breaks lookups
    //    for emails containing '+' (e.g. josefuentes+mxs@fr-logistics.net
    //    becomes 'josefuentes mxs@fr-logistics.net' with a space). eq is
    //    not affected by this URL-decoding quirk.
    const clientUrl =
      `${SUPABASE_URL}/rest/v1/fr_clients` +
      `?select=id,name,company,store_name` +
      `&${clientFilter(portalUser, params)}`;

    const clientResp = await fetch(clientUrl, { headers: supaHeaders });
    if (!clientResp.ok)
      throw new Error(`Supabase fr_clients ${clientResp.status}: ${await clientResp.text()}`);

    const clients = await clientResp.json();
    if (!Array.isArray(clients) || clients.length === 0)
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ error: 'No client linked to this portal user' }),
      };

    const client = clients[0];

    // 2. Count this client's orders, grouped by status.
    //    Uses the Prefer: count=exact header against client_orders.
    const countFor = async (statusFilter) => {
      let url = `${SUPABASE_URL}/rest/v1/client_orders?select=id&client_id=eq.${client.id}`;
      if (statusFilter) url += `&status=eq.${statusFilter}`;
      const resp = await fetch(url, {
        headers: { ...supaHeaders, Prefer: 'count=exact' },
      });
      if (!resp.ok)
        throw new Error(`Supabase client_orders ${resp.status}: ${await resp.text()}`);
      // content-range looks like "0-24/25" or "*/0"
      const range = resp.headers.get('content-range') || '*/0';
      const total = parseInt(range.split('/')[1], 10);
      return Number.isNaN(total) ? 0 : total;
    };

    const [total, pending, processing, exported] = await Promise.all([
      countFor(null),
      countFor('pending'),
      countFor('processing'),
      countFor('exported'),
    ]);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        client: {
          id: client.id,
          name: client.name,
          company: client.company,
          store_name: client.store_name,
        },
        orders: { total, pending, processing, exported },
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: String(err.message || err) }),
    };
  }
};
