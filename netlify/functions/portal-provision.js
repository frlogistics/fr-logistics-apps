// netlify/functions/portal-provision.js
// FR-Logistics — Client Portal access provisioning
//
// Called by onboarding.html when the welcome package is sent, so a signed
// client always ends up with portal access without anyone remembering to
// create it by hand.
//
// Does exactly two things, both idempotent:
//   1. Creates a Supabase Auth user for the client's email (random password
//      that is generated, never returned, and never used — the client sets
//      their own via /app/set-password.html "Send reset link").
//   2. Writes that email into fr_clients.portal_user, which is what every
//      portal-* function looks the client up by.
//
// POST { client_id, email }
//   -> { ok, portal_user, auth_user: 'created'|'existing', link: 'set'|'already_set' }
//
// NOTE: uses SUPABASE_URL + SUPABASE_SERVICE_KEY only. No new environment
// variables — the site is at the 4KB Lambda ceiling (see deploy constraints).

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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

function sbHeaders(extra) {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    ...(extra || {}),
  };
}

// Random password the client never sees and we never store anywhere.
// They set their own through the password-reset flow.
function throwawayPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
  let out = '';
  const bytes = require('crypto').randomBytes(40);
  for (let i = 0; i < 40; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim());
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const headers = corsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server not configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const clientId = String(body.client_id || '').trim();
  const email = String(body.email || '').trim().toLowerCase();

  if (!clientId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing client_id' }) };
  if (!isEmail(email)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid email' }) };

  try {
    // ── 1. Client must exist ────────────────────────────────────────────────
    const cRes = await fetch(
      `${SUPABASE_URL}/rest/v1/fr_clients?id=eq.${encodeURIComponent(clientId)}&select=id,company,name,portal_user`,
      { headers: sbHeaders() }
    );
    if (!cRes.ok) {
      const detail = await cRes.text();
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Client lookup failed', detail }) };
    }
    const rows = await cRes.json();
    if (!rows.length) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Client not found' }) };
    }
    const client = rows[0];

    // Another client already owns this portal_user — refuse rather than
    // silently give one client visibility into another's data.
    const dupRes = await fetch(
      `${SUPABASE_URL}/rest/v1/fr_clients?portal_user=eq.${encodeURIComponent(email)}&select=id,company`,
      { headers: sbHeaders() }
    );
    if (dupRes.ok) {
      const dups = (await dupRes.json()).filter((r) => String(r.id) !== String(clientId));
      if (dups.length) {
        return {
          statusCode: 409,
          headers,
          body: JSON.stringify({
            error: 'PORTAL_USER_TAKEN',
            detail: `${email} is already the portal user of ${dups[0].company || dups[0].id}`,
          }),
        };
      }
    }

    // ── 2. Auth user (idempotent) ───────────────────────────────────────────
    let authUser = 'existing';
    const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: sbHeaders(),
      body: JSON.stringify({
        email,
        password: throwawayPassword(),
        email_confirm: true,
        user_metadata: {
          client_id: client.id,
          company: client.company || client.name || '',
          provisioned_by: 'onboarding',
        },
      }),
    });

    if (createRes.ok) {
      authUser = 'created';
    } else {
      const detail = await createRes.text();
      // GoTrue answers 422 (and in some versions 400) when the address is
      // already registered. That is the happy path on a re-run, not a failure.
      const alreadyExists =
        (createRes.status === 422 || createRes.status === 400) &&
        /already been registered|already registered|already exists/i.test(detail);
      if (!alreadyExists) {
        return {
          statusCode: 502,
          headers,
          body: JSON.stringify({ error: 'Auth user creation failed', status: createRes.status, detail }),
        };
      }
    }

    // ── 3. Link the client record ───────────────────────────────────────────
    let link = 'already_set';
    if (String(client.portal_user || '').toLowerCase() !== email) {
      const patchRes = await fetch(
        `${SUPABASE_URL}/rest/v1/fr_clients?id=eq.${encodeURIComponent(clientId)}`,
        {
          method: 'PATCH',
          headers: sbHeaders({ Prefer: 'return=minimal' }),
          body: JSON.stringify({ portal_user: email }),
        }
      );
      if (!patchRes.ok) {
        const detail = await patchRes.text();
        return {
          statusCode: 502,
          headers,
          body: JSON.stringify({ error: 'Could not link portal_user', detail, auth_user: authUser }),
        };
      }
      link = 'set';
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, portal_user: email, auth_user: authUser, link }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error', detail: String(err) }) };
  }
};
