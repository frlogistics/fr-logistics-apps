// netlify/functions/billing-inbound.js
// Returns inbound shipment count from shipments_general for a client + date range
// Uses ilike (case-insensitive partial match) for client name — handles naming variations

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

  const p     = event.queryStringParameters || {};
  const client = (p.client || '').trim();
  const start  = p.start   || '';
  const end    = p.end     || '';

  if (!client)
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'client param required' }) };

  // Use ilike for case-insensitive partial match (handles "Daizzy Gear", "daizzy", "DAIZZY GEAR" etc.)
  // direction ilike inbound handles 'Inbound', 'inbound', 'INBOUND', 'Inbound (Prep Service)' etc.
  let query = `${SUPABASE_URL}/rest/v1/shipments_general`
    + `?select=id,created_at,tracking,direction,carrier,type,client,notes`
    + `&client=ilike.*${encodeURIComponent(client)}*`
    + `&direction=ilike.*inbound*`;

  if (start) query += `&created_at=gte.${start}T00:00:00`;
  if (end)   query += `&created_at=lte.${end}T23:59:59`;
  query += `&order=created_at.desc&limit=500`;

  try {
    const resp = await fetch(query, {
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
      }
    });

    if (!resp.ok) {
      const err = await resp.text();
      return { statusCode: resp.status, headers, body: JSON.stringify({ error: err }) };
    }

    const data = await resp.json();
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        count:   data.length,
        records: data,
        client, start, end,
      })
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
