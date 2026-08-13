// netlify/functions/frm-fba.js
// FR Mobile — FBA counting module (Client-Managed flow).
// Single endpoint for the handheld: open a shipment, add counted lines, review,
// and close counting. Writes with the service key (RLS stays closed), same
// pattern as frm-receive.js. Read side included so the screen needs one URL.
//
// Actions (POST body.action, or GET ?action=):
//   GET  ?action=shipments&client_id=…   list shipments not yet shipped
//   GET  ?action=lines&shipment_id=…     lines + totals + Amazon-limit warnings
//   POST create_shipment                 { client_id, reference, destination?, ship_from?, created_by? }
//   POST add_line                        { shipment_id, line_type, code|msku, … }
//   POST delete_line                     { line_id }
//   POST close_counting                  { shipment_id }
//
// WHY add_line ACCUMULATES LOOSE UNITS INSTEAD OF FAILING:
// Amazon allows exactly one loose line per SKU, and the DB enforces it with a
// partial unique index. On the floor the operator counts loose units in more
// than one pass ("17 here, 5 more in that bin"), so a second loose scan must
// ADD to the existing line, not throw a duplicate at them mid-count.

const ALLOWED_ORIGINS = [
  'https://apps.fr-logistics.net',
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
];

const MAX_LINES_PER_MSKU = 4;   // Amazon's ceiling — 3 case configs + 1 loose

// ── pure helpers (exported for tests) ────────────────────────────────────────

// Returns { ok: true, line } or { ok: false, error }.
function buildLine(input) {
  const lineType = input.line_type === 'case' ? 'case' : 'loose';
  const msku = String(input.msku || '').trim();

  if (!msku) return { ok: false, error: 'msku is required' };
  if (msku.length > 80) return { ok: false, error: 'msku exceeds 80 characters' };

  const lot = input.lot_code ? String(input.lot_code).trim() : null;
  if (lot && lot.length > 60) return { ok: false, error: 'lot_code exceeds 60 characters' };

  const expiration = input.expiration ? String(input.expiration).slice(0, 10) : null;
  if (expiration && !/^\d{4}-\d{2}-\d{2}$/.test(expiration))
    return { ok: false, error: 'expiration must be YYYY-MM-DD' };

  const line = {
    line_type: lineType,
    msku,
    fnsku: input.fnsku ? String(input.fnsku).trim() : null,
    expiration,
    lot_code: lot,
    counted_by: input.counted_by ? String(input.counted_by).slice(0, 60) : null,
  };

  if (lineType === 'case') {
    const upb = Number(input.units_per_box);
    const boxes = Number(input.boxes);
    if (!Number.isInteger(upb) || upb < 1)
      return { ok: false, error: 'units_per_box must be a whole number >= 1' };
    if (!Number.isInteger(boxes) || boxes < 1)
      return { ok: false, error: 'boxes must be a whole number >= 1' };

    // Quantity is DERIVED, never trusted from the client: units x boxes is the
    // only value Amazon accepts, and a mismatch is what gets reconciled later.
    line.units_per_box = upb;
    line.boxes = boxes;
    line.quantity = upb * boxes;

    // One box is measured and the rest are assumed identical — that is the
    // floor rule and also what the template allows (one dimension per line).
    for (const [key, field] of [['length_in', 'length'], ['width_in', 'width'],
                                ['height_in', 'height'], ['weight_lb', 'weight']]) {
      const v = input[key];
      if (v === undefined || v === null || v === '') continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0)
        return { ok: false, error: `${field} must be a positive number` };
      line[key] = n;
    }
  } else {
    const qty = Number(input.quantity);
    if (!Number.isInteger(qty) || qty < 1)
      return { ok: false, error: 'quantity must be a whole number >= 1' };
    line.quantity = qty;
  }

  return { ok: true, line };
}

// Rolls the stored lines into what the screen shows and what the manifest needs.
function summarize(lines) {
  const byMsku = {};
  for (const l of lines) {
    const e = byMsku[l.msku] || (byMsku[l.msku] = { msku: l.msku, lines: 0, loose: 0, units: 0, boxes: 0 });
    e.lines += 1;
    e.units += l.quantity;
    if (l.line_type === 'loose') e.loose += 1;
    else e.boxes += l.boxes || 0;
  }
  const skus = Object.values(byMsku);
  const warnings = skus
    .filter((s) => s.lines > MAX_LINES_PER_MSKU)
    .map((s) => `${s.msku}: ${s.lines} packing lines — Amazon accepts at most ${MAX_LINES_PER_MSKU}. `
              + 'Merge box configurations or move the smallest into the loose line.');
  return {
    line_count: lines.length,
    total_units: lines.reduce((a, l) => a + l.quantity, 0),
    total_case_boxes: lines.reduce((a, l) => a + (l.boxes || 0), 0),
    by_msku: skus,
    warnings,
    ready: warnings.length === 0 && lines.length > 0,
  };
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

  const qs = event.queryStringParameters || {};
  let body = {};
  if (event.httpMethod === 'POST') {
    try { body = JSON.parse(event.body || '{}'); }
    catch { return res(400, { error: 'Invalid JSON' }); }
  }
  const action = body.action || qs.action;

  try {
    // ── reads ────────────────────────────────────────────────────────────────
    if (action === 'shipments') {
      const clientFilter = qs.client_id ? `&client_id=eq.${encodeURIComponent(qs.client_id)}` : '';
      const rows = await sb(
        'fba_shipments?status=neq.shipped' + clientFilter +
        '&select=id,client_id,reference,status,destination,created_at,client:fr_clients(id,name,company)' +
        '&order=created_at.desc&limit=50'
      );
      return res(200, { ok: true, shipments: rows });
    }

    if (action === 'lines') {
      const sid = qs.shipment_id;
      if (!sid) return res(400, { error: 'shipment_id is required' });
      const rows = await sb(
        `fba_shipment_lines?shipment_id=eq.${encodeURIComponent(sid)}` +
        '&select=*&order=line_type.asc,msku.asc,counted_at.asc'
      );
      return res(200, { ok: true, lines: rows, summary: summarize(rows) });
    }

    // ── writes ───────────────────────────────────────────────────────────────
    if (event.httpMethod !== 'POST') return res(405, { error: 'Method not allowed' });

    if (action === 'create_shipment') {
      const client_id = String(body.client_id || '').trim();
      const reference = String(body.reference || '').trim();
      if (!client_id) return res(400, { error: 'client_id is required' });
      if (!reference) return res(400, { error: 'reference is required' });
      const [row] = await sb('fba_shipments', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          client_id,
          reference,
          destination: body.destination || null,
          ship_from: body.ship_from || null,
          created_by: body.created_by ? String(body.created_by).slice(0, 60) : null,
        }),
      });
      return res(200, { ok: true, shipment: row });
    }

    if (action === 'add_line') {
      const shipment_id = String(body.shipment_id || '').trim();
      if (!shipment_id) return res(400, { error: 'shipment_id is required' });

      // Resolve a scanned barcode to the merchant SKU. The operator never types
      // an MSKU — a typo here would travel all the way into the client's upload.
      let msku = body.msku ? String(body.msku).trim() : '';
      let fnsku = body.fnsku ? String(body.fnsku).trim() : null;
      const code = body.code ? String(body.code).trim() : '';
      if (!msku && code) {
        const hit = await sb(
          `wh_fnsku_map?code=eq.${encodeURIComponent(code)}&select=sku,code_type&limit=1`
        );
        if (hit && hit[0] && hit[0].sku) {
          msku = hit[0].sku;
          fnsku = fnsku || code;
        } else {
          // No mapping: the scanned code may already BE the merchant SKU. Say so
          // instead of guessing silently, so the screen can ask for confirmation.
          return res(404, {
            error: 'unmapped_code',
            code,
            message: 'That barcode is not in the FNSKU map. Confirm the merchant SKU before counting.',
          });
        }
      }

      const built = buildLine({ ...body, msku, fnsku });
      if (!built.ok) return res(400, { error: built.error });
      const line = built.line;

      // Loose lines accumulate — see the note at the top of this file.
      if (line.line_type === 'loose') {
        const existing = await sb(
          `fba_shipment_lines?shipment_id=eq.${encodeURIComponent(shipment_id)}` +
          `&msku=eq.${encodeURIComponent(line.msku)}&line_type=eq.loose&select=id,quantity&limit=1`
        );
        if (existing && existing[0]) {
          const merged = existing[0].quantity + line.quantity;
          const [updated] = await sb(`fba_shipment_lines?id=eq.${existing[0].id}`, {
            method: 'PATCH',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({ quantity: merged, counted_at: new Date().toISOString() }),
          });
          return res(200, { ok: true, line: updated, merged: true, added: line.quantity });
        }
      }

      const [row] = await sb('fba_shipment_lines', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ shipment_id, ...line }),
      });

      // Warn as soon as the SKU crosses Amazon's ceiling — at the scan, not at
      // upload time when the client is already staring at an error.
      const siblings = await sb(
        `fba_shipment_lines?shipment_id=eq.${encodeURIComponent(shipment_id)}` +
        `&msku=eq.${encodeURIComponent(line.msku)}&select=id`
      );
      const warning = siblings.length > MAX_LINES_PER_MSKU
        ? `${line.msku} now has ${siblings.length} packing lines — Amazon accepts ${MAX_LINES_PER_MSKU}.`
        : null;

      return res(200, { ok: true, line: row, ...(warning ? { warning } : {}) });
    }

    if (action === 'delete_line') {
      const id = String(body.line_id || '').trim();
      if (!id) return res(400, { error: 'line_id is required' });
      await sb(`fba_shipment_lines?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
      return res(200, { ok: true, deleted: id });
    }

    if (action === 'close_counting') {
      const sid = String(body.shipment_id || '').trim();
      if (!sid) return res(400, { error: 'shipment_id is required' });
      const rows = await sb(
        `fba_shipment_lines?shipment_id=eq.${encodeURIComponent(sid)}&select=*`
      );
      const summary = summarize(rows);
      if (!summary.ready) {
        return res(409, {
          error: 'not_ready',
          summary,
          message: rows.length
            ? 'Fix the flagged SKUs before closing the count.'
            : 'No lines counted yet.',
        });
      }
      const [row] = await sb(`fba_shipments?id=eq.${encodeURIComponent(sid)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ status: 'packing', updated_at: new Date().toISOString() }),
      });
      return res(200, { ok: true, shipment: row, summary });
    }

    return res(400, { error: `Unknown action: ${action || '(none)'}` });
  } catch (err) {
    // Surface the DB's own guards in words the operator can act on.
    const text = String(err.body || err.message || '');
    if (/fba_line_shape/.test(text))
      return res(400, { error: 'invalid_line', message: 'Units per box x boxes must equal the quantity, and loose lines carry no dimensions.' });
    if (/idx_fba_one_loose_per_msku/.test(text))
      return res(409, { error: 'duplicate_loose', message: 'That SKU already has a loose line.' });
    return res(err.status && err.status < 500 ? err.status : 500, { error: err.message });
  }
};

module.exports.__test = { buildLine, summarize, MAX_LINES_PER_MSKU };
