// netlify/functions/frm-packlist.js
// Packing list for outbound orders that leave in our own boxes — customer
// pickups (MBL-PICKUP-260923) and B2B orders — without SkuVault anywhere in
// the chain.
//
// ── THE MODEL ──────────────────────────────────────────────────────────────
// fba_shipments is the "outbound reference" table (kind fba | pickup | b2b).
//   · outbound_expected_lines = what the client ASKED for (their CSV / list).
//   · wh_containers with fba_shipment_id = the boxes we PACKED for it, with
//     their contents in wh_container_lines (built with the Boxes module).
//   · v_outbound_packlist_compare = requested vs packed, per SKU.
// The report is always computed from those tables at the moment it is asked
// for. Nothing is stored as "the packing list", so it can never go stale
// against a box that was reopened and changed.
//
// Why expected lines do NOT go in fba_shipment_lines: those rows are what the
// FBA module COUNTED (case/loose shape, counted_by) and they feed the Amazon
// manifest. Requested lines mixed in there would corrupt the manifest.
//
// Actions:
//   GET  ?action=list[&kind=pickup][&client_id=][&include_closed=1]
//   GET  ?action=report&id=<uuid>[&format=json|html|xlsx]
//   GET  ?action=boxes_available&id=<uuid>      boxes of that client not yet on an order
//   POST create        {client_id, reference, kind, notes, actor}
//   POST set_expected  {id, lines:[{sku,qty,fnsku,asin,description}] | csv:"…", replace:true}
//   POST attach        {id, codes:["FRC-000003",…]}
//   POST detach        {id, code}
//   POST close         {id, confirm_diff, actor}
//
// Env: SUPABASE_URL + SUPABASE_SERVICE_KEY only. No new variables (the 4 KB
// Lambda budget is full).

const zlib = require('zlib');

const ALLOWED_ORIGINS = [
  'https://apps.fr-logistics.net',
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
];
const LEGAL = 'FR Logistics Miami Inc d/b/a FR-Logistics';
const ADDRESS = '10893 NW 17th Street, Unit 121, Miami, FL 33172';
const KINDS = ['fba', 'pickup', 'b2b'];

// ── pure helpers (exported for tests) ───────────────────────────────────────

function normalizeCode(input) {
  const m = String(input || '').match(/FRC[-_]?(\d{1,9})/i);
  return m ? 'FRC-' + m[1].padStart(6, '0') : null;
}

// Accepts whatever the client sends: Excel "Save as CSV" (comma or semicolon),
// a paste from a sheet (tabs), with or without a header row.
function parseCsv(text) {
  const raw = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!raw.length) return [];
  const delim = ['\t', ';', ','].find((d) => raw[0].includes(d)) || ',';
  const split = (line) => {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === delim && !q) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const rows = raw.map(split);
  const ALIASES = {
    sku: ['sku', 'msku', 'merchant sku', 'seller sku', 'item sku', 'product sku'],
    qty: ['qty', 'quantity', 'units', 'qty requested', 'requested', 'quantity requested', 'cantidad'],
    fnsku: ['fnsku'],
    asin: ['asin'],
    description: ['description', 'title', 'product name', 'name', 'item', 'descripcion', 'descripción'],
  };
  const head = rows[0].map((h) => h.toLowerCase().replace(/[_\-]+/g, ' ').trim());
  const idx = {};
  for (const [k, names] of Object.entries(ALIASES)) {
    const i = head.findIndex((h) => names.includes(h));
    if (i >= 0) idx[k] = i;
  }
  let body = rows;
  if (idx.sku != null && idx.qty != null) body = rows.slice(1);
  else { idx.sku = 0; idx.qty = 1; }   // no recognisable header: first two columns
  return body.map((r) => ({
    sku: r[idx.sku] || '',
    qty: r[idx.qty],
    fnsku: idx.fnsku != null ? r[idx.fnsku] || null : null,
    asin: idx.asin != null ? r[idx.asin] || null : null,
    description: idx.description != null ? r[idx.description] || null : null,
  })).filter((r) => r.sku);
}

// Same SKU twice in the client's list means "that many in total".
function mergeLines(lines) {
  const by = new Map(); const bad = [];
  for (const l of lines) {
    const sku = String(l.sku || '').trim();
    const qty = Number(String(l.qty ?? '').replace(/,/g, ''));
    if (!sku) continue;
    if (!Number.isInteger(qty) || qty <= 0 || qty > 1000000) { bad.push({ sku, qty: l.qty }); continue; }
    const prev = by.get(sku);
    if (prev) prev.qty += qty;
    else by.set(sku, {
      sku, qty,
      fnsku: l.fnsku ? String(l.fnsku).trim() : null,
      asin: l.asin ? String(l.asin).trim() : null,
      description: l.description ? String(l.description).trim().slice(0, 300) : null,
    });
  }
  return { lines: [...by.values()], bad };
}

function summarize(compare) {
  const t = { requested: 0, packed: 0, ok: 0, short: 0, over: 0, missing: 0, not_requested: 0 };
  for (const r of compare) {
    t.requested += r.qty_requested || 0;
    t.packed += r.qty_packed || 0;
    t[String(r.state).toLowerCase()] = (t[String(r.state).toLowerCase()] || 0) + 1;
  }
  t.complete = t.short === 0 && t.over === 0 && t.missing === 0 && t.not_requested === 0;
  return t;
}

const NOTE = {
  OK: '',
  SHORT: 'Packed less than requested',
  OVER: 'Packed more than requested',
  MISSING: 'Requested, not packed',
  NOT_REQUESTED: 'Packed, not on the request',
};

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (d) => (d ? new Date(d).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }) : '');

// ── minimal .xlsx writer (no dependencies — the repo has no bundler step) ────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xFFFFFFFF; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

function zip(files) {
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(0, 30); ch.writeUInt32LE(0, 34);
    ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// sheets: [{name, rows:[[cell,…]], widths:[…], headerRow:index}]
function buildXlsx(sheets) {
  const x = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  const col = (i) => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  const sheetXml = (sh) => {
    const rows = sh.rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((v, ci) => {
      const ref = `${col(ci)}${ri + 1}`;
      const style = sh.headerRows && sh.headerRows.includes(ri) ? ' s="1"' : '';
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
      if (v === null || v === undefined || v === '') return '';
      return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${x(v)}</t></is></c>`;
    }).join('') + '</row>').join('');
    const cols = (sh.widths || []).length
      ? '<cols>' + sh.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>' : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${rows}</sheetData></worksheet>`;
  };
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${x(s.name).slice(0, 31)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0B2545"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ];
  return zip(files);
}

// ── renderers ───────────────────────────────────────────────────────────────

function renderXlsx(rep) {
  const { ref, boxes, compare, totals } = rep;
  const summary = [
    ['Packing list', ref.reference],
    ['Client', ref.client_name],
    ['Type', ref.kind.toUpperCase()],
    ['Status', ref.status],
    ['Generated', fmtDate(rep.generated_at)],
    [],
    ['Boxes', boxes.length],
    ['Units packed', totals.packed],
    ['Units requested', totals.requested],
    ['SKUs OK', totals.ok || 0],
    ['SKUs short', totals.short || 0],
    ['SKUs over', totals.over || 0],
    ['SKUs missing', totals.missing || 0],
    ['SKUs packed but not requested', totals.not_requested || 0],
    ['Total weight (lb)', rep.total_weight_lb || ''],
    [],
    ['Prepared by', LEGAL],
    ['Address', ADDRESS],
  ];
  const detail = [['Box', 'Box #', 'SKU', 'ASIN', 'FNSKU', 'Qty', 'Weight (lb)', 'Dimensions (in)', 'Sealed']];
  boxes.forEach((b, i) => b.lines.forEach((l) => detail.push([
    b.code, i + 1, l.sku, l.asin || '', l.fnsku || '', l.qty,
    b.weight_lb != null ? Number(b.weight_lb) : '', b.dims || '', b.sealed_at ? fmtDate(b.sealed_at) : 'NOT SEALED',
  ])));
  const cmp = [['SKU', 'ASIN', 'FNSKU', 'Description', 'Requested', 'Packed', 'Difference', 'Boxes', 'Status', 'Note']];
  compare.forEach((r) => cmp.push([r.sku, r.asin || '', r.fnsku || '', r.description || '', r.qty_requested, r.qty_packed, r.diff, r.box_codes || '', r.state, NOTE[r.state] || '']));
  return buildXlsx([
    { name: 'Summary', rows: summary, widths: [30, 50] },
    { name: 'Box detail', rows: detail, headerRows: [0], widths: [13, 7, 34, 13, 13, 7, 11, 16, 20] },
    { name: 'Requested vs packed', rows: cmp, headerRows: [0], widths: [34, 13, 13, 36, 11, 9, 11, 30, 14, 28] },
  ]);
}

function renderHtml(rep) {
  const { ref, boxes, compare, totals } = rep;
  const badge = (s) => `<span class="st st-${s}">${s.replace('_', ' ')}</span>`;
  const boxRows = boxes.map((b, i) => b.lines.map((l, j) => `<tr${j === 0 ? ' class="first"' : ''}>
      ${j === 0 ? `<td rowspan="${b.lines.length}" class="box"><b>${esc(b.code)}</b><br><small>Box ${i + 1} of ${boxes.length}</small>${b.weight_lb != null ? `<br><small>${esc(b.weight_lb)} lb</small>` : ''}${b.dims ? `<br><small>${esc(b.dims)} in</small>` : ''}${b.sealed_at ? '' : '<br><small class="warn">not sealed</small>'}</td>` : ''}
      <td class="mono">${esc(l.sku)}</td><td class="mono">${esc(l.asin || '')}</td><td class="mono">${esc(l.fnsku || '')}</td><td class="num">${l.qty}</td></tr>`).join('')).join('');
  const cmpRows = compare.map((r) => `<tr class="row-${r.state}"><td class="mono">${esc(r.sku)}</td><td>${esc(r.description || '')}</td>
      <td class="num">${r.qty_requested}</td><td class="num">${r.qty_packed}</td><td class="num">${r.diff > 0 ? '+' : ''}${r.diff}</td>
      <td>${badge(r.state)}</td><td>${esc(NOTE[r.state] || '')}</td></tr>`).join('');
  const verdict = !compare.length ? 'No requested lines loaded yet.'
    : totals.complete ? 'Every requested SKU was packed in full.'
    : 'There are differences between what was requested and what was packed — see the table below.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Packing list ${esc(ref.reference)}</title>
<style>
:root{--navy:#0B2545;--teal:#1C7293;--orange:#F4A261;--line:#E2E8F0;--muted:#64748B;--bg:#fff}
*{box-sizing:border-box}body{font:13px/1.45 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a;margin:0;background:var(--bg)}
.wrap{max-width:960px;margin:0 auto;padding:28px 24px}
header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:4px solid var(--navy);padding-bottom:12px;margin-bottom:18px}
h1{margin:0;color:var(--navy);font-size:24px}h2{color:var(--navy);font-size:16px;margin:26px 0 8px;border-left:4px solid var(--orange);padding-left:8px}
.sub{color:var(--teal);font-weight:600}.muted{color:var(--muted)}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.kpi{border:1px solid var(--line);border-top:3px solid var(--orange);padding:10px;border-radius:6px;background:#F8FAFC}
.kpi b{display:block;font-size:22px;color:var(--navy)}.verdict{margin:14px 0 0;padding:10px 12px;border-radius:6px;background:#F1F5F9}
table{width:100%;border-collapse:collapse;margin-top:4px}th{background:var(--navy);color:#fff;text-align:left;font-weight:600;padding:6px 8px;font-size:12px}
td{border-bottom:1px solid var(--line);padding:5px 8px;vertical-align:top}tr.first td{border-top:2px solid #CBD5E1}
.mono{font-family:Consolas,Menlo,monospace;font-size:12px}.num{text-align:right;font-variant-numeric:tabular-nums}.box{background:#F8FAFC;width:120px}
.warn{color:#B45309;font-weight:600}.st{font-size:11px;font-weight:700;padding:2px 6px;border-radius:4px;white-space:nowrap}
.st-OK{background:#DCFCE7;color:#166534}.st-SHORT,.st-MISSING{background:#FEE2E2;color:#991B1B}.st-OVER,.st-NOT_REQUESTED{background:#FEF3C7;color:#92400E}
footer{margin-top:30px;color:var(--muted);font-size:11px;border-top:1px solid var(--line);padding-top:8px}
.noprint{margin-bottom:14px}.noprint button{background:var(--navy);color:#fff;border:0;padding:8px 14px;border-radius:6px;font-weight:600;cursor:pointer}
@media print{.noprint{display:none}.wrap{padding:0}tr{page-break-inside:avoid}@page{size:letter;margin:.5in}}
@media (max-width:640px){.kpis{grid-template-columns:repeat(2,1fr)}header{flex-direction:column;align-items:flex-start;gap:6px}}
</style></head><body><div class="wrap">
<div class="noprint"><button onclick="window.print()">Print</button></div>
<header><div><h1>Packing list</h1><div class="sub">${esc(ref.reference)} · ${esc(ref.client_name)}</div></div>
<div class="muted" style="text-align:right">${esc(ref.kind.toUpperCase())} · ${esc(ref.status)}<br>${esc(fmtDate(rep.generated_at))}</div></header>
<h2>Summary</h2>
<div class="kpis"><div class="kpi"><b>${boxes.length}</b>Boxes</div><div class="kpi"><b>${totals.packed}</b>Units packed</div>
<div class="kpi"><b>${totals.requested}</b>Units requested</div><div class="kpi"><b>${rep.total_weight_lb || '—'}</b>Total lb</div></div>
<p class="verdict">${esc(verdict)}</p>
<h2>Box detail</h2>
${boxes.length ? `<table><thead><tr><th>Box</th><th>SKU</th><th>ASIN</th><th>FNSKU</th><th class="num">Qty</th></tr></thead><tbody>${boxRows}</tbody></table>` : '<p class="muted">No boxes attached to this order yet.</p>'}
<h2>Requested vs packed</h2>
${compare.length ? `<table><thead><tr><th>SKU</th><th>Description</th><th class="num">Requested</th><th class="num">Packed</th><th class="num">Diff</th><th>Status</th><th>Note</th></tr></thead><tbody>${cmpRows}</tbody></table>` : '<p class="muted">Nothing to compare yet.</p>'}
<footer>${esc(LEGAL)} · ${esc(ADDRESS)} · warehouse@fr-logistics.net</footer>
</div></body></html>`;
}

// ── handler ─────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  const cors = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
  };
  const res = (code, obj) => ({ statusCode: code, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res(500, { error: 'Supabase not configured' });
  const enc = encodeURIComponent;
  const sb = async (path, opts = {}) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...opts,
      headers: {
        apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json', ...(opts.headers || {}),
      },
    });
    const t = await r.text();
    if (!r.ok) { const e = new Error(`Supabase ${r.status}: ${t}`); e.status = r.status; e.body = t; throw e; }
    return t ? JSON.parse(t) : null;
  };
  const post = (table, rows, prefer = 'return=representation') =>
    sb(table, { method: 'POST', headers: { Prefer: prefer }, body: JSON.stringify(rows) });
  const patch = (path, body) =>
    sb(path, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) });
  const logEvent = (row) => post('wh_container_events', [row], 'return=minimal').catch(() => {});

  const getRef = async (id) => {
    if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
    const r = await sb(`fba_shipments?id=eq.${enc(id)}&select=*&limit=1`);
    return r && r[0] ? r[0] : null;
  };

  // Codes the client or Amazon uses for a SKU, looked up only for the SKUs on
  // this order: FNSKU from the map (X00…), ASIN from the map or from a barcode
  // somebody confirmed by hand while packing (B0…).
  const identifiersFor = async (skus) => {
    const out = {};
    if (!skus.length) return out;
    const list = skus.map((s) => `"${String(s).replace(/"/g, '\\"')}"`).join(',');
    const [mapRows, evRows] = await Promise.all([
      sb(`wh_fnsku_map?sku=in.(${enc(list)})&select=code,sku&limit=5000`).catch(() => []),
      sb(`wh_container_events?event=eq.line_set&sku=in.(${enc(list)})&detail=like.B0*&select=sku,detail&limit=5000`).catch(() => []),
    ]);
    for (const r of mapRows || []) {
      const o = (out[r.sku] = out[r.sku] || {});
      if (/^X00/i.test(r.code) && !o.fnsku) o.fnsku = r.code;
      if (/^B0/i.test(r.code) && !o.asin) o.asin = r.code;
    }
    for (const r of evRows || []) {
      const o = (out[r.sku] = out[r.sku] || {});
      if (!o.asin && r.detail !== r.sku) o.asin = r.detail;
    }
    return out;
  };

  const buildReport = async (ref) => {
    const [cli, boxesRaw, compareRaw] = await Promise.all([
      sb(`fr_clients?id=eq.${enc(ref.client_id)}&select=company,name&limit=1`),
      sb(`wh_containers?fba_shipment_id=eq.${enc(ref.id)}&status=neq.consumed&select=*&order=box_seq.asc.nullslast,code.asc&limit=500`),
      sb(`v_outbound_packlist_compare?shipment_id=eq.${enc(ref.id)}&select=*&limit=5000`),
    ]);
    const boxes = boxesRaw || [];
    const ids = boxes.map((b) => b.id);
    const lines = ids.length
      ? await sb(`wh_container_lines?container_id=in.(${ids.map(enc).join(',')})&qty=gt.0&select=container_id,sku,qty&order=sku.asc&limit=10000`)
      : [];
    const compare = (compareRaw || []).sort((a, b) => {
      const rank = { MISSING: 0, SHORT: 1, OVER: 2, NOT_REQUESTED: 3, OK: 4 };
      return (rank[a.state] - rank[b.state]) || String(a.sku).localeCompare(String(b.sku));
    });
    const expectedIds = Object.fromEntries(compare.map((r) => [r.sku, { fnsku: r.fnsku, asin: r.asin }]));
    const allSkus = [...new Set([...(lines || []).map((l) => l.sku), ...compare.map((r) => r.sku)])];
    const known = await identifiersFor(allSkus);
    const idOf = (sku) => ({
      fnsku: (expectedIds[sku] && expectedIds[sku].fnsku) || (known[sku] && known[sku].fnsku) || null,
      asin: (expectedIds[sku] && expectedIds[sku].asin) || (known[sku] && known[sku].asin) || null,
    });
    for (const r of compare) { const i = idOf(r.sku); r.fnsku = i.fnsku; r.asin = i.asin; }

    const outBoxes = boxes.map((b) => ({
      code: b.code, status: b.status, location_code: b.location_code, sealed_at: b.sealed_at,
      weight_lb: b.weight_lb, box_seq: b.box_seq,
      dims: b.length_in && b.width_in && b.height_in ? `${Number(b.length_in)}×${Number(b.width_in)}×${Number(b.height_in)}` : null,
      lines: (lines || []).filter((l) => l.container_id === b.id).map((l) => ({ sku: l.sku, qty: l.qty, ...idOf(l.sku) })),
    }));
    const weights = outBoxes.map((b) => Number(b.weight_lb)).filter((n) => Number.isFinite(n) && n > 0);
    return {
      ref: { ...ref, client_name: (cli && cli[0] && (cli[0].company || cli[0].name)) || '' },
      boxes: outBoxes,
      compare,
      totals: summarize(compare),
      units_in_boxes: outBoxes.reduce((n, b) => n + b.lines.reduce((m, l) => m + l.qty, 0), 0),
      unsealed: outBoxes.filter((b) => b.status !== 'sealed').map((b) => b.code),
      total_weight_lb: weights.length === outBoxes.length && weights.length ? Math.round(weights.reduce((a, b) => a + b, 0) * 10) / 10 : null,
      generated_at: new Date().toISOString(),
    };
  };

  try {
    const qs = event.queryStringParameters || {};
    let body = {};
    if (event.httpMethod === 'POST') {
      try { body = JSON.parse(event.body || '{}'); } catch { return res(400, { error: 'Invalid JSON body' }); }
    }
    const action = (event.httpMethod === 'GET' ? qs.action : body.action) || '';

    // ── READS ─────────────────────────────────────────────────────────────
    if (action === 'list') {
      const f = [];
      if (qs.kind && KINDS.includes(qs.kind)) f.push(`kind=eq.${qs.kind}`);
      else f.push('kind=in.(pickup,b2b)');
      if (qs.client_id) f.push(`client_id=eq.${enc(qs.client_id)}`);
      if (!qs.include_closed) f.push('status=not.in.(closed,shipped)');
      const rows = await sb(`fba_shipments?${f.join('&')}&select=id,reference,kind,status,client_id,created_at,closed_at,notes,client:fr_clients(company,name)&order=created_at.desc&limit=200`);
      return res(200, { references: (rows || []).map((r) => ({ ...r, client_name: r.client ? (r.client.company || r.client.name) : '' })) });
    }

    if (action === 'report') {
      const ref = await getRef(qs.id);
      if (!ref) return res(404, { error: 'Reference not found' });
      const rep = await buildReport(ref);
      const safe = String(ref.reference).replace(/[^\w.-]+/g, '_');
      if (qs.format === 'html') {
        return { statusCode: 200, headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' }, body: renderHtml(rep) };
      }
      if (qs.format === 'xlsx') {
        return {
          statusCode: 200, isBase64Encoded: true,
          headers: {
            ...cors,
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="PackingList_${safe}.xlsx"`,
          },
          body: renderXlsx(rep).toString('base64'),
        };
      }
      return res(200, rep);
    }

    if (action === 'boxes_available') {
      const ref = await getRef(qs.id);
      if (!ref) return res(404, { error: 'Reference not found' });
      const rows = await sb(`v_wh_container_summary?client_id=eq.${enc(ref.client_id)}&status=neq.consumed&fba_shipment_id=is.null&select=*&order=code.asc&limit=500`);
      return res(200, {
        // PICKUP shelf first: that is where pickup orders are staged.
        boxes: (rows || []).slice()
          .sort((a, b) => (a.location_code === 'PICKUP' ? -1 : 0) - (b.location_code === 'PICKUP' ? -1 : 0) || String(a.code).localeCompare(b.code)),
      });
    }

    // ── WRITES ────────────────────────────────────────────────────────────
    if (event.httpMethod !== 'POST') return res(405, { error: 'Method not allowed' });
    const actor = body.actor ? String(body.actor).slice(0, 60) : null;

    if (action === 'create') {
      const reference = String(body.reference || '').trim().toUpperCase();
      const kind = KINDS.includes(body.kind) ? body.kind : 'pickup';
      if (!body.client_id) return res(400, { error: 'client_id is required' });
      if (!reference) return res(400, { error: 'reference is required' });
      const existing = await sb(`fba_shipments?client_id=eq.${enc(body.client_id)}&reference=ilike.${enc(reference)}&select=*&limit=1`);
      if (existing && existing[0]) return res(200, { reference: existing[0], existed: true });
      const cli = await sb(`fr_clients?id=eq.${enc(body.client_id)}&select=client_code&limit=1`);
      const created = await post('fba_shipments', [{
        client_id: body.client_id, reference, kind, status: 'packing',
        client_code: (cli && cli[0] && cli[0].client_code) || null,
        notes: body.notes ? String(body.notes).slice(0, 2000) : null, created_by: actor,
      }]);
      return res(200, { reference: created[0], existed: false });
    }

    const ref = await getRef(body.id);
    if (!ref) return res(404, { error: 'Reference not found' });
    const closed = ref.status === 'closed' || ref.status === 'shipped';

    if (action === 'set_expected') {
      if (closed) return res(409, { error: 'REFERENCE_CLOSED', message: `${ref.reference} is closed.` });
      const src = body.csv ? parseCsv(body.csv) : (Array.isArray(body.lines) ? body.lines : []);
      const { lines, bad } = mergeLines(src);
      if (!lines.length) return res(400, { error: 'NO_LINES', message: 'No valid SKU + quantity lines found.', bad });

      // The client may list FNSKUs or UPCs instead of SKUs. Translate what the
      // map knows; keep the rest as written and report them as unknown.
      const list = lines.map((l) => `"${l.sku.replace(/"/g, '\\"')}"`).join(',');
      const [owned, bySku, byCode] = await Promise.all([
        sb(`wh_sku_clients?sku=in.(${enc(list)})&select=sku&limit=5000`),
        sb(`wh_fnsku_map?sku=in.(${enc(list)})&select=sku&limit=5000`),
        sb(`wh_fnsku_map?code=in.(${enc(list)})&select=code,sku&limit=5000`),
      ]);
      const knownSku = new Set([...(owned || []), ...(bySku || [])].map((r) => r.sku));
      const codeTo = new Map((byCode || []).map((r) => [r.code, r.sku]));
      const translated = []; const unknown = [];
      for (const l of lines) {
        if (knownSku.has(l.sku)) continue;
        const t = codeTo.get(l.sku);
        if (t) {
          translated.push({ from: l.sku, to: t });
          if (/^X00/i.test(l.sku) && !l.fnsku) l.fnsku = l.sku;
          l.sku = t;
        } else unknown.push(l.sku);
      }
      const final = mergeLines(lines).lines;

      if (body.replace !== false) {
        await sb(`outbound_expected_lines?shipment_id=eq.${enc(ref.id)}`, { method: 'DELETE' });
      }
      await post('outbound_expected_lines', final.map((l) => ({
        shipment_id: ref.id, sku: l.sku, qty: l.qty, fnsku: l.fnsku, asin: l.asin,
        description: l.description, source: body.csv ? 'csv' : 'manual',
      })), 'resolution=merge-duplicates,return=minimal');
      return res(200, {
        loaded: final.length, units: final.reduce((n, l) => n + l.qty, 0),
        translated, unknown, bad,
      });
    }

    if (action === 'attach' || action === 'detach') {
      if (closed) return res(409, { error: 'REFERENCE_CLOSED', message: `${ref.reference} is closed.` });
      const codes = (action === 'attach' ? (body.codes || []) : [body.code]).map(normalizeCode).filter(Boolean);
      if (!codes.length) return res(400, { error: 'No valid box codes' });
      const boxes = await sb(`wh_containers?code=in.(${codes.map(enc).join(',')})&select=*&limit=500`);
      const done = []; const refused = [];
      for (const code of codes) {
        const b = (boxes || []).find((x) => x.code === code);
        if (!b) { refused.push({ code, reason: 'not found' }); continue; }
        if (b.status === 'consumed') { refused.push({ code, reason: 'consumed' }); continue; }
        if (action === 'attach') {
          // A box of another client on this order is the error nobody catches
          // later — it leaves the building with the wrong customer.
          if (b.client_id && b.client_id !== ref.client_id) { refused.push({ code, reason: `belongs to ${b.client}` }); continue; }
          if (b.fba_shipment_id && b.fba_shipment_id !== ref.id) { refused.push({ code, reason: 'already on another order' }); continue; }
          await patch(`wh_containers?id=eq.${enc(b.id)}`, {
            fba_shipment_id: ref.id, kind: ref.kind === 'fba' ? 'fba' : 'outbound', updated_at: new Date().toISOString(),
          });
          await logEvent({ container_id: b.id, event: 'note', actor, detail: `attached to ${ref.kind} ${ref.reference}` });
        } else {
          if (b.fba_shipment_id !== ref.id) { refused.push({ code, reason: 'not on this order' }); continue; }
          await patch(`wh_containers?id=eq.${enc(b.id)}`, { fba_shipment_id: null, kind: 'storage', box_seq: null, updated_at: new Date().toISOString() });
          await logEvent({ container_id: b.id, event: 'note', actor, detail: `detached from ${ref.reference}` });
        }
        done.push(code);
      }
      return res(200, { done, refused });
    }

    if (action === 'close') {
      if (closed) return res(409, { error: 'REFERENCE_CLOSED', message: `${ref.reference} is already closed.` });
      const rep = await buildReport(ref);
      if (!rep.boxes.length) return res(409, { error: 'NO_BOXES', message: 'No boxes are attached to this order.' });
      if (rep.unsealed.length) {
        return res(409, { error: 'UNSEALED_BOXES', message: `Seal these boxes first: ${rep.unsealed.join(', ')}`, unsealed: rep.unsealed });
      }
      // The automatic boxes-vs-request check. A difference is not a hard stop —
      // a client can accept a short pickup — but it must be seen and confirmed.
      const diffs = rep.compare.filter((r) => r.state !== 'OK');
      if (diffs.length && !body.confirm_diff) {
        return res(409, { error: 'DIFFERENCES', message: `${diffs.length} SKU(s) differ from the request.`, diffs, totals: rep.totals });
      }
      const upd = await patch(`fba_shipments?id=eq.${enc(ref.id)}&status=not.in.(closed,shipped)`, {
        status: 'closed', closed_at: new Date().toISOString(), closed_by: actor, updated_at: new Date().toISOString(),
      });
      // Numbered in the order they will appear on the list: "Box 3 of 12".
      await Promise.all(rep.boxes.map((b, i) =>
        sb(`wh_containers?code=eq.${enc(b.code)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ box_seq: i + 1 }) }).catch(() => {})));
      return res(200, { reference: upd && upd[0], closed_with_diffs: diffs.length, totals: rep.totals });
    }

    return res(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[frm-packlist]', err);
    return res(err.status && err.status < 500 ? err.status : 500, { error: 'Request failed', message: String(err.message || err) });
  }
};

exports._helpers = { parseCsv, mergeLines, summarize, buildXlsx, renderHtml, renderXlsx, normalizeCode, crc32 };
