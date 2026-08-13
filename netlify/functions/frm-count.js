// netlify/functions/frm-count.js
// FR Mobile + Portal — physical / cycle count module.
// Single endpoint: freeze a snapshot, walk locations, capture counts blind,
// then read the variance. Writes with the service key (RLS stays closed),
// same pattern as frm-fba.js and frm-receive.js.
//
// Actions (POST body.action, or GET ?action=):
//   GET  ?action=preflight&client_id=…      snapshot freshness + what's in scope
//   GET  ?action=counts&status=…            list counts (+ summary numbers)
//   GET  ?action=count&count_id=…           header + per-location progress
//   GET  ?action=locations&count_id=…       walk list for the handheld
//   GET  ?action=lines&count_id=…&location_code=…   what's been counted here
//   GET  ?action=variance&count_id=…        variance rows + SKU rollup + summary
//   GET  ?action=resolve_code&code=…&count_id=…     scanned code -> merchant SKU
//   POST create_count      { client_id, reference, scope?, started_by?, confirm_stale? }
//   POST start_location    { count_id, location_code, operator? }
//   POST add_line          { count_id, location_code, code?, sku, qty, sku_source?, counted_by?, line_uid? }
//   POST void_line         { line_id, voided_by? }
//   POST close_location    { count_id, location_code, operator?, note? }
//   POST recount_location  { count_id, location_code, operator? }
//   POST finish_count      { count_id, by? }     open  -> review (unlocks variance)
//   POST close_count       { count_id, by?, applied? }  review -> closed
//   POST cancel_count      { count_id, by?, reason? }
//
// ── THE THREE RULES THIS FILE ENFORCES ─────────────────────────────────────
//
// BLIND IS ENFORCED HERE, NOT IN THE UI. While a count is open, no endpoint
// returns qty_expected — not even to an authenticated caller. If the expected
// number can reach the screen, sooner or later it reaches the counter's eye,
// and a count that agrees with the system by suggestion is worse than no count
// at all, because it launders the error into a signed document.
//
// A LOCATION THAT WAS NEVER VISITED IS NOT A LOSS. Every comparison runs off
// wh_count_locations.status. Skipping this is how a half-finished count turns
// into a panic about missing stock.
//
// THE SNAPSHOT IS FROZEN AT CREATION. inventory-locations-sync keeps running
// on its 2-hour cron during the walk; if the count read live data, "expected"
// would drift mid-count and the variance would be unreproducible tomorrow.

const ALLOWED_ORIGINS = [
  'https://apps.fr-logistics.net',
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
];

// How stale the SkuVault mirror may be before creating a count needs a
// deliberate override. The sync runs every 2h, so anything past ~2.5h means it
// did not run, and counting against yesterday's picture wastes the whole walk.
const SNAPSHOT_MAX_AGE_MIN = 150;

const VARIANCE_ORDER = { MISSING: 0, SHORT: 1, OVER: 2, UNEXPECTED: 3, NOT_COUNTED: 4, OK: 5 };

// ── pure helpers (no I/O — safe to unit test) ────────────────────────────────

function ageMinutes(iso, now = Date.now()) {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Infinity;
  return Math.round((now - t) / 60000);
}

// Builds the frozen snapshot rows from the live mirror. Kept pure so the
// client-filter logic is testable without hitting Postgres.
function buildSnapshot(inventoryRows, skuClientRows, { client }) {
  const owner = new Map();
  for (const r of skuClientRows || []) {
    if (r && r.sku) owner.set(String(r.sku), r.client || null);
  }
  const wanted = client ? String(client).trim().toLowerCase() : null;

  const rows = [];
  let units = 0;
  let latest = null;

  for (const r of inventoryRows || []) {
    if (!r || !r.sku || !r.location_code) continue;
    const own = owner.get(String(r.sku)) || null;
    if (wanted && String(own || '').trim().toLowerCase() !== wanted) continue;
    const qty = Number(r.quantity) || 0;
    rows.push({
      sku: String(r.sku),
      location_code: String(r.location_code).toUpperCase(),
      qty_expected: qty,
      client: own,
    });
    units += qty;
    if (r.synced_at && (!latest || r.synced_at > latest)) latest = r.synced_at;
  }

  const locations = [...new Set(rows.map((r) => r.location_code))].sort();
  return { rows, units, locations, snapshot_at: latest };
}

// Strips expected quantities from anything leaving the server while the count
// is still open and blind. One function, applied at every exit, so a new
// endpoint cannot forget the rule by accident.
function redactIfBlind(count, payload) {
  if (!count || !count.blind || count.status !== 'open') return payload;
  const scrub = (row) => {
    if (!row || typeof row !== 'object') return row;
    const out = { ...row };
    delete out.qty_expected;
    delete out.diff;
    delete out.variance;
    delete out.expected_counted_locs;
    delete out.expected_pending;
    delete out.net_diff;
    delete out.verdict;
    delete out.units_off;
    delete out.snapshot_units;
    delete out.lines_ok;
    delete out.lines_compared;
    delete out.variance_lines;
    return out;
  };
  if (Array.isArray(payload)) return payload.map(scrub);
  return scrub(payload);
}

function sortVariance(rows) {
  return [...rows].sort((a, b) => {
    const va = VARIANCE_ORDER[a.variance] ?? 9;
    const vb = VARIANCE_ORDER[b.variance] ?? 9;
    if (va !== vb) return va - vb;
    if (a.location_code !== b.location_code) return a.location_code < b.location_code ? -1 : 1;
    return a.sku < b.sku ? -1 : 1;
  });
}

function validQty(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 100000;
}

// ── handler ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin',
    'Content-Type': 'application/json',
  };
  const res = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) return res(500, { error: 'Supabase not configured' });

  const sb = async (path, opts = {}) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...opts,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    const text = await r.text();
    if (!r.ok) {
      const err = new Error(`Supabase ${r.status}: ${text}`);
      err.status = r.status;
      err.body = text;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  };

  const post = (table, rows, prefer = 'return=representation') =>
    sb(table, { method: 'POST', headers: { Prefer: prefer }, body: JSON.stringify(rows) });
  const patch = (path, body) =>
    sb(path, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) });

  const enc = encodeURIComponent;

  const getCount = async (id) => {
    if (!id) return null;
    const rows = await sb(`wh_counts?id=eq.${enc(id)}&select=*&limit=1`);
    return rows && rows[0] ? rows[0] : null;
  };

  // Same four-step resolution the FBA module uses, so a code confirmed once in
  // either module is understood by both. wh_fnsku_map is wiped and rebuilt by
  // frm-alias-sync, which is why manual confirmations are read back off the
  // lines instead of written into the map.
  const resolveCode = async (code, countId) => {
    const hit = await sb(`wh_fnsku_map?code=eq.${enc(code)}&select=sku&limit=1`);
    if (hit && hit[0] && hit[0].sku) return { sku: hit[0].sku, source: 'map', mapped: true };

    const asSku = await sb(`wh_fnsku_map?sku=eq.${enc(code)}&select=sku&limit=1`);
    if (asSku && asSku[0] && asSku[0].sku) return { sku: asSku[0].sku, source: 'scanned_sku', mapped: true };

    if (countId) {
      try {
        const prior = await sb(
          `wh_count_lines?count_id=eq.${enc(countId)}&code_scanned=eq.${enc(code)}&voided=is.false` +
          '&select=sku,counted_by,counted_at&order=counted_at.desc&limit=1'
        );
        if (prior && prior[0] && prior[0].sku) {
          return {
            sku: prior[0].sku,
            source: 'memory',
            mapped: true,
            confirmed_by: prior[0].counted_by || null,
            confirmed_at: prior[0].counted_at || null,
          };
        }
      } catch { /* memory is an accelerator, never a reason to fail a scan */ }
    }

    let suggestions = [];
    try {
      const like = await sb(`wh_fnsku_map?sku=ilike.*${enc(code)}*&select=sku&limit=5`);
      suggestions = [...new Set((like || []).map((r) => r.sku))];
    } catch { /* nicety only */ }

    return { sku: null, source: null, mapped: false, suggestions };
  };

  try {
    const qs = event.queryStringParameters || {};
    let body = {};
    if (event.httpMethod === 'POST') {
      try { body = JSON.parse(event.body || '{}'); }
      catch { return res(400, { error: 'Invalid JSON body' }); }
    }
    const action = (event.httpMethod === 'GET' ? qs.action : body.action) || '';

    // ── READS ───────────────────────────────────────────────────────────────

    if (action === 'preflight') {
      const clientId = qs.client_id || '';
      if (!clientId) return res(400, { error: 'client_id is required' });

      const cli = await sb(`fr_clients?id=eq.${enc(clientId)}&select=id,company,name&limit=1`);
      if (!cli || !cli[0]) return res(404, { error: 'Client not found' });
      const clientName = cli[0].company || cli[0].name;

      const [inv, owners, live] = await Promise.all([
        sb('inventory_by_location?select=sku,location_code,quantity,synced_at&limit=20000'),
        sb('wh_sku_clients?select=sku,client&limit=20000'),
        sb(`wh_counts?client_id=eq.${enc(clientId)}&status=in.(open,review)&select=id,reference,status&limit=1`),
      ]);

      const snap = buildSnapshot(inv, owners, { client: clientName });
      const age = ageMinutes(snap.snapshot_at);

      return res(200, {
        client: clientName,
        client_id: clientId,
        rows: snap.rows.length,
        units: snap.units,
        locations: snap.locations.length,
        snapshot_at: snap.snapshot_at,
        snapshot_age_min: Number.isFinite(age) ? age : null,
        stale: age > SNAPSHOT_MAX_AGE_MIN,
        max_age_min: SNAPSHOT_MAX_AGE_MIN,
        live_count: live && live[0] ? live[0] : null,
      });
    }

    if (action === 'counts') {
      const status = qs.status || 'live';
      let filter = '';
      if (status === 'live') filter = '&status=in.(open,review)';
      else if (status !== 'all') filter = `&status=eq.${enc(status)}`;
      const rows = await sb(`v_wh_count_summary?select=*${filter}&order=created_at.desc&limit=100`);
      // Summary carries expected units; blank them out for any count still open
      // and blind so the list screen cannot leak the target either.
      const safe = (rows || []).map((r) =>
        r.status === 'open' ? redactIfBlind({ blind: true, status: 'open' }, r) : r
      );
      return res(200, { counts: safe });
    }

    if (action === 'count' || action === 'locations') {
      const countId = qs.count_id || '';
      const count = await getCount(countId);
      if (!count) return res(404, { error: 'Count not found' });

      const locs = await sb(
        `wh_count_locations?count_id=eq.${enc(countId)}&select=*&order=location_code.asc&limit=2000`
      );

      // Line counts per location are safe to show while blind: they say how
      // much the operator has entered, never how much was expected.
      const lines = await sb(
        `wh_count_lines?count_id=eq.${enc(countId)}&voided=is.false&select=location_code,qty,pass&limit=20000`
      );
      const tally = new Map();
      for (const l of lines || []) {
        const k = l.location_code;
        const t = tally.get(k) || { skus: 0, units: 0 };
        t.units += Number(l.qty) || 0;
        t.skus += 1;
        tally.set(k, t);
      }

      const locations = (locs || []).map((l) => ({
        ...l,
        counted_lines: (tally.get(l.location_code) || {}).skus || 0,
        counted_units: (tally.get(l.location_code) || {}).units || 0,
      }));

      const summary = await sb(`v_wh_count_summary?count_id=eq.${enc(countId)}&select=*&limit=1`);

      return res(200, {
        count,
        locations,
        summary: redactIfBlind(count, (summary && summary[0]) || null),
        progress: {
          total: locations.length,
          counted: locations.filter((l) => l.status === 'counted' || l.status === 'recount').length,
        },
      });
    }

    if (action === 'lines') {
      const countId = qs.count_id || '';
      const loc = (qs.location_code || '').toUpperCase();
      if (!countId || !loc) return res(400, { error: 'count_id and location_code are required' });
      const rows = await sb(
        `wh_count_lines?count_id=eq.${enc(countId)}&location_code=eq.${enc(loc)}&voided=is.false` +
        '&select=*&order=counted_at.desc&limit=1000'
      );
      return res(200, { lines: rows || [] });
    }

    if (action === 'variance') {
      const countId = qs.count_id || '';
      const count = await getCount(countId);
      if (!count) return res(404, { error: 'Count not found' });

      // The blind gate. Not a UI preference — the numbers do not leave the
      // server until capture is finished.
      if (count.blind && count.status === 'open') {
        return res(409, {
          error: 'COUNT_STILL_OPEN',
          message: 'The variance stays sealed until capture is finished. Finish the count first.',
          count_id: countId,
          progress_hint: 'POST finish_count to move it to review.',
        });
      }

      const [rows, rollup, summary] = await Promise.all([
        sb(`v_wh_count_variance?count_id=eq.${enc(countId)}&select=*&limit=20000`),
        sb(`v_wh_count_sku_rollup?count_id=eq.${enc(countId)}&select=*&limit=20000`),
        sb(`v_wh_count_summary?count_id=eq.${enc(countId)}&select=*&limit=1`),
      ]);

      const all = sortVariance(rows || []);
      return res(200, {
        count,
        summary: (summary && summary[0]) || null,
        variance: all,
        exceptions: all.filter((r) => ['MISSING', 'SHORT', 'OVER', 'UNEXPECTED'].includes(r.variance)),
        pending: all.filter((r) => r.variance === 'NOT_COUNTED'),
        rollup: (rollup || []).sort((a, b) => Math.abs(b.net_diff || 0) - Math.abs(a.net_diff || 0)),
      });
    }

    if (action === 'resolve_code') {
      const code = (qs.code || '').trim();
      if (!code) return res(400, { error: 'code is required' });
      const r = await resolveCode(code, qs.count_id || '');
      return res(200, r);
    }

    // ── WRITES ──────────────────────────────────────────────────────────────

    if (event.httpMethod !== 'POST') return res(405, { error: 'Method not allowed' });

    if (action === 'create_count') {
      const clientId = body.client_id || '';
      const reference = String(body.reference || '').trim();
      if (!clientId) return res(400, { error: 'client_id is required' });
      if (!reference) return res(400, { error: 'reference is required' });
      if (reference.length > 60) return res(400, { error: 'reference exceeds 60 characters' });

      const existing = await sb(
        `wh_counts?client_id=eq.${enc(clientId)}&status=in.(open,review)&select=id,reference,status&limit=1`
      );
      if (existing && existing[0]) {
        return res(409, {
          error: 'COUNT_ALREADY_LIVE',
          message: `${existing[0].reference} is still ${existing[0].status}. Finish or cancel it before starting another.`,
          count: existing[0],
        });
      }

      const cli = await sb(`fr_clients?id=eq.${enc(clientId)}&select=id,company,name&limit=1`);
      if (!cli || !cli[0]) return res(404, { error: 'Client not found' });
      const clientName = cli[0].company || cli[0].name;

      const [inv, owners] = await Promise.all([
        sb('inventory_by_location?select=sku,location_code,quantity,synced_at&limit=20000'),
        sb('wh_sku_clients?select=sku,client&limit=20000'),
      ]);

      const scope = body.scope === 'all' ? 'all' : 'client';
      const snap = buildSnapshot(inv, owners, { client: scope === 'all' ? null : clientName });

      if (!snap.rows.length) {
        return res(400, {
          error: 'EMPTY_SNAPSHOT',
          message: `No stock on file for ${clientName}. Refresh the SkuVault sync, or check the SKU-to-client map.`,
        });
      }

      const age = ageMinutes(snap.snapshot_at);
      if (age > SNAPSHOT_MAX_AGE_MIN && !body.confirm_stale) {
        return res(409, {
          error: 'STALE_SNAPSHOT',
          message: `The SkuVault mirror was last synced ${age} minutes ago. Refresh it, or resend with confirm_stale to count against this picture anyway.`,
          snapshot_at: snap.snapshot_at,
          snapshot_age_min: age,
          max_age_min: SNAPSHOT_MAX_AGE_MIN,
        });
      }

      const created = await post('wh_counts', [{
        client_id: clientId,
        client: clientName,
        reference,
        scope,
        status: 'open',
        blind: body.blind === false ? false : true,
        snapshot_at: snap.snapshot_at,
        snapshot_rows: snap.rows.length,
        snapshot_units: snap.units,
        started_by: body.started_by ? String(body.started_by).slice(0, 60) : null,
        notes: body.notes ? String(body.notes).slice(0, 2000) : null,
      }]);
      const count = created[0];

      // Snapshot and walk list are written immediately after the header. If
      // either insert fails the count is cancelled rather than left half-built,
      // because a partial snapshot reads as missing stock later.
      try {
        const CHUNK = 500;
        const snapRows = snap.rows.map((r) => ({ ...r, count_id: count.id }));
        for (let i = 0; i < snapRows.length; i += CHUNK) {
          await post('wh_count_snapshot', snapRows.slice(i, i + CHUNK), 'return=minimal');
        }
        await post(
          'wh_count_locations',
          snap.locations.map((location_code) => ({ count_id: count.id, location_code, in_scope: true })),
          'return=minimal'
        );
      } catch (e) {
        await patch(`wh_counts?id=eq.${enc(count.id)}`, {
          status: 'cancelled',
          notes: 'Auto-cancelled: snapshot build failed.',
          updated_at: new Date().toISOString(),
        }).catch(() => {});
        return res(500, { error: 'SNAPSHOT_BUILD_FAILED', message: String(e.message || e) });
      }

      return res(200, {
        count: redactIfBlind(count, count),
        locations: snap.locations.length,
        rows: snap.rows.length,
        snapshot_age_min: Number.isFinite(age) ? age : null,
      });
    }

    if (action === 'start_location' || action === 'close_location' || action === 'recount_location') {
      const countId = body.count_id || '';
      const loc = String(body.location_code || '').trim().toUpperCase();
      if (!countId || !loc) return res(400, { error: 'count_id and location_code are required' });

      const count = await getCount(countId);
      if (!count) return res(404, { error: 'Count not found' });
      if (count.status !== 'open' && action !== 'recount_location') {
        return res(409, { error: 'COUNT_NOT_OPEN', message: `This count is ${count.status}.` });
      }
      if (action === 'recount_location' && !['open', 'review'].includes(count.status)) {
        return res(409, { error: 'COUNT_CLOSED', message: 'A closed count cannot be recounted. Start a new one.' });
      }

      const rows = await sb(
        `wh_count_locations?count_id=eq.${enc(countId)}&location_code=eq.${enc(loc)}&select=*&limit=1`
      );
      const now = new Date().toISOString();
      const who = body.operator ? String(body.operator).slice(0, 60) : null;

      // An unknown location during the walk is a finding, not an error: stock
      // turned up somewhere the snapshot never mentioned. It gets a row with
      // in_scope=false so it lands in the report as UNEXPECTED.
      if (!rows || !rows[0]) {
        if (action !== 'start_location') {
          return res(404, { error: 'LOCATION_NOT_IN_COUNT', message: `${loc} is not part of this count.` });
        }
        const known = await sb(`wh_locations?location_code=eq.${enc(loc)}&select=location_code&limit=1`);
        const created = await post('wh_count_locations', [{
          count_id: countId, location_code: loc, status: 'counting',
          in_scope: false, counted_by: who,
        }]);
        return res(200, {
          location: created[0],
          added: true,
          known_location: !!(known && known[0]),
          message: `${loc} was not in the snapshot — counting it as an extra location.`,
        });
      }

      const cur = rows[0];
      let payload;
      if (action === 'start_location') {
        payload = cur.status === 'pending' ? { status: 'counting', counted_by: who } : {};
      } else if (action === 'close_location') {
        payload = cur.pass > 1
          ? { status: 'recount', recounted_by: who, recounted_at: now, note: body.note || cur.note }
          : { status: 'counted', counted_by: who || cur.counted_by, counted_at: now, note: body.note || cur.note };
      } else {
        payload = { status: 'counting', pass: (cur.pass || 1) + 1, recounted_by: who };
      }

      const updated = Object.keys(payload).length
        ? await patch(`wh_count_locations?count_id=eq.${enc(countId)}&location_code=eq.${enc(loc)}`, payload)
        : [cur];

      return res(200, { location: updated[0] });
    }

    if (action === 'add_line') {
      const countId = body.count_id || '';
      const loc = String(body.location_code || '').trim().toUpperCase();
      const sku = String(body.sku || '').trim();
      if (!countId || !loc) return res(400, { error: 'count_id and location_code are required' });
      if (!sku) return res(400, { error: 'sku is required' });
      if (sku.length > 80) return res(400, { error: 'sku exceeds 80 characters' });
      if (!validQty(body.qty)) return res(400, { error: 'qty must be a whole number between 1 and 100000' });

      const count = await getCount(countId);
      if (!count) return res(404, { error: 'Count not found' });
      if (count.status !== 'open') {
        return res(409, {
          error: 'COUNT_NOT_OPEN',
          message: `This count is ${count.status} — capture is finished. Reopen a location to recount it.`,
        });
      }

      const locRows = await sb(
        `wh_count_locations?count_id=eq.${enc(countId)}&location_code=eq.${enc(loc)}&select=*&limit=1`
      );
      if (!locRows || !locRows[0]) {
        return res(409, {
          error: 'LOCATION_NOT_STARTED',
          message: `Scan ${loc} to open it before adding lines.`,
        });
      }
      const locRow = locRows[0];
      if (locRow.status === 'counted' || locRow.status === 'recount') {
        return res(409, {
          error: 'LOCATION_CLOSED',
          message: `${loc} is already closed. Reopen it as a recount to change what's in it.`,
          location: locRow,
        });
      }

      const row = {
        count_id: countId,
        location_code: loc,
        pass: locRow.pass || 1,
        code_scanned: body.code ? String(body.code).trim().slice(0, 120) : null,
        sku,
        qty: Number(body.qty),
        sku_source: ['map', 'scanned_sku', 'memory', 'manual'].includes(body.sku_source) ? body.sku_source : null,
        counted_by: body.counted_by ? String(body.counted_by).slice(0, 60) : null,
        line_uid: body.line_uid ? String(body.line_uid).slice(0, 80) : null,
      };

      let inserted;
      try {
        inserted = await post('wh_count_lines', [row]);
      } catch (e) {
        // 23505 on line_uid means the handheld retried a scan that already
        // landed. Returning the existing line keeps the screen truthful
        // instead of showing a failure for work that is safely recorded.
        if (e.status === 409 && row.line_uid && /idx_wh_count_lines_uid/.test(e.body || '')) {
          const dupe = await sb(
            `wh_count_lines?count_id=eq.${enc(countId)}&line_uid=eq.${enc(row.line_uid)}&select=*&limit=1`
          );
          return res(200, { line: dupe && dupe[0], duplicate: true });
        }
        throw e;
      }

      if (locRow.status === 'pending') {
        await patch(`wh_count_locations?count_id=eq.${enc(countId)}&location_code=eq.${enc(loc)}`, {
          status: 'counting',
          counted_by: row.counted_by || locRow.counted_by,
        }).catch(() => {});
      }

      const running = await sb(
        `wh_count_lines?count_id=eq.${enc(countId)}&location_code=eq.${enc(loc)}&voided=is.false` +
        `&pass=eq.${row.pass}&select=sku,qty&limit=1000`
      );
      const units = (running || []).reduce((n, l) => n + (Number(l.qty) || 0), 0);

      return res(200, {
        line: inserted[0],
        location_running: { lines: (running || []).length, units, skus: new Set((running || []).map((l) => l.sku)).size },
      });
    }

    if (action === 'void_line') {
      const lineId = body.line_id || '';
      if (!lineId) return res(400, { error: 'line_id is required' });
      const rows = await sb(`wh_count_lines?id=eq.${enc(lineId)}&select=count_id&limit=1`);
      if (!rows || !rows[0]) return res(404, { error: 'Line not found' });
      const count = await getCount(rows[0].count_id);
      if (count && count.status !== 'open') {
        return res(409, { error: 'COUNT_NOT_OPEN', message: `This count is ${count.status}.` });
      }
      const updated = await patch(`wh_count_lines?id=eq.${enc(lineId)}`, {
        voided: true,
        voided_by: body.voided_by ? String(body.voided_by).slice(0, 60) : null,
        voided_at: new Date().toISOString(),
      });
      return res(200, { line: updated[0] });
    }

    if (action === 'finish_count') {
      const countId = body.count_id || '';
      const count = await getCount(countId);
      if (!count) return res(404, { error: 'Count not found' });
      if (count.status !== 'open') return res(409, { error: 'COUNT_NOT_OPEN', message: `Already ${count.status}.` });

      const locs = await sb(`wh_count_locations?count_id=eq.${enc(countId)}&select=location_code,status&limit=2000`);
      const pending = (locs || []).filter((l) => !['counted', 'recount'].includes(l.status));

      // Finishing with locations left is allowed — a partial count is a real
      // thing — but only deliberately, and the report will keep flagging them
      // as NOT_COUNTED so nobody reads them as missing stock.
      if (pending.length && !body.confirm_partial) {
        return res(409, {
          error: 'LOCATIONS_PENDING',
          message: `${pending.length} location${pending.length === 1 ? '' : 's'} not counted yet.`,
          pending: pending.map((l) => l.location_code),
          hint: 'Resend with confirm_partial:true to close capture anyway.',
        });
      }

      const updated = await patch(`wh_counts?id=eq.${enc(countId)}`, {
        status: 'review',
        closed_by: body.by ? String(body.by).slice(0, 60) : null,
        closed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      return res(200, { count: updated[0], pending: pending.map((l) => l.location_code) });
    }

    if (action === 'close_count') {
      const countId = body.count_id || '';
      const count = await getCount(countId);
      if (!count) return res(404, { error: 'Count not found' });
      if (count.status === 'closed') return res(200, { count });
      if (count.status !== 'review') {
        return res(409, { error: 'NOT_IN_REVIEW', message: 'Finish capture before closing the count.' });
      }
      const now = new Date().toISOString();
      const updated = await patch(`wh_counts?id=eq.${enc(countId)}`, {
        status: 'closed',
        applied_at: body.applied ? now : null,
        applied_by: body.applied && body.by ? String(body.by).slice(0, 60) : null,
        notes: body.notes ? String(body.notes).slice(0, 2000) : count.notes,
        updated_at: now,
      });
      return res(200, { count: updated[0] });
    }

    if (action === 'cancel_count') {
      const countId = body.count_id || '';
      const count = await getCount(countId);
      if (!count) return res(404, { error: 'Count not found' });
      if (count.status === 'closed') {
        return res(409, { error: 'COUNT_CLOSED', message: 'A closed count cannot be cancelled.' });
      }
      const updated = await patch(`wh_counts?id=eq.${enc(countId)}`, {
        status: 'cancelled',
        notes: body.reason ? String(body.reason).slice(0, 2000) : count.notes,
        updated_at: new Date().toISOString(),
      });
      return res(200, { count: updated[0] });
    }

    return res(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[frm-count]', err);
    return res(err.status && err.status < 500 ? err.status : 500, {
      error: 'Request failed',
      message: String(err.message || err),
    });
  }
};

// Exported for tests.
exports._helpers = { buildSnapshot, redactIfBlind, ageMinutes, sortVariance, validQty };
