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
//   POST {action:'start', photo_url, scanned_raw?, operator?, force?} -> read_id
//   POST {action:'scan_only', scanned_raw, operator?, force?}        -> read (no photo)
//        Both answer 409 DUPLICATE {previous:[…]} when the same tracking was
//        already read in v2, unless force:true (the operator chose to redo it).
//   POST {action:'confirm', read_id, client_id, type?, carrier?, operator?}
//        -> records the operator's answer only (no shipments_general write)
//   POST {action:'register', read_id, client_id, type, carrier, operator}
//        -> LIVE: records the answer AND registers the package. If Receiving
//           (or anything else) already has the tracking — matched on the
//           normalised number — v2 only links to that row. Otherwise it writes
//           through frm-receive, the same function and contract Receiving uses,
//           and attaches the label photo to the new row.
//   POST {action:'attach_photo', read_id, photo_url, kind:'slip'|'label'}
//        -> appends a photo to the package's photo_urls (never replaces) and
//           returns the stored tracking so the handheld can call slip-extract
//   POST {action:'no_slip', read_id, operator}  -> carton came with no slip
//   POST {action:'undo', read_id, operator}
//        -> voids the read; if v2 created the shipments_general row it deletes
//           it, but only while unbilled and less than 48 h old
//
// Every read also carries `logged`: the shipments_general row for that
// tracking if Receiving already registered it. The handheld uses its id to
// print the inbound label through frm-print, exactly as Receiving does.
//
// LIVE MODE (1-Oct-2026, Jose: "run the test with everything"): 'register'
// writes to shipments_general — always through frm-receive, never directly —
// so billing, the daily WhatsApp summary, the Client Portal and Lookup see a
// v2 package exactly as they see a Receiving one. Everything else here still
// only touches v2's own tables. Accuracy: v_label_shadow / _summary, where the
// truth is the operator's confirmation (or Receiving's row when v2 did not
// create it).
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

// Where frm-receive lives. Netlify sets URL to the site's primary address.
const SITE = process.env.URL || 'https://apps.fr-logistics.net';

// Undo may delete a row v2 created only while it is fresh and unbilled.
const UNDO_MAX_HOURS = 48;

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
  'photo_url', 'shipment_id', 'registered', 'voided_at', 'voided_by', 'slip_status',
].join(',');

// Earlier v2 reads of the same package. Scanning a box twice used to pass in
// silence (1-Oct: 1ZA8337B0328668706 at 11:22 and again at 11:25). The handheld
// now warns, and the server refuses a second save unless the operator says so
// (force:true) — a repeat must be a decision, not an accident.
async function previousReads(tracking, excludeId) {
  if (!tracking) return [];
  const t = encodeURIComponent(tracking);
  let path = `wh_label_reads?or=(tracking.eq.${t},scanned_tracking.eq.${t})&voided_at=is.null` +
    '&select=id,created_at,operator,source,status,suggested_client_id,confirmed_client_id,resolution' +
    '&order=created_at.desc&limit=5';
  if (excludeId && UUID_RE.test(excludeId)) path += `&id=neq.${excludeId}`;
  const r = await sb(path);
  const rows = await r.json();
  if (!Array.isArray(rows)) return [];
  return rows.map((x) => ({
    id: x.id,
    at: x.created_at,
    operator: x.operator,
    source: x.source,
    status: x.status,
    client_code: (x.resolution && x.resolution.client_code) || null,
    suggested_client_id: x.suggested_client_id,
    confirmed_client_id: x.confirmed_client_id,
  }));
}

function duplicate(previous) {
  return json(409, {
    error: 'DUPLICATE',
    message: 'This package was already scanned in Receiving v2.',
    previous,
  });
}

// RA prefix learning — never overwrite a prefix that already points to another
// client: that is a conflict for a human, not for a tap.
async function learnRa(raPrefix, clientId) {
  if (!raPrefix || raPrefix.length < 4) return null;
  const ex = await sb(`wh_ra_prefixes?prefix=eq.${encodeURIComponent(raPrefix)}&select=client_id,times_seen`);
  const exRow = (await ex.json())[0];
  if (!exRow) {
    await sb('wh_ra_prefixes', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([{ prefix: raPrefix, client_id: clientId, source: 'confirmed' }]),
    });
    return 'learned';
  }
  if (exRow.client_id === clientId) {
    await sb(`wh_ra_prefixes?prefix=eq.${encodeURIComponent(raPrefix)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ times_seen: (exRow.times_seen || 0) + 1, last_seen: new Date().toISOString() }),
    });
    return 'reinforced';
  }
  return 'conflict';
}

async function loadRead(readId) {
  const r = await sb(`wh_label_reads?id=eq.${readId}&select=id,tracking,scanned_tracking,photo_url,shipment_id,registered,voided_at,route,ra_prefix,suggested_client_id&limit=1`);
  return (await r.json())[0] || null;
}

// A real, non-internal client, with the exact text Receiving stores in
// shipments_general.client (company first, contact as fallback).
async function loadClient(clientId) {
  const cr = await sb(`fr_clients?id=eq.${clientId}&select=id,client_code,company,name,type,status,receiving_mode&limit=1`);
  const c = (await cr.json())[0];
  if (!c || c.type === 'Internal' || c.status === 'Internal') return null;
  c.storeName = (c.company && c.company.trim()) || (c.name && c.name.trim()) || '';
  return c.storeName ? c : null;
}

// Append photos to a shipments_general row. shipment-photos-proxy REPLACES the
// array; a package can now carry the label photo and the slip photo, so this
// reads what is there and adds to it.
async function appendPhotos(shipmentId, urls) {
  const g = await sb(`shipments_general?id=eq.${shipmentId}&select=id,tracking,photo_urls&limit=1`);
  const row = (await g.json())[0];
  if (!row) return null;
  const merged = Array.from(new Set([...(row.photo_urls || []), ...urls.filter(Boolean)]));
  await sb(`shipments_general?id=eq.${shipmentId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ photo_urls: merged }),
  });
  return { ...row, photo_urls: merged };
}

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
        const [resolution, logged, previous] = await Promise.all([
          rpc('fr_resolve_label', { p_tracking: tracking }),
          rpc('fr_find_inbound', { p_tracking: tracking }),
          previousReads(tracking),
        ]);
        const instant = !!(resolution && resolution.client_id && INSTANT_METHODS.includes(resolution.method));
        return json(200, {
          tracking,
          carrier: carrierFromTracking(tracking),
          resolution,
          instant,
          logged: logged || null,
          previous,
        });
      }

      if (q.id) {
        if (!UUID_RE.test(q.id)) return json(400, { error: 'bad id' });
        const r = await sb(`wh_label_reads?id=eq.${q.id}&select=${CARD_COLUMNS}&limit=1`);
        const rows = await r.json();
        if (!Array.isArray(rows) || !rows.length) return json(404, { error: 'not found' });
        const read = (await withLogged(rows))[0];
        read.previous = await previousReads(read.tracking, read.id);
        return json(200, { read });
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
      if (!body.force) {
        const previous = await previousReads(normTracking(scannedRaw));
        if (previous.length) return duplicate(previous);
      }

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
      if (!body.force) {
        const previous = await previousReads(tracking);
        if (previous.length) return duplicate(previous);
      }
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

      const raNote = await learnRa(prow.ra_prefix, clientId);
      return json(200, { ok: true, client_code: crow.client_code, ra_prefix: prow.ra_prefix || null, ra_note: raNote });
    }

    // ─── register (LIVE) ─────────────────────────────────────────────────
    if (body.action === 'register') {
      const readId = String(body.read_id || '');
      const clientId = String(body.client_id || '');
      if (!UUID_RE.test(readId)) return json(400, { error: 'bad read_id' });
      if (!UUID_RE.test(clientId)) return json(400, { error: 'pick a client first' });
      const type = TYPES.includes(body.type) ? body.type : 'Inbound (General)';
      const carrier = CARRIERS.includes(body.carrier) ? body.carrier : 'Other';

      const read = await loadRead(readId);
      if (!read) return json(404, { error: 'read not found' });
      if (read.voided_at) return json(409, { error: 'VOIDED', message: 'This read was undone. Scan the package again.' });
      const tracking = read.tracking || read.scanned_tracking;
      if (!tracking) return json(400, { error: 'NO_TRACKING', message: 'No tracking on this read — scan the barcode and try again.' });
      const client = await loadClient(clientId);
      if (!client) return json(400, { error: 'unknown client' });

      const confirmPatch = {
        confirmed_client_id: clientId,
        confirmed_type: type,
        confirmed_carrier: carrier,
        confirmed_by: operator,
        confirmed_at: new Date().toISOString(),
      };
      const patchRead = (extra) => sb(`wh_label_reads?id=eq.${readId}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ ...confirmPatch, ...extra }),
      });
      const raNote = await learnRa(read.ra_prefix, clientId);
      const base = { ok: true, client_code: client.client_code, receiving_mode: client.receiving_mode || 'inventory', ra_prefix: read.ra_prefix || null, ra_note: raNote };

      // DropShipments are received in their own app (its trigger writes the
      // shipments_general rows). v2 records the answer and stops there.
      if (read.route === 'dropshipments' || type === 'Inbound (Drop-Shipment)') {
        await patchRead({});
        return json(200, { ...base, dropship: true });
      }

      // Idempotent: a retry after a dropped connection must not write twice.
      if (read.shipment_id) {
        await patchRead({});
        // A correction after saving: if v2 created the row and it is not
        // invoiced yet, the row follows the operator's new answer (the
        // trg_client_code trigger re-derives client_code). Rows Receiving
        // created are never edited from here.
        let corrected = false;
        if (read.registered) {
          const u = await sb(`shipments_general?id=eq.${read.shipment_id}&billed_at=is.null`, {
            method: 'PATCH', headers: { Prefer: 'return=representation' },
            body: JSON.stringify({ client: client.storeName, client_id: clientId, type, carrier }),
          });
          const ur = await u.json().catch(() => []);
          corrected = Array.isArray(ur) && ur.length === 1;
        }
        const s0 = await rpc('fr_find_shipment', { p_tracking: tracking });
        return json(200, { ...base, linked: !read.registered, registered: !!read.registered, updated: corrected, shipment: s0 });
      }

      // Already in shipments_general (Receiving, desktop, another v2 read)?
      const existing = await rpc('fr_find_shipment', { p_tracking: tracking });
      if (existing && existing.id) {
        await patchRead({ shipment_id: existing.id, registered: false });
        if (read.photo_url) await appendPhotos(existing.id, [read.photo_url]);
        return json(200, { ...base, linked: true, shipment: existing });
      }

      // New package: write through frm-receive (same contract as Receiving).
      const fr = await fetch(`${SITE}/.netlify/functions/frm-receive`, {
        method: 'POST',
        // auth-gate.js sits in front of every function: a call between our own
        // functions must carry the service key as Bearer (its rule 3), or the
        // gate answers 401 "Not signed in" before frm-receive ever runs.
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://apps.fr-logistics.net',
          Authorization: `Bearer ${SB_KEY}`,
        },
        body: JSON.stringify({
          tracking, client: client.storeName, client_id: clientId,
          type, carrier, direction: 'Inbound', operator: operator || '',
        }),
      });
      const fj = await fr.json().catch(() => ({}));
      if (fr.status === 409) {
        // Lost a race with Receiving: link to whoever won.
        const won = fj.existing || (await rpc('fr_find_shipment', { p_tracking: tracking }));
        if (won && won.id) {
          await patchRead({ shipment_id: won.id, registered: false });
          if (read.photo_url) await appendPhotos(won.id, [read.photo_url]);
          return json(200, { ...base, linked: true, shipment: won });
        }
        return json(409, { error: 'DUPLICATE_UNRESOLVED', message: 'Receiving says it exists but it could not be found.' });
      }
      if (!fr.ok || !fj.id) {
        return json(502, { error: 'REGISTER_FAILED', message: `Could not register (frm-receive ${fr.status}${fj.error ? ': ' + fj.error : ''}). Nothing was saved — try again.` });
      }

      await patchRead({ shipment_id: fj.id, registered: true });
      if (read.photo_url) await appendPhotos(fj.id, [read.photo_url]);
      const created = await rpc('fr_find_shipment', { p_tracking: tracking });
      return json(200, { ...base, registered: true, shipment: created || { id: fj.id, tracking } });
    }

    // ─── attach_photo (slip or extra label photo) ───────────────────────
    if (body.action === 'attach_photo') {
      const readId = String(body.read_id || '');
      const photoUrl = String(body.photo_url || '').trim();
      if (!UUID_RE.test(readId)) return json(400, { error: 'bad read_id' });
      if (!photoUrl.startsWith(ALLOWED_PHOTO_PREFIX)) return json(400, { error: 'photo_url is not a shipment photo of ours' });
      const read = await loadRead(readId);
      if (!read || !read.shipment_id) return json(409, { error: 'NOT_REGISTERED', message: 'Save the package first.' });
      const row = await appendPhotos(read.shipment_id, [photoUrl]);
      if (!row) return json(404, { error: 'shipment not found' });
      if (body.kind === 'slip') {
        await sb(`wh_label_reads?id=eq.${readId}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ slip_status: 'photo' }),
        });
      }
      return json(200, { ok: true, tracking: row.tracking, photos: row.photo_urls.length });
    }

    // ─── no_slip ────────────────────────────────────────────────────────
    // Same fields frm-slip-status writes, so Receiving and the coverage
    // numbers read it the same way.
    if (body.action === 'no_slip') {
      const readId = String(body.read_id || '');
      if (!UUID_RE.test(readId)) return json(400, { error: 'bad read_id' });
      const read = await loadRead(readId);
      if (!read || !read.shipment_id) return json(409, { error: 'NOT_REGISTERED', message: 'Save the package first.' });
      await sb(`shipments_general?id=eq.${read.shipment_id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ slip_status: 'no_slip', slip_status_by: operator, slip_status_at: new Date().toISOString() }),
      });
      await sb(`wh_label_reads?id=eq.${readId}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ slip_status: 'no_slip' }),
      });
      return json(200, { ok: true });
    }

    // ─── undo ───────────────────────────────────────────────────────────
    if (body.action === 'undo') {
      const readId = String(body.read_id || '');
      if (!UUID_RE.test(readId)) return json(400, { error: 'bad read_id' });
      const read = await loadRead(readId);
      if (!read) return json(404, { error: 'read not found' });
      if (read.voided_at) return json(200, { ok: true, already: true });

      let deleted = false;
      if (read.registered && read.shipment_id) {
        const g = await sb(`shipments_general?id=eq.${read.shipment_id}&select=id,billed_at,created_at&limit=1`);
        const row = (await g.json())[0];
        if (row) {
          if (row.billed_at) return json(409, { error: 'BILLED', message: 'Already invoiced — it cannot be undone from the handheld. Tell Jose.' });
          const ageH = (Date.now() - new Date(row.created_at).getTime()) / 36e5;
          if (ageH > UNDO_MAX_HOURS) return json(409, { error: 'TOO_OLD', message: `Older than ${UNDO_MAX_HOURS} h — fix it from the desktop app.` });
          const d = await sb(`shipments_general?id=eq.${row.id}&billed_at=is.null`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
          const gone = await d.json().catch(() => []);
          deleted = Array.isArray(gone) && gone.length === 1;
          if (!deleted) return json(409, { error: 'NOT_DELETED', message: 'The row changed in the meantime — reload and try again.' });
        }
      }
      await sb(`wh_label_reads?id=eq.${readId}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ voided_at: new Date().toISOString(), voided_by: operator }),
      });
      return json(200, { ok: true, deleted_shipment: deleted });
    }

    return json(400, { error: 'unknown action' });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err).slice(0, 400) });
  }
};

// Exported for tests only.
exports._normTracking = normTracking;
exports._INSTANT_METHODS = INSTANT_METHODS;
