// netlify/functions/frm-containers.js
// Container (license-plate) layer. One box = one plate = one row in
// wh_containers; its contents hang off the plate, and the plate hangs off a
// location.
//
// ── THE RULE THIS FILE PROTECTS ────────────────────────────────────────────
// SkuVault owns QUANTITY. Containers only say WHERE INSIDE a location
// something sits. Nothing here writes to SkuVault, and nothing here should
// ever be treated as the authority on how much stock exists — if the boxes at
// a location stop adding up to what SkuVault has there, the boxes are wrong.
// v_wh_container_vs_wms is how you see that instead of discovering it a year
// later, the way GENERAL was discovered.
//
// ── WHY THE STATUS GATES ARE STRICT ───────────────────────────────────────
// A label that lies is worse than no label, because people believe it. So:
//   · 'sealed' contents cannot be edited. Open the box first — that records
//     WHEN it stopped being trustworthy.
//   · 'consumed' is terminal and the plate is never reused. FRC-000847 means
//     one physical box, one filling, forever. Reuse would make the event
//     history unreadable.
//   · consuming a box that still has units needs confirm_discard, because
//     otherwise contents vanish with no trace of where they went.
//
// Actions:
//   GET  ?action=container&code=FRC-000001        header + lines + history
//   GET  ?action=at_location&location_code=RA0301
//   GET  ?action=list&client_id=&status=&kind=
//   GET  ?action=resolve&code=…                   plate, bare or as a scanned URL
//   GET  ?action=verify_plan&client_id=           boxes most overdue a check
//   GET  ?action=vs_wms&location_code=            drift against SkuVault
//   GET  ?action=fba_box_contents&shipment_id=
//   POST create | set_line | remove_line | seal | open | move | verify
//        | consume | attach_fba

const ALLOWED_ORIGINS = [
  'https://apps.fr-logistics.net',
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
];

const crypto = require('crypto');

const EDITABLE = new Set(['building', 'open']);

// Plates are sequential, so a bare /c/FRC-000001 would let anyone walk the
// whole warehouse by counting upward. The QR carries a short derived token so
// the public page answers only for codes somebody actually holds a label for.
// Derived from the service key — no extra env var, nothing new to rotate.
function publicToken(code) {
  const secret = process.env.SUPABASE_SERVICE_KEY || '';
  if (!secret || !code) return '';
  return crypto.createHmac('sha256', secret)
    .update(`container:${code}`, 'utf8')
    .digest('hex').slice(0, 6).toUpperCase();
}

function publicUrl(code) {
  return `https://apps.fr-logistics.net/c/${code}-${publicToken(code)}`;
}

// Accepts FRC-000847-A3F9C2 (from the QR) or a bare plate plus ?k=.
function splitCodeAndToken(input) {
  const s = String(input || '').trim();
  const m = s.match(/FRC[-_]?(\d{1,9})[-_]([0-9A-Fa-f]{6})/);
  if (m) return { code: 'FRC-' + m[1].padStart(6, '0'), token: m[2].toUpperCase() };
  return { code: normalizeCode(s), token: null };
}

// ── pure helpers (exported for tests) ───────────────────────────────────────

// The QR encodes a URL, so the handheld receives the whole thing as text. It
// also has to accept the plate typed by hand, lowercase, or with the digits
// short. All three must land on the same canonical FRC-000001.
function normalizeCode(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  const m = s.match(/FRC[-_]?(\d{1,9})/i);
  if (!m) return null;
  return 'FRC-' + m[1].padStart(6, '0');
}

function isContainerCode(input) {
  return normalizeCode(input) !== null;
}

// Returns null when the action is allowed, or the reason it is not.
function blockReason(container, action) {
  if (!container) return 'container not found';
  const s = container.status;

  if (s === 'consumed') {
    return `${container.code} was consumed on ${(container.consumed_at || '').slice(0, 10)}. ` +
           'Plates are never reused — build a new box.';
  }
  if (['set_line', 'remove_line'].includes(action) && !EDITABLE.has(s)) {
    return `${container.code} is ${s}. Open it before changing its contents.`;
  }
  if (action === 'seal' && s !== 'building' && s !== 'open') {
    return `${container.code} is ${s} and cannot be sealed.`;
  }
  if (action === 'open' && s !== 'sealed') {
    return `${container.code} is ${s}, not sealed.`;
  }
  return null;
}

function validQty(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 100000;
}

// ── handler ─────────────────────────────────────────────────────────────────

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
    if (!r.ok) { const e = new Error(`Supabase ${r.status}: ${t}`); e.status = r.status; throw e; }
    return t ? JSON.parse(t) : null;
  };
  const post  = (table, rows, prefer = 'return=representation') =>
    sb(table, { method: 'POST', headers: { Prefer: prefer }, body: JSON.stringify(rows) });
  const patch = (path, body) =>
    sb(path, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) });

  const getByCode = async (code) => {
    const norm = normalizeCode(code);
    if (!norm) return null;
    const rows = await sb(`wh_containers?code=eq.${enc(norm)}&select=*&limit=1`);
    return rows && rows[0] ? rows[0] : null;
  };
  const linesOf = (id) =>
    sb(`wh_container_lines?container_id=eq.${enc(id)}&select=*&order=sku.asc&limit=500`);

  // Events are best-effort: losing a history row must never cost the operator
  // the work they just did on the floor.
  const logEvent = (row) => post('wh_container_events', [row], 'return=minimal').catch(() => {});

  const touch = (id, extra = {}) =>
    patch(`wh_containers?id=eq.${enc(id)}`, { updated_at: new Date().toISOString(), ...extra });

  try {
    const qs = event.queryStringParameters || {};
    let body = {};
    if (event.httpMethod === 'POST') {
      try { body = JSON.parse(event.body || '{}'); }
      catch { return res(400, { error: 'Invalid JSON body' }); }
    }
    const action = (event.httpMethod === 'GET' ? qs.action : body.action) || '';

    // ── PUBLIC (no session — guarded by the derived token) ────────────────
    // Deliberately narrow: plate, client, location, contents. No history, no
    // event log, no other boxes. Somebody holding one label learns about that
    // one box and nothing else.
    if (action === 'public') {
      const { code, token } = splitCodeAndToken(qs.code || qs.p || '');
      const k = (qs.k || token || '').toUpperCase();
      if (!code) return res(400, { error: 'Invalid container code' });

      if (!k || k !== publicToken(code)) {
        // Same answer for a wrong token and a missing box, so this cannot be
        // used to discover which plates exist.
        return res(404, { error: 'NOT_FOUND', message: 'No container matches that code.' });
      }
      const c = await getByCode(code);
      if (!c) return res(404, { error: 'NOT_FOUND', message: 'No container matches that code.' });

      const lines = (await linesOf(c.id)) || [];
      return res(200, {
        code: c.code,
        client: c.client,
        location_code: c.location_code,
        status: c.status,
        kind: c.kind,
        box_seq: c.box_seq,
        weight_lb: c.weight_lb,
        sealed_at: c.sealed_at,
        last_verified_at: c.last_verified_at,
        last_verify_method: c.last_verify_method,
        lines: lines.filter((l) => l.qty > 0).map((l) => ({ sku: l.sku, qty: l.qty })),
        units: lines.reduce((n, l) => n + (Number(l.qty) || 0), 0),
        // The label prints nothing about contents on purpose — a box somebody
        // picked from must still carry a truthful label. This URL is how the
        // contents are looked up instead.
        public_url: publicUrl(c.code),
      });
    }

    // ── READS ─────────────────────────────────────────────────────────────
    if (action === 'resolve') {
      const norm = normalizeCode(qs.code);
      if (!norm) return res(200, { is_container: false, code: null });
      const c = await getByCode(norm);
      return res(200, {
        is_container: true, code: norm, found: !!c,
        container: c || null,
        lines: c ? await linesOf(c.id) : [],
      });
    }

    // Scanned product -> merchant SKU. Same four-step ladder frm-count.js uses,
    // but the "remembered" step looks at previous BOXES rather than previous
    // counts: a code somebody confirmed by hand while packing should still be
    // known the next time it is packed.
    if (action === 'resolve_sku') {
      const code = String(qs.code || '').trim();
      if (!code) return res(400, { error: 'code is required' });

      const hit = await sb(`wh_fnsku_map?code=eq.${enc(code)}&select=sku&limit=1`);
      if (hit && hit[0] && hit[0].sku) {
        return res(200, { sku: hit[0].sku, source: 'map', mapped: true });
      }
      const asSku = await sb(`wh_fnsku_map?sku=eq.${enc(code)}&select=sku&limit=1`);
      if (asSku && asSku[0] && asSku[0].sku) {
        return res(200, { sku: asSku[0].sku, source: 'scanned_sku', mapped: true });
      }
      try {
        const prior = await sb(
          `wh_container_events?event=eq.line_set&detail=eq.${enc(code)}` +
          '&select=sku,actor,created_at&order=created_at.desc&limit=1'
        );
        if (prior && prior[0] && prior[0].sku) {
          return res(200, {
            sku: prior[0].sku, source: 'memory', mapped: true,
            confirmed_by: prior[0].actor || null, confirmed_at: prior[0].created_at || null,
          });
        }
      } catch { /* memory is an accelerator, never a reason to fail a scan */ }

      let suggestions = [];
      try {
        const like = await sb(`wh_fnsku_map?sku=ilike.*${enc(code)}*&select=sku&limit=5`);
        suggestions = [...new Set((like || []).map((r) => r.sku))];
      } catch { /* nicety only */ }

      return res(200, { sku: null, source: null, mapped: false, suggestions });
    }

    if (action === 'container') {
      const c = qs.id
        ? ((await sb(`wh_containers?id=eq.${enc(qs.id)}&select=*&limit=1`)) || [])[0]
        : await getByCode(qs.code);
      if (!c) return res(404, { error: 'Container not found' });
      const [lines, events] = await Promise.all([
        linesOf(c.id),
        sb(`wh_container_events?container_id=eq.${enc(c.id)}&select=*&order=created_at.desc&limit=100`),
      ]);
      const units = (lines || []).reduce((n, l) => n + (Number(l.qty) || 0), 0);
      return res(200, { container: c, lines: lines || [], events: events || [],
                        units, skus: (lines || []).filter((l) => l.qty > 0).length,
                        public_url: publicUrl(c.code) });
    }

    if (action === 'at_location') {
      const loc = String(qs.location_code || '').trim().toUpperCase();
      if (!loc) return res(400, { error: 'location_code is required' });
      const rows = await sb(
        `v_wh_container_summary?location_code=eq.${enc(loc)}&status=neq.consumed` +
        '&select=*&order=code.asc&limit=500'
      );
      return res(200, {
        location_code: loc,
        containers: rows || [],
        units: (rows || []).reduce((n, r) => n + (Number(r.units) || 0), 0),
      });
    }

    if (action === 'list') {
      const f = [];
      if (qs.client_id) f.push(`client_id=eq.${enc(qs.client_id)}`);
      if (qs.status) f.push(`status=eq.${enc(qs.status)}`);
      else f.push('status=neq.consumed');
      if (qs.kind) f.push(`kind=eq.${enc(qs.kind)}`);
      const rows = await sb(
        `v_wh_container_summary?${f.join('&')}&select=*&order=created_at.desc&limit=500`
      );
      return res(200, { containers: rows || [] });
    }

    // Cycle-count plan. A sealed box nobody has opened in months is the one
    // whose label is most likely wrong, so nulls (never verified) sort first.
    if (action === 'verify_plan') {
      const f = ['status=in.(sealed,open)'];
      if (qs.client_id) f.push(`client_id=eq.${enc(qs.client_id)}`);
      const rows = await sb(
        `v_wh_container_summary?${f.join('&')}&select=*` +
        '&order=last_verified_at.asc.nullsfirst&limit=200'
      );
      return res(200, { containers: rows || [] });
    }

    if (action === 'vs_wms') {
      const loc = String(qs.location_code || '').trim().toUpperCase();
      const f = loc ? `location_code=eq.${enc(loc)}&` : '';
      const rows = await sb(`v_wh_container_vs_wms?${f}select=*&limit=5000`);
      const all = rows || [];
      return res(200, {
        rows: all,
        drift: all.filter((r) => ['BOXED_NOT_IN_WMS', 'OVER_BOXED'].includes(r.state)),
      });
    }

    if (action === 'fba_box_contents') {
      if (!qs.shipment_id) return res(400, { error: 'shipment_id is required' });
      const rows = await sb(
        `v_fba_box_contents?fba_shipment_id=eq.${enc(qs.shipment_id)}` +
        '&select=*&order=box_seq.asc&limit=2000'
      );
      return res(200, { boxes: rows || [] });
    }

    // ── WRITES ────────────────────────────────────────────────────────────
    if (event.httpMethod !== 'POST') return res(405, { error: 'Method not allowed' });
    const actor = body.actor ? String(body.actor).slice(0, 60) : null;

    if (action === 'create') {
      const loc = body.location_code ? String(body.location_code).trim().toUpperCase() : null;
      let client = body.client || null;
      if (body.client_id && !client) {
        const cli = await sb(`fr_clients?id=eq.${enc(body.client_id)}&select=company,name&limit=1`);
        if (cli && cli[0]) client = cli[0].company || cli[0].name;
      }
      const created = await post('wh_containers', [{
        client_id: body.client_id || null,
        client,
        location_code: loc,
        kind: ['storage', 'fba', 'inbound', 'return'].includes(body.kind) ? body.kind : 'storage',
        fba_shipment_id: body.fba_shipment_id || null,
        box_seq: body.box_seq || null,
        created_by: actor,
        notes: body.notes ? String(body.notes).slice(0, 2000) : null,
      }]);
      const c = created[0];
      await logEvent({ container_id: c.id, event: 'created', to_location: loc, actor });
      return res(200, { container: c, lines: [], public_url: publicUrl(c.code) });
    }

    // Everything below operates on an existing plate.
    const c = await getByCode(body.code || body.container_code);
    if (!c) return res(404, { error: 'Container not found', code: body.code || null });

    if (action === 'set_line' || action === 'remove_line') {
      const stop = blockReason(c, action);
      if (stop) return res(409, { error: 'STATUS_BLOCKED', message: stop, container: c });

      const sku = String(body.sku || '').trim();
      if (!sku) return res(400, { error: 'sku is required' });

      const existing = await sb(
        `wh_container_lines?container_id=eq.${enc(c.id)}&sku=eq.${enc(sku)}&select=qty&limit=1`
      );
      const before = existing && existing[0] ? existing[0].qty : null;

      if (action === 'remove_line') {
        await sb(`wh_container_lines?container_id=eq.${enc(c.id)}&sku=eq.${enc(sku)}`,
                 { method: 'DELETE' });
        await logEvent({ container_id: c.id, event: 'line_removed', sku,
                         qty_before: before, qty_after: null, actor });
      } else {
        if (!validQty(body.qty)) {
          return res(400, { error: 'qty must be a whole number between 0 and 100000' });
        }
        const qty = Number(body.qty);
        // Upsert: a box's contents is a set, so re-scanning a SKU REPLACES its
        // quantity rather than adding to it. Packing is not counting — if a
        // second scan added, a double scan would silently inflate the box.
        await post('wh_container_lines', [{
          container_id: c.id, sku, qty, added_by: actor,
          updated_at: new Date().toISOString(),
        }], 'resolution=merge-duplicates,return=minimal');
        // `detail` carries the scanned code so resolve_sku can remember a
        // manual mapping the next time the same barcode shows up.
        await logEvent({ container_id: c.id, event: 'line_set', sku,
                         qty_before: before, qty_after: qty, actor,
                         detail: body.code_scanned ? String(body.code_scanned).slice(0, 120) : null });
      }

      await touch(c.id);
      const lines = await linesOf(c.id);
      return res(200, {
        container: c, lines,
        units: lines.reduce((n, l) => n + (Number(l.qty) || 0), 0),
        skus: lines.filter((l) => l.qty > 0).length,
      });
    }

    if (action === 'seal') {
      const stop = blockReason(c, 'seal');
      if (stop) return res(409, { error: 'STATUS_BLOCKED', message: stop, container: c });

      const lines = await linesOf(c.id);
      const units = (lines || []).reduce((n, l) => n + (Number(l.qty) || 0), 0);
      if (units <= 0) {
        return res(409, {
          error: 'EMPTY_BOX',
          message: 'Nothing recorded in this box. Scan its contents before sealing.',
        });
      }
      const now = new Date().toISOString();
      const updated = await touch(c.id, {
        status: 'sealed', sealed_by: actor, sealed_at: now,
        // Sealing IS a physical count — somebody just handled every unit.
        last_verified_at: now, last_verified_by: actor, last_verify_method: 'counted',
        ...(body.weight_lb != null ? { weight_lb: Number(body.weight_lb) } : {}),
        ...(body.length_in != null ? { length_in: Number(body.length_in) } : {}),
        ...(body.width_in  != null ? { width_in:  Number(body.width_in)  } : {}),
        ...(body.height_in != null ? { height_in: Number(body.height_in) } : {}),
      });
      await logEvent({ container_id: c.id, event: 'sealed', actor,
                       detail: `${lines.length} SKUs / ${units} units` });
      return res(200, { container: updated[0], lines, units });
    }

    if (action === 'open') {
      const stop = blockReason(c, 'open');
      if (stop) return res(409, { error: 'STATUS_BLOCKED', message: stop, container: c });
      const updated = await touch(c.id, { status: 'open', opened_at: new Date().toISOString() });
      await logEvent({ container_id: c.id, event: 'opened', actor,
                       detail: body.reason || null });
      return res(200, { container: updated[0], lines: await linesOf(c.id) });
    }

    if (action === 'move') {
      const stop = blockReason(c, 'move');
      if (stop) return res(409, { error: 'STATUS_BLOCKED', message: stop, container: c });
      const to = String(body.location_code || '').trim().toUpperCase();
      if (!to) return res(400, { error: 'location_code is required' });
      if (to === c.location_code) return res(200, { container: c, unchanged: true });
      const updated = await touch(c.id, { location_code: to });
      await logEvent({ container_id: c.id, event: 'moved',
                       from_location: c.location_code, to_location: to, actor });
      return res(200, { container: updated[0], moved_from: c.location_code });
    }

    if (action === 'verify') {
      const stop = blockReason(c, 'verify');
      if (stop) return res(409, { error: 'STATUS_BLOCKED', message: stop, container: c });
      // 'scan' means somebody trusted the label. 'counted' means somebody
      // opened the box. Recording them the same way would let a warehouse
      // full of never-opened boxes look fully verified.
      const method = body.method === 'counted' ? 'counted' : 'scan';
      const now = new Date().toISOString();
      const updated = await touch(c.id, {
        last_verified_at: now, last_verified_by: actor, last_verify_method: method,
      });
      await logEvent({ container_id: c.id, event: 'verified', actor, detail: method });
      return res(200, { container: updated[0], method });
    }

    if (action === 'consume') {
      const stop = blockReason(c, 'consume');
      if (stop) return res(409, { error: 'STATUS_BLOCKED', message: stop, container: c });
      const lines = await linesOf(c.id);
      const units = (lines || []).reduce((n, l) => n + (Number(l.qty) || 0), 0);
      if (units > 0 && !body.confirm_discard) {
        return res(409, {
          error: 'BOX_NOT_EMPTY',
          message: `${c.code} still lists ${units} unit(s). Empty it first, or resend with ` +
                   'confirm_discard to close it anyway — the contents will be recorded as discarded.',
          units, lines,
        });
      }
      const updated = await touch(c.id, {
        status: 'consumed', consumed_at: new Date().toISOString(),
      });
      await logEvent({ container_id: c.id, event: 'consumed', actor,
                       detail: units > 0 ? `closed with ${units} unit(s) still listed` : 'empty' });
      return res(200, { container: updated[0], units_at_close: units });
    }

    if (action === 'attach_fba') {
      const stop = blockReason(c, 'attach_fba');
      if (stop) return res(409, { error: 'STATUS_BLOCKED', message: stop, container: c });
      if (!body.fba_shipment_id) return res(400, { error: 'fba_shipment_id is required' });
      // This is the payoff of one shared model: a sealed storage box becomes an
      // FBA carton without being reopened, recounted or repacked.
      const updated = await touch(c.id, {
        kind: 'fba',
        fba_shipment_id: body.fba_shipment_id,
        box_seq: body.box_seq || c.box_seq,
        ...(body.weight_lb != null ? { weight_lb: Number(body.weight_lb) } : {}),
        ...(body.length_in != null ? { length_in: Number(body.length_in) } : {}),
        ...(body.width_in  != null ? { width_in:  Number(body.width_in)  } : {}),
        ...(body.height_in != null ? { height_in: Number(body.height_in) } : {}),
      });
      await logEvent({ container_id: c.id, event: 'note', actor,
                       detail: `attached to FBA shipment ${body.fba_shipment_id}` });
      return res(200, { container: updated[0] });
    }

    return res(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[frm-containers]', err);
    return res(err.status && err.status < 500 ? err.status : 500,
               { error: 'Request failed', message: String(err.message || err) });
  }
};

exports._helpers = { normalizeCode, isContainerCode, blockReason, validQty, EDITABLE,
                     publicToken, publicUrl, splitCodeAndToken };
