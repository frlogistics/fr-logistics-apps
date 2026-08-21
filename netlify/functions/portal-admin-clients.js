// netlify/functions/portal-admin-clients.js
// FR-Logistics Client Portal — client list for the internal "View as" selector.
//
// Returns the roster of clients so warehouse@fr-logistics.net can pick one and
// read the portal exactly as that client sees it.
//
// ACCESS: hard-gated to the admin email. Any other portal_user gets 403 with
// an empty body — a client must never be able to enumerate the other clients.
//
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY (already set, nothing new).

const ALLOWED_ORIGINS = [
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
  'https://apps.fr-logistics.net',
];

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const PORTAL_ADMIN_EMAIL = 'warehouse@fr-logistics.net';

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const headers = corsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const portalUser = ((event.queryStringParameters || {}).portal_user || '').trim().toLowerCase();
  if (!portalUser) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing portal_user' }) };
  }
  if (portalUser !== PORTAL_ADMIN_EMAIL) {
    // Deliberately terse: do not confirm or deny anything about the roster.
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/fr_clients` +
        `?select=id,name,company,store_name,portal_user,active,status` +
        `&active=is.true` +
        `&order=company.asc.nullslast`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    if (!res.ok) {
      const detail = await res.text();
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Client lookup failed', detail }) };
    }
    const rows = await res.json();

    // Company is the canonical display identifier across every app; name is
    // only a fallback for legacy rows where company is empty.
    const raw = (Array.isArray(rows) ? rows : []).map((c) => ({
      id: c.id,
      label: c.company || c.name || c.store_name || '(unnamed)',
      contact: (c.name || '').trim(),
      // `active` and `status` disagree on several rows (some are active=true
      // with status 'Inactive'). We filter on `active`, which is what the rest
      // of the stack uses, and pass `status` through so the UI can group by it
      // instead of silently mixing live clients with dormant ones.
      status: c.status || '',
      has_portal: !!(c.portal_user && String(c.portal_user).trim()),
    }));

    // Two rows can carry the exact same company name (there are real duplicates
    // in the roster). An internal user picking blindly between two identical
    // options is precisely the mistake this selector exists to prevent, so a
    // repeated label gets the contact name appended to tell them apart.
    const labelCounts = raw.reduce((acc, c) => {
      acc[c.label] = (acc[c.label] || 0) + 1;
      return acc;
    }, {});
    const clients = raw
      .map((c) => ({
        ...c,
        label: labelCounts[c.label] > 1 && c.contact ? `${c.label} — ${c.contact}` : c.label,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, count: clients.length, clients }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String((err && err.message) || err) }) };
  }
};
