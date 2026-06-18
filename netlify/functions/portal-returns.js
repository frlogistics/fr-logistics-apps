// netlify/functions/portal-returns.js
// FR-Logistics Client Portal — Tracking tab, "Returns" section
//
// Returns the last 30 days of RETURN LABELS for the client linked to
// ?portal_user=<email>.  These are INBOUND shipments (end customer ->
// FR-Logistics warehouse) created by the "Create Return Label" module in
// Inbound_Outbound.html and stored in Supabase table `return_labels`.
//
// SECURITY — COST IS NEVER EXPOSED TO THE CLIENT:
//   The SELECT below enumerates ONLY client-safe columns. The internal
//   billing fields — carrier_cost, billed_at, invoice_id, label_url —
//   are deliberately NOT selected, so they never leave Postgres and never
//   travel over the network to the client's browser. This is server-side
//   redaction, not CSS hiding: the cost is physically absent from the JSON.
//
// Client resolution:
//   `return_labels.client_id` is the SAME uuid as `fr_clients.id`, which is
//   exactly the clientId that portal-tracking.js already resolves from
//   portal_user. We filter returns by that uuid — no fragile text matching.

const ALLOWED_ORIGINS = [
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
  'https://apps.fr-logistics.net',
];

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const WINDOW_DAYS = 30;

// Client-safe columns ONLY. Do NOT add carrier_cost / billed_at /
// invoice_id / label_url here — those are internal billing fields.
const SAFE_COLUMNS = 'created_at,status,carrier,service,tracking,ship_from_json';

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

// Map a ShipStation/UPS service code to a friendly carrier+service label.
function prettyCarrier(carrier, service) {
  const c = (carrier || '').toUpperCase();
  const svc = (service || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
  return svc ? `${c} ${svc}` : c;
}

// Normalize the stored status into a small, client-friendly set.
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

    // 1) Resolve the client by portal_user -> fr_clients.id
    const clientRes = await sbFetch(
      `fr_clients?portal_user=eq.${encodeURIComponent(portalUser)}&select=id,company&limit=1`
    );
    const clientRows = await clientRes.json();
    if (!Array.isArray(clientRows) || clientRows.length === 0) {
      return resp(200, { ok: true, mode: 'no_client', returns: [] }, origin);
    }
    const clientId = clientRows[0].id;

    // 2) Pull last-30-days returns for that client_id — SAFE COLUMNS ONLY.
    const since = new Date(Date.now() - WINDOW_DAYS * 86400 * 1000)
      .toISOString();
    const retRes = await sbFetch(
      `return_labels?client_id=eq.${clientId}` +
        `&created_at=gte.${since}` +
        `&select=${SAFE_COLUMNS}` +
        `&order=created_at.desc`
    );

    if (!retRes.ok) {
      const txt = await retRes.text();
      return resp(502, { ok: false, error: 'supabase_error', detail: txt }, origin);
    }

    const rows = await retRes.json();

    // 3) Shape each row for the UI. carrier_cost is not present here at all.
    const returns = (Array.isArray(rows) ? rows : []).map((r) => {
      const from = r.ship_from_json || {};
      const cityState = [from.city, from.state].filter(Boolean).join(', ');
      return {
        date: r.created_at ? r.created_at.slice(0, 10) : '',
        recipient: from.name || '—',
        origin: cityState || '—',
        carrier: prettyCarrier(r.carrier, r.service),
        tracking: r.tracking || '',
        status: prettyStatus(r.status),
      };
    });

    return resp(200, { ok: true, mode: 'ok', count: returns.length, returns }, origin);
  } catch (err) {
    return resp(500, { ok: false, error: String(err && err.message || err) }, origin);
  }
};
