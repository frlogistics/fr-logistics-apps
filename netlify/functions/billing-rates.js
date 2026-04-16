// netlify/functions/billing-rates.js
// Returns rate card for a specific client from Supabase fr_client_rates
// Falls back to DEFAULT row if client has no custom rate card

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

  const sbHeaders = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };

  const client = (event.queryStringParameters?.client || '').trim();
  if (!client)
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'client param required' }) };

  try {
    // Fetch client-specific rates AND default rates in parallel
    const [clientResp, defaultResp] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/fr_client_rates?client_name=eq.${encodeURIComponent(client)}&limit=1`,
        { headers: sbHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/fr_client_rates?client_name=eq.DEFAULT&limit=1`,
        { headers: sbHeaders }),
    ]);

    const [clientRows, defaultRows] = await Promise.all([
      clientResp.json(),
      defaultResp.json(),
    ]);

    const defaults = defaultRows[0] || {};
    const custom   = clientRows[0]  || {};

    // Merge: client rates override defaults
    const rates = { ...defaults, ...custom, client_name: client };

    // Remove system fields
    delete rates.id;
    delete rates.updated_at;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        client,
        hasCustomRates: clientRows.length > 0,
        rates,
      })
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
