// netlify/functions/portal-client-config.js
// FR-Logistics Client Portal — client-specific config endpoint
//
// Returns the per-client configuration the portal frontend needs to render
// itself correctly (CSV template defaults, etc.). Kept separate from
// portal-dashboard so we can call it once at login and reuse the result
// across tabs — and so adding more client config later (rate codes,
// order-number prefixes, allowed carriers, etc.) doesn't bloat dashboard.
//
// GET ?portal_user=<email>
//   -> { client: {id, name, company}, csv_defaults: {...} }
//
// Pattern mirrors portal-dashboard.js: lookup by portal_user (eq, not ilike,
// because PostgREST decodes '+' as a space and breaks plus-aliased emails
// like josefuentes+mxs@fr-logistics.net).

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

async function sbFetch(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      ...(opts.headers || {}),
    },
  });
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const headers = corsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const portalUser = (event.queryStringParameters || {}).portal_user;
  if (!portalUser) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing portal_user' }) };
  }

  try {
    const res = await sbFetch(
      `fr_clients?portal_user=eq.${encodeURIComponent(portalUser)}&select=id,name,company,csv_defaults`
    );
    if (!res.ok) {
      const detail = await res.text();
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Client lookup failed', detail }) };
    }
    const rows = await res.json();
    if (!rows.length) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No client linked to this portal user' }) };
    }
    const c = rows[0];
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        client: { id: c.id, name: c.name || '', company: c.company || '' },
        csv_defaults: c.csv_defaults || {},
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error', detail: String(err) }) };
  }
};
