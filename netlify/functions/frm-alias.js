// netlify/functions/frm-alias.js
// FR Mobile — Locations: resolve a scanned code (FNSKU / GTIN / alias) to its
// primary SKU via wh_sku_aliases. Read-only, service key server-side.

const ALLOWED_ORIGINS = [
  'https://apps.fr-logistics.net',
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
];

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
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

  const code = ((event.queryStringParameters || {}).code || '').trim();
  if (!code) return { statusCode: 400, headers, body: JSON.stringify({ error: 'code is required' }) };

  try {
    const url = `${SUPABASE_URL}/rest/v1/wh_fnsku_map?code=eq.${encodeURIComponent(code)}&select=sku,code_type&limit=1`;
    const resp = await fetch(url, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    if (!resp.ok) throw new Error(`Supabase ${resp.status}: ${await resp.text()}`);
    const rows = await resp.json();
    if (rows && rows[0]) {
      return { statusCode: 200, headers, body: JSON.stringify({ code, primary_sku: rows[0].sku, alias_type: rows[0].code_type }) };
    }
    // No mapping found — the code may already be a merchant SKU
    return { statusCode: 200, headers, body: JSON.stringify({ code, primary_sku: null }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
