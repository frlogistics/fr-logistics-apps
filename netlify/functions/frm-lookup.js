// netlify/functions/frm-lookup.js
// Read-only endpoint for FR Mobile — Lookup module.
//
//   GET /frm-lookup?tracking=<scanned code>
//
// Answers "what is this package?" for one scanned tracking. Reads
// shipments_general with the service key (RLS stays closed) and never
// exposes billing columns. Same fetch pattern and CORS as frm-receive.js.
//
// Why this is not just shipments-proxy?tracking=eq.<x>:
// the handheld stores the raw GS1 barcode for USPS labels
// ("(420)33172(92)0019…", sometimes with GS 0x1D separators), while the desktop
// stores the clean 22 digits when someone types it. An exact match fails
// across those two, so this endpoint matches in three passes:
//   1. exact  — the code as scanned
//   2. normalized — the tracking with routing prefix / separators stripped
//   3. suffix — ilike on the last digits, then re-normalize every candidate
//               and keep the ones whose normalized form equals the scan
// The response says which pass matched so the operator can see when the
// stored tracking differs from the label in hand.

const ALLOWED_ORIGINS = [
  'https://apps.fr-logistics.net',
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
];

// Never billed_at / billing_id: the floor does not need them and the
// operator must not see them on a handheld.
const COLUMNS = [
  'id', 'tracking', 'direction', 'carrier', 'type', 'client', 'client_id',
  'notes', 'received_at', 'created_at', 'photo_urls',
].join(',');

// Same normalization as portal-inbound.js (kept in sync by hand on purpose:
// this function has no build step and no shared module).
function normalizeTracking(raw) {
  const original = String(raw || '');
  const t = original.replace(/[\s()\u001d\u001e-]/g, '');
  if (!t) return { tracking: '', carrier: '', warning: '' };

  const routed = t.match(/^420\d{5}(9[2-5]\d{20})$/);
  if (routed) return { tracking: routed[1], carrier: 'USPS', warning: '' };
  if (/^9[2-5]\d{20}$/.test(t)) return { tracking: t, carrier: 'USPS', warning: '' };
  if (/^1Z[0-9A-Z]{16}$/i.test(t)) return { tracking: t.toUpperCase(), carrier: 'UPS', warning: '' };
  if (/^TBA\d+$/i.test(t)) return { tracking: t.toUpperCase(), carrier: 'Amazon', warning: '' };
  if (/^96\d{32}$/.test(t)) {
    return { tracking: t.slice(-12), carrier: 'FedEx', warning: 'Captured from a 34-digit barcode; last 12 digits used.' };
  }
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

// "Scanned via FR Mobile — Joe Raymond" -> operator "Joe Raymond", and the
// rest of the note (whatever the warehouse actually typed) kept apart.
function splitNotes(notes) {
  const s = String(notes || '');
  const m = s.match(/Scanned via FR Mobile(?:\s*[—-]\s*([^\n;|]+))?/);
  const operator = m && m[1] ? m[1].trim() : '';
  const rest = s.replace(/Scanned via FR Mobile(?:\s*[—-]\s*[^\n;|]+)?/, '')
    .replace(/^[\s;|,\-—]+|[\s;|,\-—]+$/g, '')
    .trim();
  return { operator, note: rest };
}

function shape(row, scannedNorm) {
  const stored = normalizeTracking(row.tracking);
  const { operator, note } = splitNotes(row.notes);
  const carrier = row.carrier && row.carrier !== 'Other' ? row.carrier : stored.carrier;
  return {
    id: row.id,
    tracking: row.tracking,
    tracking_clean: stored.tracking,
    tracking_url: trackingUrl(stored.tracking, carrier),
    direction: row.direction,
    carrier: row.carrier,
    type: row.type,
    client: row.client,
    client_id: row.client_id,
    operator,
    note,
    received_at: row.received_at || row.created_at,
    photo_urls: Array.isArray(row.photo_urls) ? row.photo_urls : [],
    // true when the label in hand and the stored value differ in text but
    // are the same tracking once normalized
    stored_differs: !!scannedNorm && stored.tracking === scannedNorm && row.tracking !== scannedNorm,
  };
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase not configured' }) };

  const q = event.queryStringParameters || {};
  const scanned = String(q.tracking || '').trim();
  if (!scanned)
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'tracking is required' }) };
  if (scanned.length > 120)
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'tracking too long' }) };

  const norm = normalizeTracking(scanned);

  const sb = async (query) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/shipments_general?select=${COLUMNS}&${query}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
    return r.json();
  };

  try {
    // Pass 1 — exact, as scanned.
    let rows = await sb(`tracking=eq.${encodeURIComponent(scanned)}&limit=2`);
    let match = 'exact';

    // Pass 2 — normalized form (covers desktop-typed clean numbers).
    if (!rows.length && norm.tracking && norm.tracking !== scanned) {
      rows = await sb(`tracking=eq.${encodeURIComponent(norm.tracking)}&limit=2`);
      match = 'normalized';
    }

    // Pass 3 — suffix search, then verify each candidate by normalization.
    // Only when the normalized code is long enough that a suffix means
    // something (10+ chars); short codes would pull in unrelated rows.
    let candidates = [];
    if (!rows.length && norm.tracking.length >= 10) {
      const suffix = norm.tracking.slice(-12);
      const pool = await sb(`tracking=ilike.${encodeURIComponent('*' + suffix)}&order=received_at.desc&limit=10`);
      const same = pool.filter((r) => normalizeTracking(r.tracking).tracking === norm.tracking);
      if (same.length) { rows = same; match = 'suffix'; }
      else if (pool.length) { candidates = pool; match = 'none'; }
      else match = 'none';
    } else if (!rows.length) {
      match = 'none';
    }

    const body = {
      found: rows.length > 0,
      match,
      scanned,
      tracking_clean: norm.tracking,
      carrier_guess: norm.carrier,
      tracking_url: trackingUrl(norm.tracking, norm.carrier),
      warning: norm.warning,
      shipment: rows.length ? shape(rows[0], norm.tracking) : null,
      // more than one row is unexpected (tracking is unique) but a suffix
      // match can legitimately return the same tracking under two spellings
      others: rows.slice(1).map((r) => shape(r, norm.tracking)),
      // near misses: same last digits, different tracking once normalized —
      // shown so the operator can tell "wrong label" from "not logged"
      candidates: candidates.slice(0, 5).map((r) => shape(r, '')),
    };
    return { statusCode: 200, headers, body: JSON.stringify(body) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
