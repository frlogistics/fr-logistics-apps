// netlify/functions/portal-returns.js
// FR-Logistics Client Portal — Tracking tab, "Returns" section
//
// Two modes, decided by ?portal_user=:
//
//   CLIENT MODE (any portal_user matching fr_clients.portal_user):
//     Returns the last 30 days of that client's own return labels.
//     SAFE COLUMNS ONLY — carrier_cost / billed_at / invoice_id / label_url
//     are NEVER selected, so cost physically never reaches the client.
//
//   ADMIN MODE (portal_user === ADMIN_EMAIL, i.e. warehouse@):
//     Returns the last 30 days of ALL clients' return labels, WITH cost
//     and client name, for internal warehouse review. No client filter.
//
// `return_labels.client_id` === `fr_clients.id`. Client mode filters by
// that uuid (resolved from portal_user). Admin mode skips the filter.

const ALLOWED_ORIGINS = [
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
  'https://apps.fr-logistics.net',
];

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const WINDOW_DAYS = 30;

// Internal operator. Sees ALL returns WITH cost.
const ADMIN_EMAIL = 'warehouse@fr-logistics.net';

// Client-safe columns ONLY. Do NOT add carrier_cost / billed_at /
// invoice_id / label_url here — those are internal billing fields.
const CLIENT_COLUMNS = 'created_at,status,carrier,service,tracking,ship_from_json';

// Admin view additionally exposes client + carrier_cost.
const ADMIN_COLUMNS  = 'created_at,status,carrier,service,tracking,ship_from_json,client,carrier_cost';

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };
}

function resp(statusCode, body, origin) {
  return { statusCode, headers: corsHeaders(origin), body: JSON.stringify(body) };
}

async function sbFetch(path) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
}

function prettyCarrier(carrier, service) {
  const c = (carrier || '').toUpperCase();
  const svc = (service || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
  return svc ? `${c} ${svc}` : c;
}

function prettyStatus(status) {
  const s = (status || '').toLowerCase();
  if (s === 'in_transit') return 'In Transit';
  if (s === 'delivered') return 'Delivered';
  if (s === 'created' || s === 'label_created') return 'Label Created';
  if (s === 'voided' || s === 'cancelled') return 'Voided';
  return status || '—';
}

export const handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  }

  try {
    const portalUser = (event.queryStringParameters?.portal_user || '').trim();
    if (!portalUser) {
      return resp(400, { ok: false, error: 'missing portal_user' }, origin);
    }

    const isAdmin = portalUser.toLowerCase() === ADMIN_EMAIL.toLowerCase();
    const since = new Date(Date.now() - WINDOW_DAYS * 86400 * 1000).toISOString();

    let url;
    if (isAdmin) {
      // ADMIN: all clients, last 30 days, WITH cost.
      url =
        `return_labels?created_at=gte.${since}` +
        `&select=${ADMIN_COLUMNS}` +
        `&order=created_at.desc`;
    } else {
      // CLIENT: resolve client_id, filter by it, SAFE columns only.
      const clientRes = await sbFetch(
        `fr_clients?portal_user=eq.${encodeURIComponent(portalUser)}&select=id&limit=1`
      );
      const clientRows = await clientRes.json();
      if (!Array.isArray(clientRows) || clientRows.length === 0) {
        return resp(200, { ok: true, mode: 'no_client', isAdmin: false, returns: [] }, origin);
      }
      const clientId = clientRows[0].id;
      url =
        `return_labels?client_id=eq.${clientId}` +
        `&created_at=gte.${since}` +
        `&select=${CLIENT_COLUMNS}` +
        `&order=created_at.desc`;
    }

    const retRes = await sbFetch(url);
    if (!retRes.ok) {
      const txt = await retRes.text();
      return resp(502, { ok: false, error: 'supabase_error', detail: txt }, origin);
    }

    const rows = await retRes.json();

    const returns = (Array.isArray(rows) ? rows : []).map((r) => {
      const from = r.ship_from_json || {};
      const cityState = [from.city, from.state].filter(Boolean).join(', ');
      const base = {
        date: r.created_at ? r.created_at.slice(0, 10) : '',
        recipient: from.name || '—',
        origin: cityState || '—',
        carrier: prettyCarrier(r.carrier, r.service),
        tracking: r.tracking || '',
        status: prettyStatus(r.status),
      };
      if (isAdmin) {
        base.client = r.client || '—';
        const cost = parseFloat(r.carrier_cost);
        base.cost = Number.isFinite(cost) ? cost : null;
      }
      return base;
    });

    const out = {
      ok: true,
      mode: 'ok',
      isAdmin,
      count: returns.length,
      returns,
    };

    if (isAdmin) {
      out.total_cost = returns.reduce(
        (sum, r) => sum + (typeof r.cost === 'number' ? r.cost : 0),
        0
      );
    }

    return resp(200, out, origin);
  } catch (err) {
    return resp(500, { ok: false, error: String((err && err.message) || err) }, origin);
  }
};
