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
//     by the same rules the reconciliation workbook used.
//
// Env: SKUVAULT_TENANT_TOKEN, SKUVAULT_USER_TOKEN, SUPABASE_URL,
//      SUPABASE_SERVICE_KEY. Optional: SKUVAULT_WAREHOUSE_ID (resolved from
//      /products/getWarehouses when absent).
//
// Actions:
//   GET  ?action=plan&reference=MBL-AUG-2026[&location_code=RA0201]
//   GET  ?action=status&reference=MBL-AUG-2026
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

// Codes that are not merchant SKUs in Linnworks. Pushing them would create
// junk SKUs in SkuVault that cannot be sold or picked, and would bury real
// physical units under a dead code.
const BLOCKED_SKUS = new Set(['X004LIIFLJ', 'X004LIIVPJ', 'BOBCGZWKBJ']);

// Locations the walk never reached. "The count is the truth" cannot apply to
// a shelf nobody looked at — zeroing it would be inventing a fact.
const NEVER_WALKED = new Set(['F0701']);

// Locations confirmed empty by the operator even though they were not walked.
const FORCE_EMPTY = new Set(['GENERAL']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pure: turns variance rows into the exact payload. Exported for tests.
function buildPlan(rows, { forceEmpty = FORCE_EMPTY, blocked = BLOCKED_SKUS, skip = NEVER_WALKED } = {}) {
  const items = [];
  const dropped = [];

  for (const r of rows) {
    const loc = r.location_code;
    const sku = r.sku;
    const exp = Number(r.qty_expected) || 0;
    const cnt = Number(r.qty_counted) || 0;
    const walked = ['counted', 'recount'].includes(r.location_status);

    if (blocked.has(sku)) { dropped.push({ loc, sku, cnt, why: 'code is not a SKU in Linnworks' }); continue; }
    if (skip.has(loc))    { dropped.push({ loc, sku, exp, why: 'location never walked' }); continue; }

    let target;
    if (walked) target = cnt;
    else if (forceEmpty.has(loc)) target = 0;
    else { dropped.push({ loc, sku, exp, why: 'location not counted' }); continue; }

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

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, SKUVAULT_TENANT_TOKEN, SKUVAULT_USER_TOKEN } = process.env;
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
        TenantToken: SKUVAULT_TENANT_TOKEN,
        UserToken: SKUVAULT_USER_TOKEN,
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
      if (!SKUVAULT_TENANT_TOKEN || !SKUVAULT_USER_TOKEN) {
        return res(500, { error: 'SKUVAULT_TENANT_TOKEN / SKUVAULT_USER_TOKEN not set in Netlify' });
      }
      const r = await sv('/products/getWarehouses', {});
      return res(r.ok ? 200 : 502, { ok: r.ok, status: r.status, warehouses: r.body });
    }

    if (!reference) return res(400, { error: 'reference is required (e.g. MBL-AUG-2026)' });
    const count = await getCount(reference);
    if (!count) return res(404, { error: `No count found with reference ${reference}` });

    if (action === 'plan') {
      const rows = await getRows(count.id, qs.location_code);
      const { items, dropped } = buildPlan(rows || []);
      const byLoc = summarise(items);
      return res(200, {
        count: { reference: count.reference, client: count.client, status: count.status },
        scope: qs.location_code || 'ALL LOCATIONS',
        totals: {
          lines_to_send: items.length,
          batches: Math.ceil(items.length / MAX_ITEMS),
          locations: Object.keys(byLoc).length,
          lines_zeroing: items.filter((i) => i.Quantity === 0).length,
          units_after: items.reduce((n, i) => n + i.Quantity, 0),
          net_delta: items.reduce((n, i) => n + i._delta, 0),
        },
        by_location: byLoc,
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

    if (!SKUVAULT_TENANT_TOKEN || !SKUVAULT_USER_TOKEN) {
      return res(500, { error: 'SKUVAULT_TENANT_TOKEN / SKUVAULT_USER_TOKEN not set in Netlify' });
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

    const location = (body.location_code || '').trim().toUpperCase();
    if (!location && !body.all_locations) {
      return res(400, {
        error: 'SCOPE_REQUIRED',
        message: 'Send location_code to push one location, or all_locations:true to push everything. ' +
                 'Start with one small location and check it in SkuVault before going wide.',
      });
    }

    const rows = await getRows(count.id, location || undefined);
    const { items, dropped } = buildPlan(rows || []);
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

exports._helpers = { buildPlan, chunk, summarise, MAX_ITEMS };
