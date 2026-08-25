// netlify/functions/portal-inbound.js
// FR-Logistics Client Portal — "Inbound" tab.
//
// Package-level receiving log: one row per package physically scanned at the
// Doral dock, taken from `shipments_general` where direction = 'Inbound'.
// This is what answers the client question "did my removal orders arrive?".
//
// Two modes, decided by ?portal_user= (same contract as portal-returns.js):
//
//   CLIENT MODE: only that client's own inbound rows.
//   ADMIN MODE (warehouse@fr-logistics.net): every client's rows, plus the
//   `client` label as stored, for internal review.
//
// SECURITY NOTE: rows are filtered by `shipments_general.client_id`, never by
// the free-text `client` column. That column is inconsistent (the same client
// appears as both its company and its store name, e.g. "Milano Brands LLC"
// and "Daizzy Gear"), so matching on it would either leak or hide rows.
// client_id is populated on 100% of rows (checked 2026-08-20: 723/723).
//
// Query params:
//   portal_user  (required) — the logged-in email
//   days         (optional) — lookback window, default 90, max 400
//
// Response:
//   { ok, isAdmin, count, window_days, generated_at, packages: [ ... ] }

const ALLOWED_ORIGINS = [
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
  'https://apps.fr-logistics.net',
];

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const DEFAULT_DAYS = 90;
const MAX_DAYS = 400;

const ADMIN_EMAIL = 'warehouse@fr-logistics.net';

// "View as client": the admin may pass ?as_client=<fr_clients.id> to read this
// tab exactly as that client sees it. Honored ONLY for the admin email — any
// other caller's as_client is ignored and the lookup falls back to their own
// portal_user, so a client can never reach another client's rows with it.
const AS_CLIENT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Client-safe columns only. billed_at / billing_id are internal billing
// fields and must never reach the client payload.
const CLIENT_COLUMNS = 'id,received_at,created_at,tracking,carrier,type,notes,photo_urls';
const ADMIN_COLUMNS = CLIENT_COLUMNS + ',client';

// Internal scanner breadcrumbs that must not be shown to the client.
// Anything else in `notes` is a real reference the warehouse wrote down
// (usually the FNSKU + qty printed on the box), which IS useful to them.
const INTERNAL_NOTE_RE = /^\s*scanned via fr mobile\b.*$/i;

// Reading of the Amazon packing slip photographed at the dock (slip-extract.js).
// Only 'ok' rows are joined: a low-confidence or failed reading stays internal,
// because showing a client the wrong FNSKU is worse than showing nothing.
async function fetchSlipSummaries(sinceIso) {
  try {
    const res = await sbFetch(
      `wh_slip_extractions?status=eq.ok&created_at=gte.${sinceIso}` +
        `&select=shipment_id,summary,ra_number,vret_id,origin_fc,items,lpn` +
        `&order=created_at.desc`
    );
    if (!res.ok) return new Map();
    const rows = await res.json();
    const map = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
      // Rows come newest first; keep the newest reading per shipment.
      if (r.shipment_id && r.summary && !map.has(r.shipment_id)) map.set(r.shipment_id, r);
    }
    return map;
  } catch {
    // Enrichment only — never let it break the tab.
    return new Map();
  }
}

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

// ---------------------------------------------------------------------------
// Tracking normalization
//
// The warehouse scanner captures whatever the barcode encodes. For USPS and
// other GS1-128 labels that is the FULL routing barcode — "420" + destination
// ZIP + the actual tracking number — sometimes with parentheses around the
// application identifiers, sometimes with a raw GS separator (0x1D).
// Handing that string to the client is useless: it does not resolve on
// usps.com. Strip the routing prefix so what we publish is trackable.
//
// Examples seen in production:
//   (420)33172(92)00190213428559109714  -> 9200190213428559109714
//   42033172<GS>9300189696000727148934  -> 9300189696000727148934
//   420331729361289677065267454863      -> 9361289677065267454863
// ---------------------------------------------------------------------------
function normalizeTracking(raw) {
  const original = String(raw || '');
  // Drop parentheses, whitespace and GS1 separators (GS 0x1D, RS 0x1E).
  const t = original.replace(/[\s()\u001d\u001e-]/g, '');
  if (!t) return { tracking: '', carrier: '', warning: '' };

  // USPS behind a 420 + ZIP5 routing prefix.
  const routed = t.match(/^420\d{5}(9[2-5]\d{20})$/);
  if (routed) return { tracking: routed[1], carrier: 'USPS', warning: '' };

  // Bare USPS IMpb (22 digits, 92/93/94/95).
  if (/^9[2-5]\d{20}$/.test(t)) return { tracking: t, carrier: 'USPS', warning: '' };

  // UPS 1Z.
  if (/^1Z[0-9A-Z]{16}$/i.test(t)) return { tracking: t.toUpperCase(), carrier: 'UPS', warning: '' };

  // Amazon Logistics.
  if (/^TBA\d+$/i.test(t)) return { tracking: t.toUpperCase(), carrier: 'Amazon', warning: '' };

  // FedEx 34-digit "96" barcode: the human tracking number is the last 12.
  if (/^96\d{32}$/.test(t)) {
    return {
      tracking: t.slice(-12),
      carrier: 'FedEx',
      warning: 'Captured from a 34-digit barcode; last 12 digits used.',
    };
  }

  // Unknown format — publish it as scanned and flag it rather than guessing.
  return { tracking: t, carrier: '', warning: 'Non-standard barcode format.' };
}

function trackingUrl(tracking, carrier) {
  if (!tracking) return '';
  const c = (carrier || '').toUpperCase();
  if (c === 'UPS') return 'https://www.ups.com/track?tracknum=' + encodeURIComponent(tracking);
  if (c === 'USPS') return 'https://tools.usps.com/go/TrackConfirmAction?tLabels=' + encodeURIComponent(tracking);
  if (c === 'AMAZON') return 'https://track.amazon.com/tracking/' + encodeURIComponent(tracking);
  if (c === 'FEDEX') return 'https://www.fedex.com/fedextrack/?trknbr=' + encodeURIComponent(tracking);
  return '';
}

// `type` is an operator-picked label. Normalize it into a small set the UI
// can badge, while still showing the original text.
function typeKey(type) {
  const s = (type || '').toLowerCase();
  if (s.includes('rma') || s.includes('return')) return 'return';
  if (s.includes('overstock') || s.includes('removal')) return 'removal';
  if (s.includes('fba')) return 'fba';
  if (s.includes('prep')) return 'prep';
  return 'other';
}

function cleanNote(notes) {
  const n = (notes || '').trim();
  if (!n || INTERNAL_NOTE_RE.test(n)) return '';
  return n;
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

    let days = parseInt(event.queryStringParameters?.days || '', 10);
    if (!Number.isFinite(days) || days <= 0) days = DEFAULT_DAYS;
    if (days > MAX_DAYS) days = MAX_DAYS;

    const isAdmin = portalUser.toLowerCase() === ADMIN_EMAIL.toLowerCase();
    const asClientRaw = String(event.queryStringParameters?.as_client || '').trim();
    // Only the admin can view as somebody else. With as_client set we behave
    // exactly like that client's own session; without it, the admin sees the
    // combined all-clients log.
    const viewingAs = isAdmin && AS_CLIENT_UUID_RE.test(asClientRaw) ? asClientRaw : '';
    const allClients = isAdmin && !viewingAs;
    const since = new Date(Date.now() - days * 86400 * 1000).toISOString();

    // received_at is the dock timestamp and is what the client cares about,
    // but it is nullable on a few legacy rows, so the window is applied to
    // created_at as well with an OR.
    const windowFilter =
      `&or=(received_at.gte.${since},and(received_at.is.null,created_at.gte.${since}))`;

    let url;
    if (allClients) {
      url =
        `shipments_general?direction=eq.Inbound` +
        windowFilter +
        `&select=${ADMIN_COLUMNS}` +
        `&order=received_at.desc.nullslast`;
    } else {
      const clientLookup = viewingAs
        ? `id=eq.${viewingAs}`
        : `portal_user=eq.${encodeURIComponent(portalUser)}`;
      const clientRes = await sbFetch(
        `fr_clients?${clientLookup}&select=id,name,company,store_name&limit=1`
      );
      const clientRows = await clientRes.json();
      if (!Array.isArray(clientRows) || clientRows.length === 0) {
        return resp(200, { ok: true, mode: 'no_client', isAdmin: false, count: 0, packages: [] }, origin);
      }
      const client = clientRows[0];
      url =
        `shipments_general?direction=eq.Inbound` +
        `&client_id=eq.${client.id}` +
        windowFilter +
        `&select=${CLIENT_COLUMNS}` +
        `&order=received_at.desc.nullslast`;

      var clientMeta = {
        id: client.id,
        name: client.name || '',
        company: client.company || '',
      };
    }

    const res = await sbFetch(url);
    if (!res.ok) {
      const txt = await res.text();
      return resp(502, { ok: false, error: 'supabase_error', detail: txt }, origin);
    }

    const rows = await res.json();
    const slips = await fetchSlipSummaries(since);

    const packages = (Array.isArray(rows) ? rows : []).map((r) => {
      const ts = r.received_at || r.created_at || '';
      const norm = normalizeTracking(r.tracking);
      const carrier = norm.carrier || (r.carrier && r.carrier !== 'Other' ? r.carrier : '');
      const photos = Array.isArray(r.photo_urls) ? r.photo_urls.filter(Boolean) : [];
      // What the operator typed always wins over what the model read.
      const typed = cleanNote(r.notes);
      const slip = slips.get(r.id);
      const out = {
        received_at: ts,
        date: ts ? ts.slice(0, 10) : '',
        tracking: norm.tracking,
        tracking_url: trackingUrl(norm.tracking, carrier),
        carrier: carrier || '—',
        type: r.type || '—',
        type_key: typeKey(r.type),
        reference: typed || (slip ? slip.summary : ''),
        reference_source: typed ? 'operator' : (slip ? 'slip' : ''),
        // Structured version of the same reading, so the export can put the
        // code and the quantity in separate columns instead of shipping
        // "X004HGE41Z (8)" as one string the client has to split by hand.
        slip_items: slip && Array.isArray(slip.items)
          ? slip.items
              .map((it) => ({
                code: it.fnsku || it.asin || it.upc || it.lpn || slip.lpn || '',
                qty:
                  it.qty === null || it.qty === undefined || it.qty === ''
                    ? null
                    : Number(it.qty),
              }))
              .filter((it) => it.code)
          : [],
        ra_number: slip ? slip.ra_number || '' : '',
        origin_fc: slip ? slip.origin_fc || '' : '',
        warning: norm.warning,
        photos,
      };
      if (allClients) out.client = r.client || '—';
      return out;
    });

    const byType = packages.reduce((acc, p) => {
      acc[p.type_key] = (acc[p.type_key] || 0) + 1;
      return acc;
    }, {});

    const out = {
      ok: true,
      mode: 'ok',
      // isAdmin drives the extra Client column in the UI. When viewing AS a
      // client we deliberately report false: the screen must look exactly like
      // that client's own.
      isAdmin: allClients,
      viewing_as: viewingAs || null,
      window_days: days,
      generated_at: new Date().toISOString(),
      count: packages.length,
      by_type: byType,
      packages,
    };
    if (!allClients && typeof clientMeta !== 'undefined') out.client = clientMeta;

    return resp(200, out, origin);
  } catch (err) {
    return resp(500, { ok: false, error: String((err && err.message) || err) }, origin);
  }
};
