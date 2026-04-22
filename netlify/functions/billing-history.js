// netlify/functions/billing-history.js
// PURPOSE: Return recent invoices (billing_runs) for a client, used by the
//          "Show past invoices" modal in the Billing Generator.
//
// GET query params:
//   client  (required)  — client name as stored in shipments_general/billing_runs
//                          ex: "LN Store, LLC"  (matched with ILIKE for flexibility)
//   limit   (optional)  — max number of rows, default 6, hard cap 50
//
// Response:
//   { client, count, invoices: [{ id, invoice_number, period_start, period_end,
//                                 total_usd, package_count, generated_at,
//                                 generated_by, notes }] }

const SB_BASE = `${process.env.SUPABASE_URL}/rest/v1/billing_runs`;

function sbHeaders() {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const p       = event.queryStringParameters || {};
  const client  = (p.client || '').trim();
  const limitIn = parseInt(p.limit || '6', 10);
  const limit   = Math.min(Math.max(1, limitIn || 6), 50);

  if (!client) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'client required' }) };
  }

  try {
    const url = [
      `${SB_BASE}?`,
      `client=ilike.*${encodeURIComponent(client)}*`,
      `&select=id,invoice_number,client,client_code,period_start,period_end,total_usd,package_count,generated_at,generated_by,notes`,
      `&order=generated_at.desc`,
      `&limit=${limit}`
    ].join('');

    const r = await fetch(url, { headers: sbHeaders() });
    if (!r.ok) {
      return { statusCode: r.status, headers: cors, body: JSON.stringify({ error: await r.text() }) };
    }

    const invoices = await r.json();

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        client,
        count: invoices.length,
        invoices
      })
    };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
