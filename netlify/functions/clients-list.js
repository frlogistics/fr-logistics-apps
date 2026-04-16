// netlify/functions/clients-list.js
// Returns all clients from fr_clients table
// Used by billing.html, onboarding.html, and any app needing client data

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase not configured' }) };

  const params = event.queryStringParameters || {};
  const status = params.status || null; // optional: filter by status

  let url = `${SUPABASE_URL}/rest/v1/fr_clients?select=*&order=name.asc`;
  if (status) url += `&status=eq.${encodeURIComponent(status)}`;

  try {
    const resp = await fetch(url, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      }
    });
    if (!resp.ok) throw new Error(`Supabase ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
