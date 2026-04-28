// ════════════════════════════════════════════════════════════════════════════
// billing-generator.js — FR-Logistics Monthly Invoice Builder (Orchestrator)
//
// Architecture:
//   This function is a THIN ORCHESTRATOR. It does NOT talk to ShipStation API
//   directly, does NOT match shipments by string. Instead it composes the
//   results of these existing specialized functions:
//
//   ┌─ billing-shipstation.js  → orders + carrierCost (mode store|cf1)
//   ├─ billing-inbound.js      → cartons / RMA / drop-ship from shipments_general
//   ├─ fr_services_pending_billing → manual services (Services Log)
//   ├─ fr_clients              → contract: billing_source, mmb, shipping_markup, rate_overrides
//   └─ billing_runs            → invoice persistence (extended with mmb, status, client_id)
//
// Endpoints:
//   GET  ?action=preview&client_id=X&period=YYYY-MM  → preview with all sources
//   POST ?action=confirm  body: { client_id, period, line_items, ... }  → lock invoice
//   GET  ?action=history&client_id=X                 → past invoices
//   GET  ?action=invoice&id=X                        → single invoice details
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

// Default rate card if billing-rates.js is unavailable
const DEFAULT_RATES = {
  PNP:    3.00,   // Pick & Pack
  RPF:    5.00,   // Return Processing Fee
  INBND_PKG:   2.50,   // Inbound Receiving (carton)
  INBND_DROP:  6.00,   // Inbound Drop-Ship
  INBND_PLT:  20.00,   // Inbound Pallet
  OF_PKG:     2.00,    // Outbound Carton Fee
  STG:        45.00,   // Storage per rack/month
  WMS:        99.99,   // WMS subscription monthly
  KIT:         0.75,   // Kitting per unit
  LBL:         0.60,   // FNSKU/Label per unit
  CP:         50.00,   // Custom Project
};

// ════════════════════════════════════════════════════════════════════════════
// HANDLER
// ════════════════════════════════════════════════════════════════════════════
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: HEADERS_RESP, body: "" };
  if (!SUPA_URL || !SUPA_KEY)         return resp(500, { error: "Supabase env vars missing" });

  const params = event.queryStringParameters || {};
  const action = params.action;

  try {
    if (event.httpMethod === "GET" && action === "preview")  return await getPreview(params, event);
    if (event.httpMethod === "POST" && action === "confirm") return await confirmInvoice(safeJSON(event.body));
    if (event.httpMethod === "GET" && action === "history")  return await getHistory(params);
    if (event.httpMethod === "GET" && action === "invoice")  return await getInvoice(params);
    return resp(400, { error: "Unknown action. Try: preview | confirm | history | invoice" });
  } catch (err) {
    console.error("billing-generator error:", err);
    return resp(500, { error: err.message || String(err) });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// PREVIEW — orchestrates all sub-functions and builds a draft invoice
// ════════════════════════════════════════════════════════════════════════════
async function getPreview(params, event) {
  const clientId = params.client_id;
  const period   = params.period;     // "YYYY-MM"
  if (!clientId) return resp(400, { error: "client_id required" });
  if (!period)   return resp(400, { error: "period required (YYYY-MM)" });

  // 1. Load client from fr_clients (single source of truth)
  const client = await loadClient(clientId);
  if (!client) return resp(404, { error: "Client not found in fr_clients" });

  // 2. Determine period dates
  const periodStart = `${period}-01`;
  const periodEnd   = lastDayOfMonth(period);

  // 3. Build sub-function call URLs (use the request host so we work in any env)
  const baseUrl = inferBaseUrl(event);

  // 4. Call billing-shipstation.js according to billing_source contract
  const ssData = await callShipStation(baseUrl, client, periodStart, periodEnd);

  // 5. Call billing-inbound.js
  const inbData = await callInbound(baseUrl, client.name, periodStart, periodEnd);

  // 6. Read Services Log (manually-logged warehouse services)
  const services = await loadServices(clientId, period);

  // 7. Apply rate card (with per-client overrides)
  const rateCard = buildRateCard(client.rate_overrides || {});

  // 8. Build line items
  const lineItems = buildLineItems(client, ssData, inbData, services, rateCard);

  // 9. Calculate totals + MMB comparison
  const actualsTotal = round2(lineItems.reduce((s, li) => s + li.line_total, 0));
  const mmb          = parseFloat(client.mmb || 0);
  const mmbApplies   = mmb > 0;
  const billable     = mmbApplies ? Math.max(actualsTotal, mmb) : actualsTotal;
  const recommended  = mmbApplies && mmb > actualsTotal ? "mmb" : "actuals";

  // 10. Check for already-locked invoice in this period
  const existing = await checkExistingInvoice(clientId, periodStart, periodEnd);

  return resp(200, {
    client: {
      id:                client.id,
      name:              client.name,
      company:           client.company,
      billing_source:    client.billing_source,
      store_name:        client.store_name,
      ss_custom_field_1: client.ss_custom_field_1,
      shipping_markup:   client.shipping_markup,
      mmb:               mmb,
      aliases:           client.aliases || [],
      billing_notes:     client.billing_notes || "",
    },
    period,
    period_start: periodStart,
    period_end:   periodEnd,
    sources: {
      shipstation: ssData,
      inbound:     inbData,
      services_logged: services.length,
    },
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

// ════════════════════════════════════════════════════════════════════════════
// CONFIRM — locks invoice into billing_runs and marks services + shipments
// ════════════════════════════════════════════════════════════════════════════
async function confirmInvoice(body) {
  const required = ['client_id','period','line_items','actuals_total','applied_amount','applied_method'];
  for (const f of required) if (body[f] == null) return resp(400, { error: `${f} required` });
  if (!['actuals','mmb'].includes(body.applied_method)) return resp(400, { error: "applied_method must be 'actuals' or 'mmb'" });

  // 1. Re-check no locked invoice exists for this client+period
  const periodStart = `${body.period}-01`;
  const periodEnd   = lastDayOfMonth(body.period);
  const existing = await checkExistingInvoice(body.client_id, periodStart, periodEnd);
  if (existing) {
    return resp(409, {
      error: "Invoice already locked for this client and period",
      existing_invoice: existing,
    });
  }

  // 2. Load client for snapshot
  const client = await loadClient(body.client_id);
  if (!client) return resp(404, { error: "Client not found" });

  // 3. Generate invoice number
  const invoiceNumber = await generateInvoiceNumber(client, body.period);

  // 4. Insert into billing_runs
  const row = {
    invoice_number:  invoiceNumber,
    client:          client.name,
    client_code:     deriveClientCode(client.name),
    client_id:       body.client_id,
    period_start:    periodStart,
    period_end:      periodEnd,
    total_usd:       body.applied_amount,
    package_count:   body.line_items.reduce((n, li) => n + (parseInt(li.quantity, 10) || 0), 0),
    line_items_json: body.line_items,
    mmb_amount:      body.mmb_amount || 0,
    applied_method:  body.applied_method,
    status:          'locked',
    rate_card_used:  body.rate_card_used || {},
    generated_at:    new Date().toISOString(),
    generated_by:    body.generated_by || 'billing-generator',
    notes:           body.notes || null,
  };

  const insert = await fetch(`${SUPA_URL}/rest/v1/billing_runs`, {
    method:  "POST",
    headers: HEADERS_SUPA,
    body:    JSON.stringify(row),
  });
  if (!insert.ok) {
    const err = await insert.text();
    return resp(500, { error: "Failed to insert invoice", detail: err });
  }
  const inserted = await insert.json();
  const newInvoice = Array.isArray(inserted) ? inserted[0] : inserted;

  // 5. Mark services as billed (those linked to this period)
  await markServicesBilled(body.client_id, body.period, newInvoice.id);

  // 6. Mark shipments_general as billed (those that were invoiced)
  // Only shipments in the period that were unbilled — preserves existing logic.
  await markShipmentsBilled(body.client_id, periodStart, periodEnd, newInvoice.id);

  return resp(200, { ok: true, invoice: newInvoice });
}

// ════════════════════════════════════════════════════════════════════════════
// HISTORY
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
async function callShipStation(baseUrl, client, from, to) {
  const empty = { mode: 'skipped', count: 0, carrierCost: 0, storeMatched: false, storeNames: [] };
  const billingSource = (client.billing_source || '').toLowerCase().trim();

  // Mode: portal — client doesn't use ShipStation at all
  if (billingSource === 'portal') {
    return { ...empty, mode: 'portal' };
  }

  // Mode: ss_store — call billing-shipstation.js with store param
  if (billingSource === 'ss_store') {
    const storeName = (client.store_name || '').trim();
    if (!storeName) return { ...empty, mode: 'ss_store', error: 'store_name not set on client' };
    const url = `${baseUrl}/.netlify/functions/billing-shipstation?start=${from}&end=${to}&store=${encodeURIComponent(storeName)}`;
    return await fetchSubFunction(url, empty);
  }

  // Mode: ss_cf1 — call billing-shipstation.js with cf1 param
  if (billingSource === 'ss_cf1') {
    const cf1 = (client.ss_custom_field_1 || '').trim();
    if (!cf1) return { ...empty, mode: 'ss_cf1', error: 'ss_custom_field_1 not set on client' };
    const url = `${baseUrl}/.netlify/functions/billing-shipstation?start=${from}&end=${to}&cf1=${encodeURIComponent(cf1)}`;
    return await fetchSubFunction(url, empty);
  }

  return { ...empty, mode: 'unknown:' + billingSource };
}

async function callInbound(baseUrl, clientName, from, to) {
  const empty = { count: 0, rmaCount: 0, dropShipCount: 0, billed: { count: 0, rmaCount: 0, dropShipCount: 0, invoices: [] } };
  if (!clientName) return empty;
  const url = `${baseUrl}/.netlify/functions/billing-inbound?client=${encodeURIComponent(clientName)}&start=${from}&end=${to}`;
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
// LINE ITEM BUILDER
// ════════════════════════════════════════════════════════════════════════════
function buildLineItems(client, ss, inb, services, rateCard) {
  const items = [];

  // Pick & Pack — based on ShipStation order count
  if (ss.count > 0) {
    const r = rateCard.PNP;
    items.push({
      source:       "shipstation",
      service_code: "PNP",
      service_name: "Pick & Pack",
      quantity:     ss.count,
      unit:         "orders",
      unit_rate:    r,
      line_total:   round2(ss.count * r),
      detail:       `${ss.count} orders shipped${ss.mode ? ` (${ss.mode})` : ''}`,
    });
  }

  // Shipping Label Fee — pass-through with per-client markup
  if (ss.carrierCost > 0) {
    const pct = isNaN(parseFloat(client.shipping_markup)) ? 10 : parseFloat(client.shipping_markup);
    const multiplier = 1 + (pct / 100);
    const total = round2(ss.carrierCost * multiplier);
    items.push({
      source:       "shipstation",
      service_code: "SLF",
      service_name: `Shipping Label Fee (cost + ${pct}%)`,
      quantity:     1,
      unit:         "period",
      unit_rate:    total,
      line_total:   total,
      detail:       `Carrier cost $${ss.carrierCost.toFixed(2)} × ${multiplier.toFixed(2)} markup`,
    });
  }

  // Manual services from Services Log
  services.forEach(s => {
    items.push({
      source:       "services_log",
      service_code: s.service_code,
      service_name: s.service_name,
      quantity:     parseFloat(s.total_quantity),
      unit:         s.unit || "units",
      unit_rate:    parseFloat(s.unit_rate),
      line_total:   round2(parseFloat(s.line_total_subtotal)),
      detail:       `${s.entry_count} log entries`,
    });
  });

  // Inbound General cartons (count = inb.count, which excludes RMA and Drop)
  if (inb.count > 0) {
    const r = rateCard.INBND_PKG;
    items.push({
      source:       "shipments_general",
      service_code: "INBND_PKG",
      service_name: "Inbound Receiving — Cartons",
      quantity:     inb.count,
      unit:         "cartons",
      unit_rate:    r,
      line_total:   round2(inb.count * r),
      detail:       `${inb.count} general cartons received`,
    });
  }

  // Drop-shipments (Outbound type ILIKE *Drop*)
  if (inb.dropShipCount > 0) {
    const r = rateCard.INBND_DROP;
    items.push({
      source:       "shipments_general",
      service_code: "INBND_DROP",
      service_name: "Drop-Shipment Processing",
      quantity:     inb.dropShipCount,
      unit:         "packages",
      unit_rate:    r,
      line_total:   round2(inb.dropShipCount * r),
      detail:       `${inb.dropShipCount} drop-shipments`,
    });
  }

  // Returns (Inbound type ILIKE *RMA*)
  if (inb.rmaCount > 0) {
    const r = rateCard.RPF;
    items.push({
      source:       "shipments_general",
      service_code: "RPF",
      service_name: "Return Processing",
      quantity:     inb.rmaCount,
      unit:         "units",
      unit_rate:    r,
      line_total:   round2(inb.rmaCount * r),
      detail:       `${inb.rmaCount} RMA returns processed`,
    });
  }

  return items;
}

function buildRateCard(overrides) {
  return { ...DEFAULT_RATES, ...overrides };
}

// ════════════════════════════════════════════════════════════════════════════
// SUPABASE HELPERS
// ════════════════════════════════════════════════════════════════════════════
async function loadClient(id) {
  const url = `${SUPA_URL}/rest/v1/fr_clients?id=eq.${id}&limit=1`;
  const r = await fetch(url, { headers: HEADERS_SUPA });
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
  // Format: INV-YYYY-MM-CODE   e.g. INV-2026-04-MIL
  const code = deriveClientCode(client.name);
  return `INV-${period}-${code}`;
}

function deriveClientCode(name) {
  if (!name) return 'XXX';
  // Pull first 3 letters of first word, uppercase
  const first = name.trim().split(/\s+/)[0] || '';
  return first.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'XXX';
}

async function markServicesBilled(clientId, period, invoiceId) {
  // Update fr_services_log rows for this client + period from 'logged' to 'billed'
  const url = `${SUPA_URL}/rest/v1/fr_services_log?client_id=eq.${clientId}` +
              `&period=eq.${period}&status=eq.logged`;
  await fetch(url, {
    method:  "PATCH",
    headers: HEADERS_SUPA,
    body:    JSON.stringify({ status: 'billed', billed_at: new Date().toISOString(), billing_id: invoiceId }),
  });
}

async function markShipmentsBilled(clientId, periodStart, periodEnd, invoiceId) {
  // Update unbilled shipments in shipments_general for this client + period
  const url = `${SUPA_URL}/rest/v1/shipments_general?client_id=eq.${clientId}` +
              `&created_at=gte.${periodStart}&created_at=lte.${periodEnd}T23:59:59` +
              `&billed_at=is.null`;
  await fetch(url, {
    method:  "PATCH",
    headers: HEADERS_SUPA,
    body:    JSON.stringify({ billed_at: new Date().toISOString(), billing_id: invoiceId }),
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
