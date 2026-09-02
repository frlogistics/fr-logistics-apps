/**
 * frm-fba-manifest.js  —  FR-Logistics
 *
 * Cierra el flujo de FBA Count: convierte un conteo cerrado en los dos
 * documentos que faltaban.
 *
 * GET ?action=manifest&shipment_id=…    -> HTML imprimible (el documento formal
 *                                          que FR le manda al cliente)
 * GET ?action=packlist&shipment_id=…    -> CSV, una fila por CAJA, para transcribir
 *                                          al template de Send to Amazon
 * GET ?action=summary&shipment_id=…     -> JSON con los totales
 *
 * SOLO LECTURA. No modifica el conteo ni cambia su estado.
 *
 * NOTA SOBRE AMAZON: el template de box content se descarga DENTRO del flujo
 * del shipment en Seller Central, ya viene con el Shipment ID y los SKUs de ese
 * envio, y renombrarlo rompe la carga. Por eso esto NO pretende ser ese archivo:
 * es la data de origen, en el orden en que se transcribe.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY  (ambas ya existen)
 */

const ALLOWED_ORIGINS = [
  'https://apps.fr-logistics.net',
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
];

const LEGAL_NAME = 'FR Logistics Miami Inc';
const DBA = 'FR-Logistics';
const ADDRESS = '10893 NW 17th Street, Unit 121, Miami, FL 33172';

/* ------------------------------------------------------------- helpers */

function cors(origin) {
  const o = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': o,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
  };
}

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** RFC 4180: comillas dobladas, y se envuelve si hay coma, comilla o salto. */
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvRow = (arr) => arr.map(csvCell).join(',');

/**
 * Expande las lineas a una fila POR CAJA, que es como Amazon pide el box
 * content. Una linea 'case' de 4 cajas x 12 unidades produce 4 filas de 12.
 * Las 'loose' producen una sola fila sin numero de caja: son las que Amazon
 * reparte entre cajas mixtas en el propio flujo.
 */
function expandBoxes(lines) {
  const rows = [];
  let boxNo = 0;
  for (const l of lines.filter((x) => x.line_type === 'case')) {
    const n = Number(l.boxes) || 0;
    const upb = Number(l.units_per_box) || 0;
    for (let i = 0; i < n; i++) {
      boxNo += 1;
      rows.push({
        box: boxNo,
        msku: l.msku,
        fnsku: l.fnsku || '',
        units: upb,
        length_in: l.length_in ?? '',
        width_in: l.width_in ?? '',
        height_in: l.height_in ?? '',
        weight_lb: l.weight_lb ?? '',
        expiration: l.expiration || '',
        lot_code: l.lot_code || '',
        type: 'case',
      });
    }
  }
  for (const l of lines.filter((x) => x.line_type === 'loose')) {
    rows.push({
      box: '', msku: l.msku, fnsku: l.fnsku || '', units: Number(l.quantity) || 0,
      length_in: '', width_in: '', height_in: '', weight_lb: '',
      expiration: l.expiration || '', lot_code: l.lot_code || '', type: 'loose',
    });
  }
  return rows;
}

/** Totales del envio. Se recalcula desde las lineas, nunca se confia en un cache. */
function totals(lines) {
  const cases = lines.filter((l) => l.line_type === 'case');
  const loose = lines.filter((l) => l.line_type === 'loose');
  const sum = (a, f) => a.reduce((n, x) => n + (Number(f(x)) || 0), 0);
  return {
    skus: new Set(lines.map((l) => l.msku)).size,
    lines: lines.length,
    case_lines: cases.length,
    loose_lines: loose.length,
    boxes: sum(cases, (l) => l.boxes),
    units_in_cases: sum(cases, (l) => l.quantity),
    units_loose: sum(loose, (l) => l.quantity),
    total_units: sum(lines, (l) => l.quantity),
    total_weight_lb: Number(
      cases.reduce((n, l) => n + (Number(l.weight_lb) || 0) * (Number(l.boxes) || 0), 0).toFixed(2)
    ),
  };
}

/** Lo que hay que arreglar ANTES de que esto salga del almacen. */
function gaps(lines, t) {
  const g = [];
  const noDims = lines.filter(
    (l) => l.line_type === 'case' && (!l.length_in || !l.width_in || !l.height_in || !l.weight_lb)
  );
  if (noDims.length)
    g.push(`${noDims.length} case line(s) missing box dimensions or weight — Amazon requires both before shipping.`);
  if (t.loose_lines && !t.boxes)
    g.push('All units are loose: box assignment still has to happen in the Send to Amazon workflow.');
  const noFnsku = lines.filter((l) => !l.fnsku);
  if (noFnsku.length)
    g.push(`${noFnsku.length} line(s) without an FNSKU — confirm the unit labels before shipping.`);
  return g;
}

async function sb(path) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY');
  const res = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

async function loadShipment(id) {
  const [ship] = await sb(
    `fba_shipments?id=eq.${encodeURIComponent(id)}` +
    `&select=id,reference,status,destination,ship_from,notes,created_by,created_at,updated_at,` +
    `client:fr_clients(id,name,company)&limit=1`
  );
  if (!ship) return null;
  const lines = await sb(
    `fba_shipment_lines?shipment_id=eq.${encodeURIComponent(id)}` +
    `&select=*&order=line_type.asc,msku.asc`
  );
  return { ship, lines: lines || [] };
}

/* -------------------------------------------------------------- salidas */

const PACKLIST_HEADERS = [
  'Box', 'Merchant SKU', 'FNSKU', 'Units in box', 'Box length (in)', 'Box width (in)',
  'Box height (in)', 'Box weight (lb)', 'Expiration', 'Lot', 'Pack type',
];

function buildPacklistCsv(ship, lines) {
  const rows = expandBoxes(lines);
  const t = totals(lines);
  const out = [
    csvRow([`FR-Logistics pack list — ${ship.reference}`]),
    csvRow([`Client: ${(ship.client && (ship.client.company || ship.client.name)) || ''}`]),
    csvRow([`Generated: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`]),
    csvRow([`Total units: ${t.total_units} · Boxes: ${t.boxes} · Loose lines: ${t.loose_lines}`]),
    '',
    csvRow(PACKLIST_HEADERS),
  ];
  for (const r of rows) {
    out.push(csvRow([
      r.box, r.msku, r.fnsku, r.units, r.length_in, r.width_in,
      r.height_in, r.weight_lb, r.expiration, r.lot_code, r.type,
    ]));
  }
  return out.join('\r\n');
}

function buildManifestHtml(ship, lines) {
  const t = totals(lines);
  const g = gaps(lines, t);
  const client = (ship.client && (ship.client.company || ship.client.name)) || '—';
  const boxRows = expandBoxes(lines);

  const lineRows = lines.map((l) => `
    <tr>
      <td>${esc(l.msku)}</td>
      <td class="mono">${esc(l.fnsku || '—')}</td>
      <td>${l.line_type === 'case' ? 'Case pack' : 'Loose'}</td>
      <td class="n">${l.line_type === 'case' ? `${l.units_per_box} × ${l.boxes}` : '—'}</td>
      <td class="n"><strong>${esc(l.quantity)}</strong></td>
      <td class="n">${l.line_type === 'case' && l.length_in
        ? `${l.length_in}×${l.width_in}×${l.height_in} in · ${l.weight_lb} lb` : '—'}</td>
      <td>${esc(l.expiration || '—')}</td>
      <td>${esc(l.counted_by || '—')}</td>
    </tr>`).join('');

  const boxTable = boxRows.filter((r) => r.box).length ? `
    <h2>Box detail</h2>
    <table>
      <thead><tr><th>Box</th><th>Merchant SKU</th><th>FNSKU</th><th class="n">Units</th>
      <th class="n">Dimensions</th><th class="n">Weight</th></tr></thead>
      <tbody>${boxRows.filter((r) => r.box).map((r) => `
        <tr><td class="n">${r.box}</td><td>${esc(r.msku)}</td><td class="mono">${esc(r.fnsku || '—')}</td>
        <td class="n">${r.units}</td>
        <td class="n">${r.length_in ? `${r.length_in}×${r.width_in}×${r.height_in} in` : '—'}</td>
        <td class="n">${r.weight_lb ? `${r.weight_lb} lb` : '—'}</td></tr>`).join('')}
      </tbody>
    </table>` : '';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>FBA Manifest — ${esc(ship.reference)}</title>
<style>
  :root{--navy:#0B2545;--teal:#1C7293;--line:#E2E8F0;--muted:#64748B;--amber:#F4A261;}
  *{box-sizing:border-box}
  body{font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#0F172A;margin:0;padding:28px;background:#fff}
  .wrap{max-width:920px;margin:0 auto}
  header{border-bottom:3px solid var(--navy);padding-bottom:14px;margin-bottom:20px;
         display:flex;justify-content:space-between;align-items:flex-end;gap:20px}
  h1{margin:0;font-size:20px;color:var(--navy)}
  .sub{color:var(--muted);font-size:12px;margin-top:3px}
  .co{text-align:right;font-size:11px;color:var(--muted);line-height:1.45}
  .co strong{color:var(--navy);font-size:13px}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--teal);
     margin:24px 0 8px;border-bottom:1px solid var(--line);padding-bottom:5px}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:16px 0}
  .kpi{border:1px solid var(--line);border-radius:6px;padding:10px 12px}
  .kpi .v{font-size:20px;font-weight:700;color:var(--navy)}
  .kpi .l{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th{text-align:left;background:#F1F5F9;padding:7px 8px;border-bottom:1px solid var(--line);
     font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
  td{padding:7px 8px;border-bottom:1px solid var(--line)}
  .n{text-align:right}
  .mono{font-family:Consolas,monospace;font-size:11px}
  .meta{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-size:12px}
  .meta div span{display:block;font-size:10px;text-transform:uppercase;color:var(--muted);letter-spacing:.04em}
  .gaps{background:#FFF7ED;border-left:3px solid var(--amber);padding:10px 12px;margin:16px 0;font-size:12px}
  .gaps ul{margin:6px 0 0;padding-left:18px}
  .sign{margin-top:34px;display:grid;grid-template-columns:1fr 1fr;gap:40px}
  .sign div{border-top:1px solid #94A3B8;padding-top:6px;font-size:11px;color:var(--muted)}
  footer{margin-top:26px;border-top:1px solid var(--line);padding-top:10px;
         font-size:10px;color:var(--muted);line-height:1.5}
  @media print{body{padding:0}.noprint{display:none}}
</style></head><body><div class="wrap">
<header>
  <div>
    <h1>FBA Shipment Manifest</h1>
    <div class="sub">${esc(ship.reference)} · ${esc(client)}</div>
  </div>
  <div class="co"><strong>${DBA}</strong><br>${LEGAL_NAME}<br>${ADDRESS}</div>
</header>

<div class="meta">
  <div><span>Status</span>${esc(ship.status)}</div>
  <div><span>Counted by</span>${esc(ship.created_by || '—')}</div>
  <div><span>Count date</span>${esc(String(ship.created_at).slice(0, 10))}</div>
  <div><span>Destination</span>${esc(ship.destination || 'Not assigned')}</div>
  <div><span>Ship from</span>${esc(ship.ship_from || ADDRESS)}</div>
  <div><span>Manifest generated</span>${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</div>
</div>

<div class="grid">
  <div class="kpi"><div class="v">${t.total_units}</div><div class="l">Total units</div></div>
  <div class="kpi"><div class="v">${t.skus}</div><div class="l">SKUs</div></div>
  <div class="kpi"><div class="v">${t.boxes}</div><div class="l">Case boxes</div></div>
  <div class="kpi"><div class="v">${t.units_loose}</div><div class="l">Loose units</div></div>
</div>

${g.length ? `<div class="gaps"><strong>Before this ships:</strong><ul>${
  g.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}

<h2>Counted lines</h2>
<table>
  <thead><tr><th>Merchant SKU</th><th>FNSKU</th><th>Pack</th><th class="n">Units × boxes</th>
  <th class="n">Quantity</th><th class="n">Box size</th><th>Expiration</th><th>Counted by</th></tr></thead>
  <tbody>${lineRows}</tbody>
</table>

${boxTable}

<div class="sign">
  <div>Counted and verified by — ${DBA}</div>
  <div>Received / approved by — ${esc(client)}</div>
</div>

<footer>
  This manifest records the physical count performed at ${ADDRESS}. Quantities are
  derived from the counted lines and recalculated at print time. Box content must still be
  entered in the client's own Send to Amazon workflow: Amazon's box content template is
  generated inside that shipment and cannot be produced externally.
  <br>${LEGAL_NAME} d/b/a ${DBA} · Shipment ${esc(ship.id)}
</footer>
<p class="noprint" style="margin-top:20px"><button onclick="window.print()">Print / Save as PDF</button></p>
</div></body></html>`;
}

/* -------------------------------------------------------------- handler */

exports.handler = async (event) => {
  const headers = cors(event.headers && (event.headers.origin || event.headers.Origin));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const q = event.queryStringParameters || {};
  const id = String(q.shipment_id || '').trim();

  if (!/^[0-9a-f-]{36}$/i.test(id))
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'shipment_id must be a UUID' }) };

  try {
    const data = await loadShipment(id);
    if (!data)
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Shipment not found' }) };
    const { ship, lines } = data;

    if (!lines.length)
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'This count has no lines yet.' }) };

    const slug = String(ship.reference).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);

    if (q.action === 'packlist') {
      return {
        statusCode: 200,
        headers: {
          ...headers,
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="FR_PackList_${slug}.csv"`,
        },
        body: '\uFEFF' + buildPacklistCsv(ship, lines), // BOM: Excel abre UTF-8 bien
      };
    }

    if (q.action === 'summary') {
      const t = totals(lines);
      return {
        statusCode: 200,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, shipment: ship, totals: t, gaps: gaps(lines, t) }, null, 2),
      };
    }

    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
      body: buildManifestHtml(ship, lines),
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(e.message || e) }) };
  }
};

module.exports.__test = { expandBoxes, totals, gaps, csvCell, csvRow, buildPacklistCsv, PACKLIST_HEADERS };
