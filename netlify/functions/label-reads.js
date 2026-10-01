// netlify/functions/label-reads.js
// FR-Logistics · Receiving v2 — the fast half of label reading.
//
// Receiving v2 reads the carrier label from a photo and PROPOSES client,
// carrier, tracking and type. The slow part (the vision call, 5-15 s) runs in
// label-extract-background.js; this function is everything the handheld needs
// to wait on, which must answer in well under Netlify's 10-second limit:
//
//   POST {action:'start', photo_url, scanned_raw?, operator?}
//        -> creates the wh_label_reads row (status 'pending') and returns its id.
//           The handheld then fires label-extract-background with that id and
//           polls GET ?id= until the status leaves 'pending'.
//   GET  ?id=<uuid>                     -> one read, shaped for the handheld card
//   GET  ?recent=1[&operator=<name>]    -> today's reads (newest first, max 40)
//   GET  ?summary=1                     -> shadow-mode accuracy (v_label_shadow_summary)
//   POST {action:'confirm', read_id, client_id, type?, carrier?, operator?}
//        -> records what the operator says is right, and teaches the RA prefix
//
// SHADOW MODE RULE: nothing here writes to shipments_general. The current
// Receiving module stays the one that registers the package and drives billing;
// v2 only records what it WOULD have proposed, so the two can be compared row
// by row in v_label_shadow before anyone switches over.
//
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY (already set). No new variables.

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

// Only photos that live in our own bucket — never an arbitrary URL.
const ALLOWED_PHOTO_PREFIX = `${SB_URL}/storage/v1/object/public/shipment-photos/`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same list as the Receiving module, so a confirmed type can be copied 1:1
// into shipments_general after the cut-over.
const TYPES = [
  'Inbound (General)', 'Inbound (Amazon FBA)', 'Inbound (Drop-Shipment)',
  'Inbound (Prep Service)', 'Overstock', 'RMA (Returns)', 'Other',
];
const CARRIERS = ['Amazon', 'UPS', 'USPS', 'FedEx', 'Walmart', 'Other'];

const SB_HEADERS = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(statusCode, body) {
  return { statusCode, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function sb(path, init = {}) {
  return fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { ...SB_HEADERS, ...(init.headers || {}) } });
}

// Mirror of public.fr_norm_tracking() in Supabase. Kept identical on purpose:
// the database compares with that function, the handheld displays this one.
function normTracking(raw) {
  if (raw == null) return null;
  let t = String(raw).replace(/[\s()\-\u001d\u001e]/g, '').toUpperCase();
  if (!t) return null;
  if (/^12[0-9A-Z]{16}$/.test(t) && /[A-Z]/.test(t)) t = '1Z' + t.slice(2);
  const routed = t.match(/^420(?:\d{5}|\d{9})(9[2-5]\d{20})$/);
  if (routed) return routed[1];
  if (/^9[2-5]\d{20}$/.test(t)) return t;
  if (/^1Z[0-9A-Z]{16}$/.test(t)) return t;
  if (/^TBA\d{9,15}$/.test(t)) return t;
  if (/^96\d{32}$/.test(t)) return t.slice(-12);
  return t;
}

// The columns the handheld card needs — no model internals, no raw response.
const CARD_COLUMNS = [
  'id', 'created_at', 'operator', 'status', 'error', 'confidence',
  'scanned_tracking', 'tracking', 'tracking_read', 'tracking_match',
  'carrier', 'service', 'master_tracking', 'piece_no', 'piece_total',
  'ship_from_name', 'ship_from_city', 'ship_from_state', 'ship_from_is_fr',
  'ra_number', 'origin_fc', 'refs', 'weight_lb', 'description',
  'suggested_client_id', 'suggested_type', 'suggested_carrier', 'match_method', 'route', 'resolution',
  'confirmed_client_id', 'confirmed_type', 'confirmed_carrier', 'confirmed_by', 'confirmed_at',
  'photo_url',
].join(',');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!SB_URL || !SB_KEY) return json(500, { error: 'Supabase not configured' });

  try {
    // ─── GET ────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};

      if (q.id) {
        if (!UUID_RE.test(q.id)) return json(400, { error: 'bad id' });
        const r = await sb(`wh_label_reads?id=eq.${q.id}&select=${CARD_COLUMNS}&limit=1`);
        const rows = await r.json();
        if (!Array.isArray(rows) || !rows.length) return json(404, { error: 'not found' });
        return json(200, { read: rows[0] });
      }

      if (q.recent) {
        // "Today" in Miami, not UTC: after 8 PM EDT the UTC date already flipped.
        const miamiDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
        // -04:00 is midnight in EDT and 11 PM the day before in EST: never misses a
        // morning read; at worst shows one from late last night in winter.
        const since = new Date(`${miamiDay}T00:00:00-04:00`).toISOString();
        let path = `wh_label_reads?created_at=gte.${encodeURIComponent(since)}&select=${CARD_COLUMNS}&order=created_at.desc&limit=40`;
        if (q.operator) path += `&operator=eq.${encodeURIComponent(q.operator)}`;
        const r = await sb(path);
        return json(200, { reads: await r.json() });
      }

      if (q.summary) {
        const r = await sb('v_label_shadow_summary?select=*');
        const rows = await r.json();
        return json(200, { summary: Array.isArray(rows) ? rows[0] : null });
      }

      return json(400, { error: 'use ?id=, ?recent=1 or ?summary=1' });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }
    const operator = String(body.operator || '').trim().slice(0, 60) || null;

    // ─── start ──────────────────────────────────────────────────────────
    if (body.action === 'start') {
      const photoUrl = String(body.photo_url || '').trim();
      if (!photoUrl.startsWith(ALLOWED_PHOTO_PREFIX)) return json(400, { error: 'photo_url is not a shipment photo of ours' });
      const scannedRaw = body.scanned_raw ? String(body.scanned_raw).slice(0, 200) : null;

      const r = await sb('wh_label_reads?on_conflict=photo_url', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify([{
          photo_url: photoUrl,
          scanned_raw: scannedRaw,
          scanned_tracking: normTracking(scannedRaw),
          operator,
          mode: 'shadow',
          status: 'pending',
          error: null,
        }]),
      });
      const rows = await r.json();
      if (!r.ok || !Array.isArray(rows) || !rows.length) {
        return json(500, { error: 'could not create the read', detail: rows });
      }
      return json(200, { read_id: rows[0].id, scanned_tracking: rows[0].scanned_tracking });
    }

    // ─── confirm ────────────────────────────────────────────────────────
    if (body.action === 'confirm') {
      const readId = String(body.read_id || '');
      const clientId = String(body.client_id || '');
      if (!UUID_RE.test(readId)) return json(400, { error: 'bad read_id' });
      if (!UUID_RE.test(clientId)) return json(400, { error: 'pick a client first' });
      const type = body.type && TYPES.includes(body.type) ? body.type : null;
      const carrier = body.carrier && CARRIERS.includes(body.carrier) ? body.carrier : null;

      // The client must exist and be a real (non-internal) account.
      const cr = await sb(`fr_clients?id=eq.${clientId}&select=id,client_code,type,status&limit=1`);
      const crow = (await cr.json())[0];
      if (!crow || crow.type === 'Internal' || crow.status === 'Internal') return json(400, { error: 'unknown client' });

      const pr = await sb(`wh_label_reads?id=eq.${readId}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          confirmed_client_id: clientId,
          confirmed_type: type,
          confirmed_carrier: carrier,
          confirmed_by: operator,
          confirmed_at: new Date().toISOString(),
        }),
      });
      const prow = (await pr.json())[0];
      if (!prow) return json(404, { error: 'read not found' });

      // Teach the RA prefix — but never overwrite a prefix that already points
      // to another client: that is a conflict for a human, not for a tap.
      let raNote = null;
      if (prow.ra_prefix && prow.ra_prefix.length >= 4) {
        const ex = await sb(`wh_ra_prefixes?prefix=eq.${encodeURIComponent(prow.ra_prefix)}&select=client_id,times_seen`);
        const exRow = (await ex.json())[0];
        if (!exRow) {
          await sb('wh_ra_prefixes', {
            method: 'POST',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify([{ prefix: prow.ra_prefix, client_id: clientId, source: 'confirmed' }]),
          });
          raNote = 'learned';
        } else if (exRow.client_id === clientId) {
          await sb(`wh_ra_prefixes?prefix=eq.${encodeURIComponent(prow.ra_prefix)}`, {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ times_seen: (exRow.times_seen || 0) + 1, last_seen: new Date().toISOString() }),
          });
          raNote = 'reinforced';
        } else {
          raNote = 'conflict';
        }
      }
      return json(200, { ok: true, client_code: crow.client_code, ra_prefix: prow.ra_prefix || null, ra_note: raNote });
    }

    return json(400, { error: 'unknown action' });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err).slice(0, 400) });
  }
};

// Exported for tests only.
exports._normTracking = normTracking;
