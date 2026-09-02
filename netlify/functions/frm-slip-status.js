// netlify/functions/frm-slip-status.js
// FR Mobile — Receiving: record WHY a package has no packing slip photo.
//
// Without this, a missing photo is ambiguous: it could mean the operator
// skipped the step, or that the carton genuinely arrived with no slip inside.
// One of those is a process problem and the other is a fact about the package.
// Until they are told apart, the photo-coverage number means nothing.
//
// Writes shipments_general.slip_status ('no_slip' | 'damaged_slip'), plus who
// marked it and when. Passing slip_status:null clears the mark (undo).
//
// Kept as its own function, decoupled from frm-receive.js, so a change here
// can never break the scan-insert path.

const ALLOWED_ORIGINS = [
  'https://apps.fr-logistics.net',
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
];

const ALLOWED_STATUSES = new Set(['no_slip', 'damaged_slip']);

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
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const tracking = String(body.tracking || '').trim();
  if (!tracking)
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'tracking is required' }) };

  // null / '' clears the mark. Anything else must be in the allow-list.
  const raw = body.slip_status;
  const clearing = raw === null || raw === undefined || raw === '';
  if (!clearing && !ALLOWED_STATUSES.has(raw))
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid slip_status' }) };

  const operator = String(body.operator || '').slice(0, 60);
  const patch = clearing
    ? { slip_status: null, slip_status_by: null, slip_status_at: null }
    : { slip_status: raw, slip_status_by: operator || null, slip_status_at: new Date().toISOString() };

  try {
    const url = `${SUPABASE_URL}/rest/v1/shipments_general`
      + `?tracking=eq.${encodeURIComponent(tracking)}`
      + `&direction=eq.Inbound`;

    const resp = await fetch(url, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(patch),
    });

    if (!resp.ok) throw new Error(`Supabase ${resp.status}: ${await resp.text()}`);

    const rows = await resp.json();
    if (!Array.isArray(rows) || !rows.length)
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Package not found' }) };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, tracking, slip_status: rows[0].slip_status }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
