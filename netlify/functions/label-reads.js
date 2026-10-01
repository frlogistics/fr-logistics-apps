// netlify/functions/label-reads.js
// FR-Logistics · Receiving v2 — everything the handheld waits on.
//
// Receiving v2 proposes client, carrier, tracking and type for a package. Two
// ways to get there:
//
//   FAST (scan only, < 1 s) — the tracking alone is often enough: a return label
//   we created, an announced DropShipment, our own outbound coming back, a box
//   whose master is already logged. GET ?probe= answers that straight from the
//   database; if it is known, the operator saves without a photo
//   (POST action 'scan_only').
//
//   PHOTO (10-20 s, in the background) — when the tracking says nothing, the
//   label photo is read by label-extract-background.js. The handheld never
//   waits on it: it creates the row (action 'start'), fires the background
//   function and goes back to scanning; the result shows up in the list.
//
// Endpoints:
//   GET  ?probe=<raw scan>              -> instant resolution from the tracking
//   GET  ?id=<uuid>                     -> one read, shaped for the handheld card
//   GET  ?ids=<uuid>,<uuid>…            -> several reads (polling the queue)
//   GET  ?recent=1[&operator=<name>]    -> today's reads (newest first, max 40)
//   GET  ?summary=1                     -> shadow-mode accuracy (v_label_shadow_summary)
//   POST {action:'start', photo_url, scanned_raw?, operator?}      -> read_id
//   POST {action:'scan_only', scanned_raw, operator?}              -> read (no photo)
//   POST {action:'confirm', read_id, client_id, type?, carrier?, operator?}
//
// Every read also carries `logged`: the shipments_general row for that
// tracking if Receiving already registered it. The handheld uses its id to
// print the inbound label through frm-print, exactly as Receiving does.
//
// SHADOW MODE RULE: nothing here writes to shipments_general. Receiving stays
// the module that registers the package and drives billing; v2 only records
// what it WOULD have proposed (v_label_shadow compares the two).
//
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY (already set). No new variables.

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

// Only photos that live in our own bucket — never an arbitrary URL.
const ALLOWED_PHOTO_PREFIX = `${SB_URL}/storage/v1/object/public/shipment-photos/`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Sources strong enough to skip the photo. All of them come from our own
// records about THIS tracking number, not from reading text.
const INSTANT_METHODS = ['dropshipment', 'outbound_return', 'return_label', 'sibling_box'];

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

async function rpc(fn, args) {
  const r = await sb(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
  if (!r.ok) throw new Error(`${fn} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
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

// Mirror of public.fr_tracking_carrier().
function carrierFromTracking(t) {
  if (!t) return null;
  if (/^1Z[0-9A-Z]{16}$/.test(t)) return 'UPS';
  if (/^9[2-5]\d{20}$/.test(t)) return 'USPS';
  if (/^TBA\d+$/.test(t)) return 'Amazon';
  if (/^\d{12}$/.test(t) || /^\d{15}$/.test(t)) return 'FedEx';
  return null;
}

// The columns the handheld card needs — no model internals, no raw response.
const CARD_COLUMNS = [
  'id', 'created_at', 'operator', 'status', 'error', 'confidence', 'source',
  'scanned_tracking', 'tracking', 'tracking_read', 'tracking_match',
  'carrier', 'service', 'master_tracking', 'piece_no', 'piece_total',
  'ship_from_name', 'ship_from_city', 'ship_from_state', 'ship_from_is_fr',
  'ra_number', 'origin_fc', 'refs', 'weight_lb', 'description',
  'suggested_client_id', 'suggested_type', 'suggested_carrier', 'match_method', 'route', 'resolution',
  'confirmed_client_id', 'confirmed_type', 'confirmed_carrier', 'confirmed_by', 'confirmed_at',
  'photo_url',
].join(',');

// Attach the Receiving row (if any) so the handheld can offer 🖨 Print.
async function withLogged(reads) {
  const out = [];
  for (const r of reads) {
    let logged = null;
    if (r.tracking && r.status !== 'pending') {
      try { logged = await rpc('fr_find_inbound', { p_tracking: r.tracking }); } catch { logged = null; }
    }
    out.push({ ...r, logged: logged || null });
  }
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!SB_URL || !SB_KEY) return json(500, { error: 'Supabase not configured' });

  try {
    // ─── GET ────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};

      // Instant: what does the tracking alone tell us?
      if (q.probe) {
        const tracking = normTracking(String(q.probe).slice(0, 200));
        if (!tracking) return json(400, { error: 'empty scan' });
        const [resolution, logged] = await Promise.all([
          rpc('fr_resolve_label', { p_tracking: tracking }),
          rpc('fr_find_inbound', { p_tracking: tracking }),
        ]);
        const instant = !!(resolution && resolution.client_id && INSTANT_METHODS.includes(resolution.method));
        return json(200, {
          tracking,
          carrier: carrierFromTracking(tracking),
          resolution,
          instant,
          logged: logged || null,
        });
      }

      if (q.id) {
        if (!UUID_RE.test(q.id)) return json(400, { error: 'bad id' });
        const r = await sb(`wh_label_reads?id=eq.${q.id}&select=${CARD_COLUMNS}&limit=1`);
        const rows = await r.json();
        if (!Array.isArray(rows) || !rows.length) return json(404, { error: 'not found' });
        return json(200, { read: (await withLogged(rows))[0] });
      }

      if (q.ids) {
        const ids = String(q.ids).split(',').filter((x) => UUID_RE.test(x)).slice(0, 20);
        if (!ids.length) return json(200, { reads: [] });
        const r = await sb(`wh_label_reads?id=in.(${ids.join(',')})&select=${CARD_COLUMNS}`);
        const rows = await r.json();
        return json(200, { reads: Array.isArray(rows) ? await withLogged(rows) : [] });
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
        const rows = await r.json();
        return json(200, { reads: Array.isArray(rows) ? rows : [] });
      }

      if (q.summary) {
        const r = await sb('v_label_shadow_summary?select=*');
        const rows = await r.json();
        return json(200, { summary: Array.isArray(rows) ? rows[0] : null });
      }

      return json(400, { error: 'use ?probe=, ?id=, ?ids=, ?recent=1 or ?summary=1' });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }
    const operator = String(body.operator || '').trim().slice(0, 60) || null;

    // ─── start (photo read) ─────────────────────────────────────────────
    if (body.action === 'start') {
      const photoUrl = String(body.photo_url || '').trim();
      if (!photoUrl.startsWith(ALLOWED_PHOTO_PREFIX)) return json(400, { error: 'photo_url is not a shipment photo of ours' });
      const scannedRaw = body.scanned_raw ? String(body.scanned_raw).slice(0, 200) : null;

      const r = await sb('wh_label_reads?on_conflict=photo_url', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify([{
          photo_url: photoUrl,
          source: 'photo',
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

    // ─── scan_only (no photo) ───────────────────────────────────────────
    // Resolved again here from the database — the handheld's copy of the
    // probe is never trusted as the answer.
    if (body.action === 'scan_only') {
      const scannedRaw = String(body.scanned_raw || '').slice(0, 200);
      const tracking = normTracking(scannedRaw);
      if (!tracking) return json(400, { error: 'scan a tracking first' });
      const resolution = await rpc('fr_resolve_label', { p_tracking: tracking });
      if (!resolution || !resolution.client_id || !INSTANT_METHODS.includes(resolution.method)) {
        return json(409, { error: 'NOT_KNOWN', message: 'This tracking is not known from our records — take the photo.' });
      }
      const carrier = carrierFromTracking(tracking);
      const r = await sb('wh_label_reads', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify([{
          photo_url: null,
          source: 'scan',
          scanned_raw: scannedRaw,
          scanned_tracking: tracking,
          tracking,
          tracking_match: null,
          operator,
          mode: 'shadow',
          status: 'ok',
          confidence: 1,
          completed_at: new Date().toISOString(),
          carrier: carrier || null,
          suggested_carrier: carrier || null,
          suggested_client_id: resolution.client_id,
          suggested_type: resolution.suggested_type || null,
          match_method: resolution.method,
          route: resolution.route || null,
          resolution,
        }]),
      });
      const rows = await r.json();
      if (!r.ok || !Array.isArray(rows) || !rows.length) return json(500, { error: 'could not save', detail: rows });
      const shaped = { ...rows[0] };
      return json(200, { read: (await withLogged([shaped]))[0] });
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
exports._INSTANT_METHODS = INSTANT_METHODS;
