// ════════════════════════════════════════════════════════════════════════════
// billing-generator.js — FR-Logistics Monthly Invoice Builder
//
// Endpoints:
//   GET  ?action=preview&client_id=X&period=YYYY-MM   → preview line items
//   POST ?action=confirm                              → lock invoice
//   GET  ?action=history                              → list past invoices
//   GET  ?action=invoice&id=X                         → fetch one invoice
//   GET  ?action=email-template&id=X                  → branded HTML for Gmail
// ════════════════════════════════════════════════════════════════════════════

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

const HEADERS_SUPA = {
  "apikey":         SUPA_KEY,
  "Authorization": "Bearer " + SUPA_KEY,
  "Content-Type":  "application/json",
  "Prefer":        "return=representation",
};

const HEADERS_RESP = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// ════════════════════════════════════════════════════════════════════════════
// SERVICE CATALOG — maps fr_client_rates columns to billing line items
// service_code is also the QBO service name reference (used in CSV export)
// ════════════════════════════════════════════════════════════════════════════
const SERVICE_CATALOG = [
  { code: 'WMS',        rate_col: 'wms',                qbo_name: 'Automated WMS',                          name: 'Automated WMS Fees',                unit: 'month',   source: 'fixed',       fixed: true },
  { code: 'STG_RACK',   rate_col: 'storage_rack',       qbo_name: 'Storage Fees Rack Position',             name: 'Storage — Rack Position',           unit: 'rack',    source: 'fixed',       fixed: true },
  { code: 'STG_LBIN',   rate_col: 'storage_lbin',       qbo_name: 'Storage Fees Large Bin',                 name: 'Storage — Large Bin',               unit: 'bin',     source: 'fixed',       fixed: true, optional: true },
  { code: 'STG_SBIN',   rate_col: 'storage_sbin',       qbo_name: 'Storage Fees Small Bin',                 name: 'Storage — Small Bin',               unit: 'bin',     source: 'fixed',       fixed: true, optional: true },
  { code: 'INBND_PKG',  rate_col: 'inbound_carton',     qbo_name: 'Inbound Fees Packages',                  name: 'Inbound Receiving — Packages',      unit: 'cartons', source: 'inbound',     auto_qty: 'count' },
  { code: 'INBND_DROP', rate_col: 'drop_shipment',      qbo_name: 'Inbound-Dropshipment',                   name: 'Inbound Drop-Shipment',             unit: 'pkg',     source: 'inbound',     auto_qty: 'inboundDropshipCount' },
  { code: 'INBND_PLT',  rate_col: 'inbound_pallet',     qbo_name: 'Inbound Fees Pallets',                   name: 'Inbound — Pallets',                 unit: 'pallet',  source: 'manual',      optional: true },
  { code: 'OUT_PKG',    rate_col: 'outbound_carton',    qbo_name: 'Outbound Fees Package',                  name: 'Outbound Fees — Package',           unit: 'pkg',     source: 'inbound',     auto_qty: 'outboundCount' },
  { code: 'OUT_DROP',   rate_col: 'drop_shipment',      qbo_name: 'Drop-Shipment Service',                  name: 'Outbound Drop-Shipment',            unit: 'pkg',     source: 'inbound',     auto_qty: 'outboundDropshipCount' },
  { code: 'OUT_PLT',    rate_col: 'outbound_pallet',    qbo_name: 'Outbound Fees Pallets',                  name: 'Outbound — Pallets',                unit: 'pallet',  source: 'manual',      optional: true },
  { code: 'RPF',        rate_col: 'return_proc',        qbo_name: 'Return Processing Fees',                 name: 'Return Processing',                 unit: 'unit',    source: 'inbound',     auto_qty: 'rmaCount' },
  { code: 'PNP',        rate_col: 'pick_pack',          qbo_name: 'Fulfillment Process (Pick & Pack)',      name: 'Fulfillment Process (Pick & Pack)', unit: 'order',   source: 'shipstation', auto_qty: 'orderCount' },
  { code: 'SLF',        rate_col: '__shipping_label__', qbo_name: 'Shipping Label Fee',                     name: 'Shipping Label Fee (cost + markup)', unit: 'period', source: 'shipstation', auto_qty: 'shippingLabel' },
  { code: 'PIF',        rate_col: 'qc',                 qbo_name: 'Product Inspection Fees',                name: 'Product Inspection (QC)',           unit: 'hour',    source: 'services_log' },
  { code: 'BCUIB',      rate_col: 'boxing',             qbo_name: 'Boxing / collating units into boxes',    name: 'Boxing / Collating Units',          unit: 'unit',    source: 'services_log' },
  { code: 'KIT',        rate_col: 'kitting',            qbo_name: 'Kitting & Bundling',                     name: 'Kitting & Bundling',                unit: 'unit',    source: 'services_log' },
  { code: 'POLY',       rate_col: 'poly_bag',           qbo_name: 'Poly Bagging',                           name: 'Poly Bagging',                      unit: 'unit',    source: 'services_log' },
  { code: 'LBL',        rate_col: 'labeling',           qbo_name: 'Labeling Fees',                          name: 'Labeling — ASIN / UPC',             unit: 'unit',    source: 'services_log' },
  { code: 'LBL_REM',    rate_col: 'label_removal',      qbo_name: 'Removal of Old Labels',                  name: 'Removal of Old Labels',             unit: 'unit',    source: 'services_log' },
  { code: 'PALETIZE',   rate_col: 'palletizing',        qbo_name: 'Palletizing Labor',                      name: 'Palletizing Labor',                 unit: 'pallet',  source: 'services_log' },
  { code: 'STRETCH',    rate_col: 'stretch_wrap',       qbo_name: 'Stretch Wrapping',                       name: 'Stretch Wrapping',                  unit: 'pallet',  source: 'services_log' },
  { code: 'SORT',       rate_col: 'sorting',            qbo_name: 'Sorting',                                name: 'Sorting',                           unit: 'unit',    source: 'services_log', optional: true },
  { code: 'REFURB',     rate_col: 'refurb',             qbo_name: 'Refurbishment',                          name: 'Refurbishment',                     unit: 'unit',    source: 'services_log', optional: true },
  { code: 'DISPOSAL',   rate_col: 'disposal',           qbo_name: 'Disposal',                               name: 'Disposal',                          unit: 'unit',    source: 'services_log', optional: true },
  { code: 'PICKUP',     rate_col: 'carrier_pickup',     qbo_name: 'Carrier Pickup',                         name: 'Carrier Pickup',                    unit: 'pickup',  source: 'services_log', optional: true },
  { code: 'CP',         rate_col: '__custom__',         qbo_name: 'Custom Project',                         name: 'Custom Project',                    unit: 'project', source: 'services_log', optional: true },
];

// ════════════════════════════════════════════════════════════════════════════
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: HEADERS_RESP, body: "" };
  if (!SUPA_URL || !SUPA_KEY)         return resp(500, { error: "Supabase env vars missing" });

  const params = event.queryStringParameters || {};
  const action = params.action;

  try {
    if (event.httpMethod === "GET" && action === "preview")        return await getPreview(params, event);
    if (event.httpMethod === "POST" && action === "confirm")       return await confirmInvoice(safeJSON(event.body));
    if (event.httpMethod === "GET" && action === "history")        return await getHistory(params);
    if (event.httpMethod === "GET" && action === "invoice")        return await getInvoice(params);
    if (event.httpMethod === "GET" && action === "email-template") return await getEmailTemplate(params);
    return resp(400, { error: "Unknown action" });
  } catch (err) {
    console.error("billing-generator error:", err);
    return resp(500, { error: err.message || String(err) });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// PREVIEW
// ════════════════════════════════════════════════════════════════════════════
async function getPreview(params, event) {
  const clientId = params.client_id;
  const period   = params.period;
  if (!clientId) return resp(400, { error: "client_id required" });
  if (!period)   return resp(400, { error: "period required (YYYY-MM)" });

  const periodStart = `${period}-01`;
  const periodEnd   = lastDayOfMonth(period);
  const baseUrl     = inferBaseUrl(event);

  const client = await loadClient(clientId);
  if (!client) return resp(404, { error: "Client not found in fr_clients" });

  const rateCard = await callBillingRates(baseUrl, client.name);
  const ssData   = await callShipStation(baseUrl, client, periodStart, periodEnd);
  const inbData  = await callInbound(baseUrl, clientId, client.name, periodStart, periodEnd);
  const services = await loadServices(clientId, period);

  const sources = {
    orderCount:            ssData.count || 0,
    carrierCost:           ssData.carrierCost || 0,
    shippingLabel:         (ssData.carrierCost || 0) > 0 ? 1 : 0,
    count:                 inbData.count || 0,
    rmaCount:              inbData.rmaCount || 0,
    inboundDropshipCount:  inbData.inboundDropshipCount || 0,
    outboundCount:         inbData.outboundCount || 0,
    outboundDropshipCount: inbData.outboundDropshipCount || 0,
  };

  const servicesByCode = {};
  services.forEach(s => { servicesByCode[s.service_code] = s; });

  const lineItems = SERVICE_CATALOG.map(svc => buildLineItem(svc, rateCard, sources, servicesByCode, client))
    .filter(li => !(li.optional && li.quantity === 0 && li.unit_rate === 0));

  const actualsTotal = round2(lineItems.reduce((s, li) => s + li.line_total, 0));
  const mmb          = parseFloat(client.mmb || 0);
  const mmbApplies   = mmb > 0;
  const billable     = mmbApplies ? Math.max(actualsTotal, mmb) : actualsTotal;
  const recommended  = mmbApplies && mmb > actualsTotal ? "mmb" : "actuals";

  const existing = await checkExistingInvoice(clientId, periodStart, periodEnd);

  return resp(200, {
    client: {
      id:                client.id,
      name:              client.name,
      company:           client.company,
      contact_email:     client.contact_email,
      billing_source:    client.billing_source,
      store_name:        client.store_name,
      ss_custom_field_1: client.ss_custom_field_1,
      shipping_markup:   client.shipping_markup,
      mmb:               mmb,
      aliases:           client.aliases || [],
      services:          client.services || [],
    },
    period,
    period_start: periodStart,
    period_end:   periodEnd,
    sources,
    shipstation_match: { mode: ssData.mode, store_matched: ssData.storeMatched, store_names: ssData.storeNames },
    line_items: lineItems,
    totals: {
      actuals_total:     actualsTotal,
      mmb_amount:        mmb,
      mmb_applies:       mmbApplies,
      mmb_difference:    round2(mmb - actualsTotal),
      recommended:       recommended,
      recommended_total: billable,
    },
    rate_card_used: rateCard,
    existing_invoice: existing,
  });
}

function buildLineItem(svc, rateCard, sources, servicesByCode, client) {
  let rate = 0;
  if (svc.rate_col === '__shipping_label__') {
    const pct = parseFloat(client.shipping_markup) || 10;
    rate = round2(sources.carrierCost * (1 + pct / 100));
  } else if (svc.rate_col === '__custom__') {
    rate = 0;
  } else {
    rate = parseFloat(rateCard[svc.rate_col]) || 0;
  }

  let quantity = 0, detail = '', hasMovement = false;

  if (svc.fixed) {
    if (svc.code === 'WMS') {
      quantity = rate > 0 ? 1 : 0;
    } else {
      quantity = 0; // Storage stays 0 until SKUVault hookup or manual entry
    }
    detail = quantity > 0 ? `Monthly subscription` : '';
    hasMovement = quantity > 0;
  }
  else if (svc.source === 'shipstation') {
    if (svc.code === 'SLF') {
      quantity = sources.shippingLabel;
      detail = sources.carrierCost > 0
        ? `Carrier cost $${sources.carrierCost.toFixed(2)} × ${(1 + (parseFloat(client.shipping_markup) || 10) / 100).toFixed(2)} markup`
        : '';
      hasMovement = quantity > 0;
    } else {
      quantity = sources[svc.auto_qty] || 0;
      detail = quantity > 0 ? `${quantity} ${svc.unit}s shipped (store)` : '';
      hasMovement = quantity > 0;
    }
  }
  else if (svc.source === 'inbound') {
    quantity = sources[svc.auto_qty] || 0;
    detail = quantity > 0 ? `${quantity} from warehouse log` : '';
    hasMovement = quantity > 0;
  }
  else if (svc.source === 'services_log') {
    const sl = servicesByCode[svc.code];
    quantity = sl ? parseFloat(sl.total_quantity) || 0 : 0;
    if (sl) {
      if (sl.unit_rate && parseFloat(sl.unit_rate) > 0) rate = parseFloat(sl.unit_rate);
      detail = `${sl.entry_count || 1} entries logged`;
    }
    hasMovement = quantity > 0;
  }

  return {
    service_code:  svc.code,
    service_name:  svc.name,
    qbo_name:      svc.qbo_name,
    source:        svc.source,
    unit:          svc.unit,
    quantity:      quantity,
    unit_rate:     rate,
    line_total:    round2(quantity * rate),
    detail:        detail,
    has_movement:  hasMovement,
    is_fixed:      !!svc.fixed,
    optional:      !!svc.optional,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// CONFIRM
// ════════════════════════════════════════════════════════════════════════════
async function confirmInvoice(body) {
  const required = ['client_id', 'period', 'line_items', 'actuals_total', 'applied_amount', 'applied_method'];
  for (const f of required) if (body[f] == null) return resp(400, { error: `${f} required` });
  if (!['actuals', 'mmb'].includes(body.applied_method)) return resp(400, { error: "applied_method must be 'actuals' or 'mmb'" });

  const periodStart = `${body.period}-01`;
  const periodEnd   = lastDayOfMonth(body.period);
  const existing    = await checkExistingInvoice(body.client_id, periodStart, periodEnd);
  if (existing) return resp(409, { error: "Invoice already locked", existing_invoice: existing });

  const client = await loadClient(body.client_id);
  if (!client) return resp(404, { error: "Client not found" });

  const invoiceNumber = await generateInvoiceNumber(client, body.period);
  const persistedLines = (body.line_items || []).filter(li => parseFloat(li.quantity) > 0);

  const row = {
    invoice_number:  invoiceNumber,
    client:          client.name,
    client_code:     deriveClientCode(client.name),
    client_id:       body.client_id,
    period_start:    periodStart,
    period_end:      periodEnd,
    total_usd:       body.applied_amount,
    package_count:   persistedLines.reduce((n, li) => n + (parseInt(li.quantity, 10) || 0), 0),
    line_items_json: persistedLines,
    mmb_amount:      body.mmb_amount || 0,
    applied_method:  body.applied_method,
    status:          'locked',
    rate_card_used:  body.rate_card_used || {},
    generated_at:    new Date().toISOString(),
    generated_by:    body.generated_by || 'billing-generator',
    notes:           body.notes || null,
  };

  const insert = await fetch(`${SUPA_URL}/rest/v1/billing_runs`, {
    method: "POST", headers: HEADERS_SUPA, body: JSON.stringify(row),
  });
  if (!insert.ok) {
    return resp(500, { error: "Failed to insert invoice", detail: await insert.text() });
  }
  const inserted   = await insert.json();
  const newInvoice = Array.isArray(inserted) ? inserted[0] : inserted;

  await markServicesBilled(body.client_id, body.period, newInvoice.id);
  await markShipmentsBilled(body.client_id, periodStart, periodEnd, newInvoice.id);

  return resp(200, { ok: true, invoice: newInvoice });
}

// ════════════════════════════════════════════════════════════════════════════
// EMAIL TEMPLATE — branded HTML for Gmail Compose
// ════════════════════════════════════════════════════════════════════════════
async function getEmailTemplate(params) {
  const id = params.id;
  if (!id) return resp(400, { error: "id required" });

  const r = await fetch(`${SUPA_URL}/rest/v1/billing_runs?id=eq.${id}&limit=1`, { headers: HEADERS_SUPA });
  const data = await r.json();
  const inv = Array.isArray(data) && data[0] ? data[0] : null;
  if (!inv) return resp(404, { error: "Invoice not found" });

  // Get client contact email
  let contactEmail = '';
  if (inv.client_id) {
    const cr = await fetch(`${SUPA_URL}/rest/v1/fr_clients?id=eq.${inv.client_id}&select=contact_email&limit=1`, { headers: HEADERS_SUPA });
    const cdata = await cr.json();
    if (Array.isArray(cdata) && cdata[0]) contactEmail = cdata[0].contact_email || '';
  }

  const fmtDate = iso => {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${m}/${d}/${y}`;
  };
  const fmtUSD = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0);

  const periodLabel = `${fmtDate(inv.period_start)} – ${fmtDate(inv.period_end)}`;
  const subject     = `Billing Summary ${inv.invoice_number} — ${inv.client} | ${periodLabel}`;

  // Build line items rows
  const lineRows = (inv.line_items_json || []).map(li => `
    <tr style="border-bottom:1px solid #e8e8e8;">
      <td style="padding:10px 14px;font-size:14px;color:#1a1a1a;">${li.qbo_name || li.service_name}</td>
      <td style="padding:10px 14px;font-size:14px;color:#666;text-align:center;">${li.quantity} ${li.unit || ''}</td>
      <td style="padding:10px 14px;font-size:14px;color:#1a1a1a;text-align:right;font-weight:500;">${fmtUSD(li.line_total)}</td>
    </tr>
  `).join('');

  const html = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:20px;background:#f5f7fa;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;">

    <div style="background:linear-gradient(135deg,#0F6E56 0%,#16a34a 100%);padding:24px 28px;color:#fff;">
      <div style="font-size:22px;font-weight:700;margin-bottom:4px;">FR-Logistics <span style="font-weight:300;font-size:16px;opacity:0.85;">· Billing Summary</span></div>
      <div style="font-size:13px;opacity:0.9;">${inv.invoice_number} · ${periodLabel}</div>
    </div>

    <div style="padding:24px 28px;">
      <p style="margin:0 0 12px;font-size:15px;color:#1a1a1a;">Dear ${inv.client},</p>
      <p style="margin:0 0 18px;font-size:14px;color:#444;line-height:1.5;">
        Please find below your billing summary for the period <strong>${periodLabel}</strong>. The PDF is attached for your records.
      </p>

      <table style="width:100%;border-collapse:collapse;margin:18px 0;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden;">
        <thead>
          <tr style="background:#f8fafc;">
            <th style="padding:10px 14px;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;text-align:left;font-weight:600;">Service</th>
            <th style="padding:10px 14px;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;text-align:center;font-weight:600;">Qty</th>
            <th style="padding:10px 14px;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;text-align:right;font-weight:600;">Amount</th>
          </tr>
        </thead>
        <tbody>${lineRows}</tbody>
        <tfoot>
          <tr style="background:#E1F5EE;border-top:2px solid #0F6E56;">
            <td colspan="2" style="padding:14px;font-size:14px;color:#085041;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">Invoice Total</td>
            <td style="padding:14px;font-size:18px;color:#085041;font-weight:700;text-align:right;">${fmtUSD(inv.total_usd)}</td>
          </tr>
        </tfoot>
      </table>

      <div style="margin:20px 0;padding:14px;border:2px dashed #9FE1CB;border-radius:8px;background:#F4FBF8;text-align:center;">
        <div style="font-size:11px;color:#085041;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">View Invoice Online — QBO</div>
        <div style="font-size:14px;color:#0F6E56;font-weight:500;">→ <a href="#" style="color:#0F6E56;">QBO invoice link here</a> ←</div>
        <div style="font-size:11px;color:#666;margin-top:6px;">Open invoice in QBO → copy URL from browser → paste &amp; replace this line</div>
      </div>

      <p style="margin:18px 0 0;font-size:13px;color:#666;">
        Questions? Reply to this email or call (786) 300-1443.
      </p>
    </div>

    <div style="background:#0d1a2b;padding:18px 28px;color:#fff;font-size:12px;display:flex;justify-content:space-between;">
      <div>
        <div style="font-weight:600;">Jose Fuentes — Operations Manager</div>
        <div style="opacity:0.8;">FR-Logistics · Miami, FL 33172</div>
      </div>
      <div style="text-align:right;">
        <div>(786) 300-1443</div>
        <div style="opacity:0.8;">info@fr-logistics.net</div>
      </div>
    </div>

  </div>
</body>
</html>
`.trim();

  return resp(200, {
    invoice_number: inv.invoice_number,
    client:         inv.client,
    contact_email:  contactEmail,
    subject,
    html,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// HISTORY + INVOICE
// ════════════════════════════════════════════════════════════════════════════
async function getHistory(params) {
  const clientId = params.client_id;
  let url = `${SUPA_URL}/rest/v1/billing_runs?order=generated_at.desc&limit=50`;
  if (clientId) url += `&client_id=eq.${encodeURIComponent(clientId)}`;
  const r = await fetch(url, { headers: HEADERS_SUPA });
  const data = await r.json();
  return resp(200, Array.isArray(data) ? data : []);
}

async function getInvoice(params) {
  const id = params.id;
  if (!id) return resp(400, { error: "id required" });
  const r = await fetch(`${SUPA_URL}/rest/v1/billing_runs?id=eq.${id}&limit=1`, { headers: HEADERS_SUPA });
  const data = await r.json();
  return resp(200, Array.isArray(data) && data[0] ? data[0] : null);
}

// ════════════════════════════════════════════════════════════════════════════
// SUB-FUNCTION CALLERS
// ════════════════════════════════════════════════════════════════════════════
async function callBillingRates(baseUrl, clientName) {
  try {
    const url = `${baseUrl}/.netlify/functions/billing-rates?client=${encodeURIComponent(clientName)}`;
    const r = await fetch(url);
    if (!r.ok) return {};
    const data = await r.json();
    return data.rates || {};
  } catch { return {}; }
}

async function callShipStation(baseUrl, client, from, to) {
  const empty = { mode: 'skipped', count: 0, carrierCost: 0, storeMatched: false, storeNames: [] };
  const billingSource = (client.billing_source || '').toLowerCase().trim();
  if (billingSource === 'portal') return { ...empty, mode: 'portal' };
  if (billingSource === 'ss_store') {
    const storeName = (client.store_name || '').trim();
    if (!storeName) return { ...empty, mode: 'ss_store', error: 'store_name not set' };
    const url = `${baseUrl}/.netlify/functions/billing-shipstation?start=${from}&end=${to}&store=${encodeURIComponent(storeName)}`;
    return await fetchSubFunction(url, empty);
  }
  if (billingSource === 'ss_cf1') {
    const cf1 = (client.ss_custom_field_1 || '').trim();
    if (!cf1) return { ...empty, mode: 'ss_cf1', error: 'ss_custom_field_1 not set' };
    const url = `${baseUrl}/.netlify/functions/billing-shipstation?start=${from}&end=${to}&cf1=${encodeURIComponent(cf1)}`;
    return await fetchSubFunction(url, empty);
  }
  return { ...empty, mode: 'unknown:' + billingSource };
}

async function callInbound(baseUrl, clientId, clientName, from, to) {
  const empty = { count: 0, rmaCount: 0, dropShipCount: 0, inboundDropshipCount: 0, outboundCount: 0, outboundDropshipCount: 0 };
  const url = `${baseUrl}/.netlify/functions/billing-inbound?client_id=${clientId}&client=${encodeURIComponent(clientName)}&start=${from}&end=${to}`;
  return await fetchSubFunction(url, empty);
}

async function fetchSubFunction(url, fallback) {
  try {
    const r = await fetch(url);
    if (!r.ok) return { ...fallback, error: `HTTP ${r.status}` };
    return await r.json();
  } catch (err) {
    return { ...fallback, error: err.message };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SUPABASE HELPERS
// ════════════════════════════════════════════════════════════════════════════
async function loadClient(id) {
  const r = await fetch(`${SUPA_URL}/rest/v1/fr_clients?id=eq.${id}&limit=1`, { headers: HEADERS_SUPA });
  const data = await r.json();
  return Array.isArray(data) && data[0] ? data[0] : null;
}

async function loadServices(clientId, period) {
  const url = `${SUPA_URL}/rest/v1/fr_services_pending_billing?client_id=eq.${clientId}&period=eq.${period}`;
  const r = await fetch(url, { headers: HEADERS_SUPA });
  const data = await r.json();
  return Array.isArray(data) ? data : [];
}

async function checkExistingInvoice(clientId, periodStart, periodEnd) {
  const url = `${SUPA_URL}/rest/v1/billing_runs?client_id=eq.${clientId}` +
              `&period_start=eq.${periodStart}&period_end=eq.${periodEnd}` +
              `&status=in.(locked,sent,paid)&limit=1`;
  const r = await fetch(url, { headers: HEADERS_SUPA });
  const data = await r.json();
  return Array.isArray(data) && data[0] ? data[0] : null;
}

async function generateInvoiceNumber(client, period) {
  return `INV-${period}-${deriveClientCode(client.name)}`;
}

function deriveClientCode(name) {
  if (!name) return 'XXX';
  const first = name.trim().split(/\s+/)[0] || '';
  return first.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'XXX';
}

async function markServicesBilled(clientId, period, invoiceId) {
  const url = `${SUPA_URL}/rest/v1/fr_services_log?client_id=eq.${clientId}&period=eq.${period}&status=eq.logged`;
  await fetch(url, {
    method: "PATCH", headers: HEADERS_SUPA,
    body: JSON.stringify({ status: 'billed', billed_at: new Date().toISOString(), billing_id: invoiceId }),
  });
}

async function markShipmentsBilled(clientId, periodStart, periodEnd, invoiceId) {
  const url = `${SUPA_URL}/rest/v1/shipments_general?client_id=eq.${clientId}` +
              `&created_at=gte.${periodStart}&created_at=lte.${periodEnd}T23:59:59&billed_at=is.null`;
  await fetch(url, {
    method: "PATCH", headers: HEADERS_SUPA,
    body: JSON.stringify({ billed_at: new Date().toISOString(), billing_id: invoiceId }),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// UTILS
// ════════════════════════════════════════════════════════════════════════════
function inferBaseUrl(event) {
  const proto = event.headers["x-forwarded-proto"] || "https";
  const host  = event.headers["x-forwarded-host"] || event.headers.host || "apps.fr-logistics.net";
  return `${proto}://${host}`;
}

function lastDayOfMonth(periodYM) {
  const [y, m] = periodYM.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${periodYM}-${String(last).padStart(2,'0')}`;
}

function round2(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }
function safeJSON(s) { try { return JSON.parse(s || "{}"); } catch { return {}; } }
function resp(statusCode, payload) { return { statusCode, headers: HEADERS_RESP, body: JSON.stringify(payload) }; }
