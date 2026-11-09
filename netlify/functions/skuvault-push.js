// netlify/functions/skuvault-push.js
// Pushes the physical count into SkuVault via /inventory/setItemQuantities.
//
// ── WHY THIS FILE IS SO DEFENSIVE ──────────────────────────────────────────
// setItemQuantities SETS quantities — it does not add or subtract. A wrong
// payload does not fail loudly, it silently overwrites real inventory with
// whatever it was handed, and there is no undo. Everything below exists to
// make that hard to do by accident:
//
//   · the plan is COMPUTED HERE from the count itself, never uploaded. There
//     is no CSV in the middle that can go stale or get edited by hand between
//     being reviewed and being sent.
//   · nothing is sent without ?action=push AND confirm === the count
//     reference, typed exactly.
//   · one location per call by default. Pushing the whole warehouse in one
//     shot requires all_locations:true, on purpose.
//   · every batch is logged before the call and updated after it, so an
//     interrupted run can be resumed from the log instead of from memory.
//   · SKUs that are not real SKUs, and locations nobody walked, are dropped
//     by rules that belong to ONE count each (see COUNT_RULES). A rule written
//     for MBL-AUG-2026 must never leak into the next count.
//
// Env: SKUVAULT_TENANT_TOKEN (accepts "tenant|user" or tenant alone, in which
//      case SKUVAULT_USER_TOKEN is read too), SUPABASE_URL,
//      SUPABASE_SERVICE_KEY. Optional: SKUVAULT_WAREHOUSE_ID (resolved from
//      /inventory/getWarehouses when absent).
//
// Actions:
//   GET  ?action=plan&reference=MBL-NOV-2026[&location_code=RA0301]
//   GET  ?action=status&reference=MBL-NOV-2026
//   GET  ?action=warehouses
//   POST { action:'push', reference, confirm, location_code | all_locations, pushed_by }

const ALLOWED_ORIGINS = [
  'https://apps.fr-logistics.net',
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
];

const SV = 'https://app.skuvault.com/api';
const MAX_ITEMS = 100;          // hard API limit on the Items array
const BATCH_PAUSE_MS = 1200;    // "moderate throttling" — do not hammer it

// ── PER-COUNT RULES ────────────────────────────────────────────────────────
// Each count gets its own exceptions, keyed by its reference. A count with no
// entry here runs with EMPTY sets, which means:
//   · every counted SKU is pushed as counted,
//   · every walked location is pushed as counted,
//   · every location NOT walked is dropped (reported, never zeroed).
// That is the safe default. The only way to zero a location nobody walked,
// or to hold back a code, is to write it down here under THAT count's
// reference — so the decision is visible in the diff and dies with the count.
//
//   blocked    — codes that are not merchant SKUs. Pushing them would create
//                junk SKUs in SkuVault that cannot be sold or picked.
//   skip       — locations the walk never reached. "The count is the truth"
//                cannot apply to a shelf nobody looked at.
//   forceEmpty — locations confirmed EMPTY by the operator even though they
//                were not walked (e.g. a phantom location). Zeroes them.
const COUNT_RULES = {
  // Historical. Milano Brands, Aug 2026 — kept so ?action=plan on the old
  // reference still reproduces what was actually pushed on 17-Aug-2026.
  'MBL-AUG-2026': {
    blocked:    ['X004LIIFLJ', 'X004LIIVPJ', 'BOBCGZWKBJ'],
    skip:       ['F0701'],
    forceEmpty: ['GENERAL'],
  },
  // Add the next count here ONLY if it needs an exception, e.g.
  // 'MBL-NOV-2026': { blocked: [], skip: [], forceEmpty: [] },
};

const EMPTY_RULES = Object.freeze({ blocked: [], skip: [], forceEmpty: [] });

function rulesFor(reference) {
  const r = COUNT_RULES[reference] || EMPTY_RULES;
  return {
    blocked:    new Set(r.blocked    || []),
    skip:       new Set(r.skip       || []),
    forceEmpty: new Set(r.forceEmpty || []),
    explicit:   Object.prototype.hasOwnProperty.call(COUNT_RULES, reference),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// FR convention: SKUVAULT_TENANT_TOKEN may hold BOTH tokens joined by a pipe
// ("tenant|user"). inventory-locations-sync.mjs and frm-alias-sync.mjs have
// always read it that way; reading the variable raw sends the whole joined
// string as TenantToken and SkuVault rejects the call. Same helper, same
// behaviour, so this function authenticates like every other one here.
function svTokens() {
  const t = process.env.SKUVAULT_TENANT_TOKEN || '';
  if (t.includes('|')) {
    const [TenantToken, UserToken] = t.split('|');
    return { TenantToken, UserToken };
  }
  return { TenantToken: t, UserToken: process.env.SKUVAULT_USER_TOKEN || '' };
}

// Pure: turns variance rows into the exact payload. Exported for tests.
// `rules` MUST be passed by the caller (rulesFor(reference)); there is no
// global default any more, on purpose.
function buildPlan(rows, rules) {
  const blocked    = (rules && rules.blocked)    || new Set();
  const skip       = (rules && rules.skip)       || new Set();
  const forceEmpty = (rules && rules.forceEmpty) || new Set();

  const items = [];
  const dropped = [];

  for (const r of rows) {
    const loc = r.location_code;
    const sku = r.sku;
    const exp = Number(r.qty_expected) || 0;
    const cnt = Number(r.qty_counted) || 0;
    const walked = ['counted', 'recount'].includes(r.location_status);

    if (blocked.has(sku)) { dropped.push({ loc, sku, cnt, why: 'code is not a SKU in Linnworks (blocked for this count)' }); continue; }
    if (skip.has(loc))    { dropped.push({ loc, sku, exp, why: 'location never walked (skipped for this count)' }); continue; }

    let target;
    if (walked) target = cnt;
    else if (forceEmpty.has(loc)) target = 0;
    else { dropped.push({ loc, sku, exp, why: 'location not counted — left untouched' }); continue; }

    // A line already at its target is not sent. Fewer writes, fewer chances
    // to break something that was already right.
    if (target === exp) continue;

    items.push({ Sku: sku, LocationCode: loc, Quantity: target, _before: exp, _delta: target - exp });
  }

  items.sort((a, b) => (a.LocationCode === b.LocationCode
    ? a.Sku.localeCompare(b.Sku)
    : a.LocationCode.localeCompare(b.LocationCode)));

  return { items, dropped };
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function summarise(items) {
  const byLoc = {};
  for (const it of items) {
    const b = byLoc[it.LocationCode] || (byLoc[it.LocationCode] = { lines: 0, units: 0, zeroing: 0 });
    b.lines += 1;
    b.units += it.Quantity;
    if (it.Quantity === 0) b.zeroing += 1;
  }
  return byLoc;
}

// Locations the snapshot expected but the walk never reached. These are NOT
// pushed (no forceEmpty rule) — but the operator must see them, because
// SkuVault will keep showing stock there that the count did not confirm.
function notCountedLocations(rows) {
  const out = {};
  for (const r of rows) {
    if (['counted', 'recount'].includes(r.location_status)) continue;
    const exp = Number(r.qty_expected) || 0;
    if (!exp) continue;
    const b = out[r.location_code] || (out[r.location_code] = { skus: 0, units_in_wms: 0 });
    b.skus += 1;
    b.units_in_wms += exp;
  }
  return out;
}

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

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  const SV_TOKENS = svTokens();
  const svReady = !!(SV_TOKENS.TenantToken && SV_TOKENS.UserToken);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res(500, { error: 'Supabase not configured' });

  const enc = encodeURIComponent;
  const sb = async (path, opts = {}) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...opts,
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${t}`);
    return t ? JSON.parse(t) : null;
  };

  const sv = async (path, payload) => {
    const r = await fetch(`${SV}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        TenantToken: SV_TOKENS.TenantToken,
        UserToken: SV_TOKENS.UserToken,
        ...payload,
      }),
    });
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 800) }; }
    return { ok: r.ok, status: r.status, body };
  };

  const getCount = async (reference) => {
    const rows = await sb(`wh_counts?reference=eq.${enc(reference)}&select=*&limit=1`);
    return rows && rows[0] ? rows[0] : null;
  };

  const getRows = async (countId, location) => {
    const locFilter = location ? `&location_code=eq.${enc(location)}` : '';
    return sb(
      `v_wh_count_variance?count_id=eq.${enc(countId)}${locFilter}` +
      '&select=location_code,sku,qty_expected,qty_counted,variance,location_status&limit=20000'
    );
  };

  // Counted SKUs that no client owns in wh_sku_clients. Not blocked — a SKU
  // received this week may simply not have synced yet — but surfaced loudly,
  // because this is exactly how 36 orphan units slipped through in Aug 2026.
  const unresolvedSkus = async (rows) => {
    const skus = [...new Set(rows.filter((r) => Number(r.qty_counted) > 0).map((r) => r.sku))];
    if (!skus.length) return [];
    const known = await sb(
      `wh_sku_clients?sku=in.(${skus.map((s) => `"${s.replace(/"/g, '\\"')}"`).join(',')})&select=sku&limit=5000`
    );
    const set = new Set((known || []).map((k) => k.sku));
    return skus.filter((s) => !set.has(s));
  };

  try {
    const qs = event.queryStringParameters || {};
    let body = {};
    if (event.httpMethod === 'POST') {
      try { body = JSON.parse(event.body || '{}'); }
      catch { return res(400, { error: 'Invalid JSON body' }); }
    }
    const action = (event.httpMethod === 'GET' ? qs.action : body.action) || '';
    const reference = (qs.reference || body.reference || '').trim();

    if (action === 'warehouses') {
      if (!svReady) {
        return res(500, {
          error: 'SkuVault tokens missing',
          message: 'Set SKUVAULT_TENANT_TOKEN as "tenant|user", or set SKUVAULT_USER_TOKEN separately.',
          tenant_present: !!SV_TOKENS.TenantToken,
          user_present: !!SV_TOKENS.UserToken,
        });
      }
      const r = await sv('/inventory/getWarehouses', {});
      return res(r.ok ? 200 : 502, { ok: r.ok, status: r.status, warehouses: r.body });
    }

    if (!reference) return res(400, { error: 'reference is required (e.g. MBL-NOV-2026)' });
    const count = await getCount(reference);
    if (!count) return res(404, { error: `No count found with reference ${reference}` });

    const rules = rulesFor(reference);
    const rulesOut = {
      source: rules.explicit ? `COUNT_RULES['${reference}']` : 'none (safe defaults — nothing blocked, nothing skipped, nothing force-emptied)',
      blocked: [...rules.blocked],
      skip: [...rules.skip],
      forceEmpty: [...rules.forceEmpty],
    };

    if (action === 'plan') {
      const rows = await getRows(count.id, qs.location_code);
      const { items, dropped } = buildPlan(rows || [], rules);
      const byLoc = summarise(items);
      const notCounted = notCountedLocations(rows || []);
      const unresolved = await unresolvedSkus(rows || []).catch(() => []);
      return res(200, {
        count: { reference: count.reference, client: count.client, status: count.status },
        scope: qs.location_code || 'ALL LOCATIONS',
        rules: rulesOut,
        totals: {
          lines_to_send: items.length,
          batches: Math.ceil(items.length / MAX_ITEMS),
          locations: Object.keys(byLoc).length,
          lines_zeroing: items.filter((i) => i.Quantity === 0).length,
          units_after: items.reduce((n, i) => n + i.Quantity, 0),
          net_delta: items.reduce((n, i) => n + i._delta, 0),
        },
        by_location: byLoc,
        // Locations SkuVault expects stock in that nobody walked. They stay as
        // they are. If one of them is physically empty, add it to forceEmpty
        // for THIS reference in COUNT_RULES and redeploy — do not guess here.
        not_counted_locations: notCounted,
        // SKUs counted with units that no client owns. Map them in
        // wh_fnsku_map / wh_sku_clients before pushing, or add them to
        // `blocked` for this reference.
        unresolved_skus: unresolved,
        items,
        dropped,
        note: 'Nothing was sent. This is the plan only.',
      });
    }

    if (action === 'status') {
      const log = await sb(
        `wh_count_push_log?count_id=eq.${enc(count.id)}&select=*&order=started_at.desc&limit=500`
      );
      const done = {}, failed = {};
      for (const l of (log || []).slice().reverse()) {
        if (!l.location_code) continue;
        if (l.status === 'ok') { done[l.location_code] = l.finished_at; delete failed[l.location_code]; }
        else if (['failed', 'partial'].includes(l.status)) failed[l.location_code] = l.status;
      }
      return res(200, {
        count: { reference: count.reference, status: count.status },
        rules: rulesOut,
        pushed_ok: done,
        needs_attention: failed,
        batches: (log || []).map((l) => ({
          at: l.started_at, location: l.location_code, batch: l.batch_no,
          items: l.item_count, units: l.units_total, status: l.status,
          http: l.http_status, by: l.pushed_by,
          errors: l.errors && Object.keys(l.errors).length ? l.errors : undefined,
        })),
      });
    }

    // ── the only action that writes to SkuVault ─────────────────────────────
    if (action !== 'push') return res(400, { error: `Unknown action: ${action}` });
    if (event.httpMethod !== 'POST') return res(405, { error: 'push must be POST' });

    if (!svReady) {
      return res(500, {
        error: 'SkuVault tokens missing',
        message: 'Set SKUVAULT_TENANT_TOKEN as "tenant|user", or set SKUVAULT_USER_TOKEN separately.',
      });
    }

    // Typing the reference is the seatbelt. A stray click cannot satisfy it.
    if (body.confirm !== reference) {
      return res(400, {
        error: 'CONFIRM_MISMATCH',
        message: `To push, send confirm exactly equal to "${reference}".`,
      });
    }

    if (!['review', 'closed'].includes(count.status)) {
      return res(409, {
        error: 'COUNT_NOT_READY',
        message: `This count is ${count.status}. Finish capture before pushing anything to SkuVault.`,
      });
    }

    // A count that was already applied is done. Pushing it again would
    // re-SET quantities that may have moved legitimately since.
    if (count.applied_at && !body.force_reapply) {
      return res(409, {
        error: 'COUNT_ALREADY_APPLIED',
        message: `This count was applied on ${count.applied_at}. Send force_reapply:true only if you really mean to push it again.`,
      });
    }

    const location = (body.location_code || '').trim().toUpperCase();
    if (!location && !body.all_locations) {
      return res(400, {
        error: 'SCOPE_REQUIRED',
        message: 'Send location_code to push one location, or all_locations:true to push everything. ' +
                 'Start with one small location and check it in SkuVault before going wide.',
      });
    }

    const rows = await getRows(count.id, location || undefined);

    // Unresolved codes are a hard stop on push (not on plan): a SET with a
    // junk SKU creates a junk SKU. Map them or block them first.
    const unresolved = await unresolvedSkus(rows || []).catch(() => []);
    const unresolvedToSend = unresolved.filter((s) => !rules.blocked.has(s));
    if (unresolvedToSend.length && !body.allow_unresolved) {
      return res(409, {
        error: 'UNRESOLVED_SKUS',
        message: 'These counted codes are not owned by any client in wh_sku_clients. Map them in wh_fnsku_map, ' +
                 `or add them to COUNT_RULES['${reference}'].blocked, or send allow_unresolved:true to push them anyway.`,
        unresolved_skus: unresolvedToSend,
      });
    }

    const { items, dropped } = buildPlan(rows || [], rules);
    if (!items.length) {
      return res(200, { pushed: 0, message: 'Nothing to change — everything already matches.', dropped });
    }

    const warehouseId = body.warehouse_id || process.env.SKUVAULT_WAREHOUSE_ID || undefined;
    const batches = chunk(items, MAX_ITEMS);
    const results = [];

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const payloadItems = batch.map((it) => ({
        Sku: it.Sku,
        LocationCode: it.LocationCode,
        Quantity: it.Quantity,
        ...(warehouseId ? { WarehouseId: Number(warehouseId) } : {}),
      }));

      // Logged BEFORE the call: if the function times out mid-flight, the row
      // stays 'sending' and tells you exactly which batch to verify by hand.
      let logRow = null;
      try {
        const created = await sb('wh_count_push_log', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify([{
            count_id: count.id,
            reference: count.reference,
            location_code: location || null,
            batch_no: i + 1,
            items: payloadItems,
            item_count: payloadItems.length,
            units_total: payloadItems.reduce((n, x) => n + x.Quantity, 0),
            status: 'sending',
            pushed_by: body.pushed_by ? String(body.pushed_by).slice(0, 60) : null,
          }]),
        });
        logRow = created && created[0];
      } catch (e) {
        return res(500, {
          error: 'LOG_WRITE_FAILED',
          message: 'Could not write the push log, so nothing was sent. An unlogged push is not resumable.',
          detail: String(e.message || e),
        });
      }

      const r = await sv('/inventory/setItemQuantities', { Items: payloadItems });
      const errs = (r.body && (r.body.Errors || r.body.errors)) || [];
      const status = !r.ok ? 'failed' : (errs.length ? 'partial' : 'ok');

      if (logRow) {
        await sb(`wh_count_push_log?id=eq.${enc(logRow.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            status,
            http_status: r.status,
            response: r.body,
            errors: errs.length ? errs : null,
            finished_at: new Date().toISOString(),
          }),
        }).catch(() => {});
      }

      results.push({ batch: i + 1, items: payloadItems.length, status, http: r.status, errors: errs });

      // Stop on the first failure. Continuing would leave inventory half
      // written with no clean point to resume from.
      if (status === 'failed') {
        return res(502, {
          error: 'PUSH_FAILED',
          message: `Batch ${i + 1} of ${batches.length} failed. Stopped. Earlier batches DID land — check ?action=status.`,
          results,
          response: r.body,
        });
      }

      if (i < batches.length - 1) await sleep(BATCH_PAUSE_MS);
    }

    return res(200, {
      pushed: items.length,
      scope: location || 'ALL LOCATIONS',
      rules: rulesOut,
      batches: results,
      zeroed: items.filter((i) => i.Quantity === 0).length,
      dropped,
      next: 'Run inventory-locations-sync and compare against the plan to confirm SkuVault matches.',
    });
  } catch (err) {
    console.error('[skuvault-push]', err);
    return res(500, { error: 'Request failed', message: String(err.message || err) });
  }
};

exports._helpers = { buildPlan, chunk, summarise, rulesFor, notCountedLocations, COUNT_RULES, MAX_ITEMS };
