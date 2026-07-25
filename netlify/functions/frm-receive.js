// netlify/functions/frm-receive.js
// Dedicated write endpoint for FR Mobile — Receiving module.
// Inserts one inbound scan into shipments_general using the service key
// (bypasses RLS, same pattern as the other apps). Decoupled from
// shipments-proxy so changes to Inbound_Outbound never affect FR Mobile.

const { createClient } = require('@supabase/supabase-js');

// Auto-detect whichever service-key env var this project already uses.
const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  'https://rijbschnchjiuggrhfrx.supabase.co';

const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const ALLOWED_TYPES = new Set([
  'Inbound (General)',
  'Inbound (Amazon FBA)',
  'Inbound (Drop-Shipment)',
  'Inbound (Prep Service)',
  'Overstock',
  'RMA (Returns)',
  'Other',
]);
const ALLOWED_CARRIERS = new Set(['Amazon', 'UPS', 'USPS', 'FedEx', 'Walmart', 'Other']);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  if (!SERVICE_KEY) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({
        error:
          'Service key not configured. Set SUPABASE_SERVICE_ROLE_KEY (or your existing service-key env var) in Netlify site settings.',
      }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const tracking = String(body.tracking || '').trim();
  if (!tracking)
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'tracking is required' }) };

  const client = String(body.client || '').trim();
  if (!client)
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'client is required' }) };

  const type = ALLOWED_TYPES.has(body.type) ? body.type : 'Inbound (General)';
  const carrier = ALLOWED_CARRIERS.has(body.carrier) ? body.carrier : 'Other';
  const operator = String(body.operator || '').slice(0, 60);
  const client_id = body.client_id || null;

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const row = {
    tracking,
    direction: 'Inbound',
    carrier,
    type,
    client,
    client_id,
    notes: operator ? `Scanned via FR Mobile — ${operator}` : 'Scanned via FR Mobile',
    received_at: new Date().toISOString(),
  };

  const { data, error } = await sb
    .from('shipments_general')
    .insert(row)
    .select('id')
    .single();

  if (error) {
    // 23505 = unique_violation (tracking already exists)
    const dup = error.code === '23505';
    return {
      statusCode: dup ? 409 : 500,
      headers: CORS,
      body: JSON.stringify({ error: dup ? 'duplicate' : error.message, code: error.code || null }),
    };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, id: data.id }) };
};
