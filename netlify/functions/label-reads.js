// netlify/functions/frm-receive.js
// Dedicated write endpoint for FR Mobile — Receiving module.
// Inserts one inbound scan into shipments_general using the service key
// (bypasses RLS, same fetch pattern as clients-list.js). Decoupled from
// Inbound_Outbound so changes to one never affect the other.
//
// 1-Oct-2026 — duplicate guard on the NORMALISED tracking. The unique index on
// shipments_general.tracking compares raw text, so the same USPS package saved
// as a raw GS1 scan "(420)33172(92)0019…" here and as the clean 22 digits
// somewhere else (desktop, Receiving v2) would pass as two packages — and bill
// twice. Before inserting, fr_find_shipment() looks the package up by its
// normalised number. Same 409 {error:'duplicate'} as before, so FR Mobile needs
// no change; the response now also says which row already has it.
// Receiving v2 registers through this same function, on purpose: one writer,
// one contract (client text, client_id, the "Scanned via FR Mobile — <operator>"
// note that the Client Portal and Lookup both parse).

const ALLOWED_ORIGINS = [
  'https://apps.fr-logistics.net',
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
];

const ALLOWED_TYPES = new Set([
  // Inbound
  'Inbound (General)',
  'Inbound (Amazon FBA)',
  'Inbound (Drop-Shipment)',
  'Inbound (Prep Service)',
  'Overstock',
  'RMA (Returns)',
  // Outbound
  'Outbound (Shipment)',
  'Outbound (Drop-Shipment)',
  'Outbound (Pickup EcoPack+)',
  'Replacement',
  'Return to Sender',
  'Other',
]);
const ALLOWED_CARRIERS = new Set(['Amazon', 'UPS', 'USPS', 'FedEx', 'Walmart', 'Other']);
const ALLOWED_DIRECTIONS = new Set(['Inbound', 'Outbound']);

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  const headers = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase not configured' }) };

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const tracking = String(body.tracking || '').trim();
  if (!tracking)
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'tracking is required' }) };

  const client = String(body.client || '').trim();
  if (!client)
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'client is required' }) };

  const direction = ALLOWED_DIRECTIONS.has(body.direction) ? body.direction : 'Inbound';
  const defaultType = direction === 'Outbound' ? 'Outbound (Shipment)' : 'Inbound (General)';
  const type = ALLOWED_TYPES.has(body.type) ? body.type : defaultType;
  const carrier = ALLOWED_CARRIERS.has(body.carrier) ? body.carrier : 'Other';
  const operator = String(body.operator || '').slice(0, 60);
  const client_id = body.client_id || null;

  const row = {
    tracking,
    direction,
    carrier,
    type,
    client,
    client_id,
    notes: operator ? `Scanned via FR Mobile — ${operator}` : 'Scanned via FR Mobile',
    received_at: new Date().toISOString(),
  };

  try {
    // Normalised duplicate check (see header). If the lookup itself fails we
    // fall through to the insert: the raw unique index still protects exact
    // repeats, and receiving must never stop because of this extra check.
    try {
      const dupRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/fr_find_shipment`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_tracking: tracking }),
      });
      if (dupRes.ok) {
        const existing = await dupRes.json();
        if (existing && existing.id) {
          return { statusCode: 409, headers, body: JSON.stringify({ error: 'duplicate', existing }) };
        }
      }
    } catch (_) { /* fall through to the insert */ }

    const resp = await fetch(`${SUPABASE_URL}/rest/v1/shipments_general`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(row),
    });

    if (resp.status === 409) {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'duplicate' }) };
    }
    if (!resp.ok) {
      const txt = await resp.text();
      if (/duplicate key|23505/i.test(txt))
        return { statusCode: 409, headers, body: JSON.stringify({ error: 'duplicate' }) };
      throw new Error(`Supabase ${resp.status}: ${txt}`);
    }

    const data = await resp.json();
    const id = Array.isArray(data) && data[0] ? data[0].id : null;
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, id }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
