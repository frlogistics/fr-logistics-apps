// ════════════════════════════════════════════════════════════════════════════
// billing-generator.js — FR-Logistics Billing Generator API
// Storage: Supabase + ShipStation API
// Pattern: same as services-log.js / wa-clients.js
//
// Endpoints:
//   GET    ?action=preview&client_id=X&period=YYYY-MM
//          → builds preview without persisting anything
//          returns: { client, period, sources, line_items, totals, mmb_comparison }
//
//   POST   action=confirm
//          body: { client_id, period, applied_amount, applied_method, notes, line_items, ... }
//          → creates fr_invoices row (status=locked) AND marks fr_services_log as billed
//          returns: { invoice_number, id, ...invoice }
//
//   GET    ?action=history&client_id=X&limit=N
//          → list of past invoices for a client
//
//   GET    ?action=invoice&id=N
//          → fetch a single invoice
// ════════════════════════════════════════════════════════════════════════════

const SUPA_URL    = process.env.SUPABASE_URL;
const SUPA_KEY    = process.env.SUPABASE_SERVICE_KEY;
const SS_KEY      = process.env.SS_API_KEY;
const SS_SECRET   = process.env.SS_API_SECRET;
const SS_BASE     = "https://ssapi.shipstation.com";

const HEADERS_SUPA = {
  "apikey":        SUPA_KEY,
  "Authorization": "Bearer " + SUPA_KEY,
  "Content-Type":  "application/json",
  "Prefer":        "return=representation",
};

const HEADERS_RESP = { "Content-Type": "application/json" };

// ── handler ────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (!SUPA_URL || !SUPA_KEY) {
    return resp(500, { error: "Supabase env vars missing" });
  }

  const method = event.httpMethod;
  const params = event.queryStringParameters || {};
  const action = params.action || (method === "POST" ? "confirm" : "preview");

  try {
    if (method === "GET" && action === "preview")  return await previewInvoice(params);
    if (method === "POST" && action === "confirm") return await confirmInvoice(safeJSON(event.body));
    if (method === "GET" && action === "history")  return await getHistory(params);
    if (method === "GET" && action === "invoice")  return await getInvoiceById(params);
    return resp(405, { error: "Unknown action: " + action });
  } catch (err) {
    return resp(500, { error: err.message || String(err) });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// PREVIEW — pulls all 3 sources, applies rate card, returns line items
// ════════════════════════════════════════════════════════════════════════════
async function previewInvoice(params) {
  const clientId = params.client_id;
  const period   = params.period;     // YYYY-MM

  if (!clientId) return resp(400, { error: "client_id required" });
  if (!/^\d{4}-\d{2}$/.test(period)) return resp(400, { error: "period required as YYYY-MM" });

  // 1. Load client + rate card snapshot
  const client = await loadClient(clientId);
  if (!client) return resp(404, { error: "Client not found" });

  const catalog = await loadCatalog();
  const rateCard = buildRateCard(client, catalog);

  // 2. Compute period boundaries
  const [year, month] = period.split('-').map(Number);
  const periodStart = `${year}-${String(month).padStart(2,'0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const periodEnd = `${year}-${String(month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;

  // 3. Read 3 sources in parallel
  const [services, shipments, ss] = await Promise.all([
    loadServicesLog(clientId, periodStart, periodEnd),
    loadShipments(client.id, periodStart, periodEnd),
    loadShipStation(client, periodStart, periodEnd),
  ]);

  // 4. Build line items from each source
  const lineItems = [];
  const sourceCounts = {
    orders:           ss.orderCount,
    shipping_cost:    ss.totalCarrierCost,
    cartons_in:       shipments.cartonsIn,
    cartons_out:      shipments.cartonsOut,
    pallets_in:       shipments.palletsIn,
    pallets_out:      shipments.palletsOut,
    inbound_general:  shipments.inboundGeneral,
    inbound_dropship: shipments.inboundDropship,
    outbound_dropship: shipments.outboundDropship,
    returns:          shipments.returns,
    services_logged:  services.length,
  };

  // 4a. Manual services from log
  for (const s of services) {
    lineItems.push({
      source:       "services_log",
      service_code: s.service_code,
      service_name: s.service_name,
      quantity:     parseFloat(s.total_quantity),
      unit:         s.unit,
      unit_rate:    parseFloat(s.avg_unit_rate),
      line_total:   parseFloat(s.total_amount),
      detail:       `${s.entry_count} log entries · ${s.first_date} to ${s.last_date}`,
      service_log_period: s.period,
    });
  }

  // 4b. ShipStation pick & pack
  if (ss.orderCount > 0) {
    const pnpRate = rateCard["PNP"] || 3.00;
    lineItems.push({
      source:       "shipstation",
      service_code: "PNP",
      service_name: "Pick & Pack — Fulfillment",
      quantity:     ss.orderCount,
      unit:         "orders",
      unit_rate:    pnpRate,
      line_total:   round2(ss.orderCount * pnpRate),
      detail:       `${ss.orderCount} orders shipped · stores: ${ss.storesMatched.join(', ') || 'auto'}`,
    });
  }

  // 4c. Shipping label fee — pass-through cost + 10% markup
  if (ss.totalCarrierCost > 0) {
    const markup = 1.10;
    const total = round2(ss.totalCarrierCost * markup);
    lineItems.push({
      source:       "shipstation",
      service_code: "SLF",
      service_name: "Shipping Label Fee (cost + 10%)",
      quantity:     1,
      unit:         "period",
      unit_rate:    total,
      line_total:   total,
      detail:       `Carrier cost $${ss.totalCarrierCost.toFixed(2)} × 1.10 markup`,
    });
  }

  // 4d. Inbound General — cartons received (excludes dropships and returns)
  if (shipments.inboundGeneral > 0) {
    const r = rateCard["INBND_PKG"] || rateCard["RECV_CARTON"] || 2.50;
    lineItems.push({
      source:       "shipments_general",
      service_code: "INBND_PKG",
      service_name: "Inbound Receiving — Cartons",
      quantity:     shipments.inboundGeneral,
      unit:         "cartons",
      unit_rate:    r,
      line_total:   round2(shipments.inboundGeneral * r),
      detail:       `${shipments.inboundGeneral} general cartons received`,
    });
  }

  // 4e. Inbound Drop-shipments — separate billable
  if (shipments.inboundDropship > 0) {
    const r = rateCard["INBND_DROP"] || rateCard["INBND_PKG"] || 6.00;
    lineItems.push({
      source:       "shipments_general",
      service_code: "INBND_DROP",
      service_name: "Inbound Drop-Shipment",
      quantity:     shipments.inboundDropship,
      unit:         "packages",
      unit_rate:    r,
      line_total:   round2(shipments.inboundDropship * r),
      detail:       `${shipments.inboundDropship} dropship packages received`,
    });
  }

  // 4f. Outbound shipments + dropshipments
  if (shipments.cartonsOut > 0) {
    const r = rateCard["OF_PKG"] || 2.00;
    lineItems.push({
      source:       "shipments_general",
      service_code: "OF_PKG",
      service_name: "Outbound Shipments",
      quantity:     shipments.cartonsOut,
      unit:         "cartons",
      unit_rate:    r,
      line_total:   round2(shipments.cartonsOut * r),
      detail:       `${shipments.cartonsOut} cartons shipped${shipments.outboundDropship > 0 ? ` (${shipments.outboundDropship} dropships)` : ''}`,
    });
  }

  // 4g. Returns (RMA)
  if (shipments.returns > 0) {
    const r = rateCard["RPF"] || 5.00;
    lineItems.push({
      source:       "shipments_general",
      service_code: "RPF",
      service_name: "Return Processing",
      quantity:     shipments.returns,
      unit:         "units",
      unit_rate:    r,
      line_total:   round2(shipments.returns * r),
      detail:       `${shipments.returns} RMA returns processed`,
    });
  }

  // 4h. Inbound pallets (legacy — keeps working if data has them)
  if (shipments.palletsIn > 0) {
    const r = rateCard["INBND_PLT"] || rateCard["RECV_PALLET"] || 20.00;
    lineItems.push({
      source:       "shipments_general",
      service_code: "INBND_PLT",
      service_name: "Inbound Pallets",
      quantity:     shipments.palletsIn,
      unit:         "pallets",
      unit_rate:    r,
      line_total:   round2(shipments.palletsIn * r),
      detail:       `${shipments.palletsIn} pallets received in period`,
    });
  }

  // 5. Totals + MMB comparison
  const actualsTotal = round2(lineItems.reduce((s, li) => s + li.line_total, 0));
  const mmb          = parseFloat(client.mmb || 0);
  const mmbApplies   = mmb > 0;
  const billable     = mmbApplies ? Math.max(actualsTotal, mmb) : actualsTotal;
  const recommendedMethod = mmbApplies && mmb > actualsTotal ? "mmb" : "actuals";

  // 6. Check if invoice already exists (locked) for this period
  const existing = await checkExistingInvoice(clientId, period);

  return resp(200, {
    client: {
      id:       client.id,
      name:     client.name,
      company:  client.company,
      mmb:      mmb,
      rate_overrides: client.rate_overrides || {},
      billing_notes: client.billing_notes || "",
    },
    period,
    period_start: periodStart,
    period_end:   periodEnd,
    sources: sourceCounts,
    line_items: lineItems,
    totals: {
      actuals_total:    actualsTotal,
      mmb_amount:       mmb,
      mmb_applies:      mmbApplies,
      mmb_difference:   round2(mmb - actualsTotal),
      recommended:      recommendedMethod,
      recommended_total: billable,
    },
    rate_card_used: rateCard,
    existing_invoice: existing,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// CONFIRM — locks invoice and marks services as billed
// ════════════════════════════════════════════════════════════════════════════
async function confirmInvoice(body) {
  const required = ['client_id','period','line_items','actuals_total','applied_amount','applied_method'];
  for (const f of required) if (body[f] == null) return resp(400, { error: `${f} required` });

  // 1. Re-check no locked invoice exists for this client+period
  const existing = await checkExistingInvoice(body.client_id, body.period);
  if (existing) {
    return resp(409, {
      error: "An invoice is already locked for this client and period",
      invoice: existing
    });
  }

  // 2. Get the next invoice number from the sequence
  const seqRes = await fetch(`${SUPA_URL}/rest/v1/rpc/nextval_fr_invoice_seq`, {
    method: "POST",
    headers: HEADERS_SUPA,
    body: "{}"
  });
  let invoiceNumber;
  if (seqRes.ok) {
    const seqVal = await seqRes.json();
    invoiceNumber = `FRL-${new Date().getFullYear()}-${String(seqVal).padStart(4,'0')}`;
  } else {
    // Fallback if RPC not available — use timestamp-based number
    invoiceNumber = `FRL-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
  }

  // 3. Compute period dates
  const [year, month] = body.period.split('-').map(Number);
  const periodStart = `${year}-${String(month).padStart(2,'0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const periodEnd = `${year}-${String(month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;

  // 4. Insert invoice
  const invoiceRow = {
    invoice_number: invoiceNumber,
    client_id:      body.client_id,
    client_name:    body.client_name,
    period:         body.period,
    period_start:   periodStart,
    period_end:     periodEnd,
    actuals_total:  body.actuals_total,
    mmb_amount:     body.mmb_amount || 0,
    applied_amount: body.applied_amount,
    applied_method: body.applied_method,
    line_items:     body.line_items,
    source_counts:  body.source_counts || {},
    rate_card_used: body.rate_card_used || {},
    status:         "locked",
    notes:          body.notes || null,
    generated_by:   body.generated_by || "Portal",
    locked_at:      new Date().toISOString(),
  };

  const invoiceRes = await fetch(`${SUPA_URL}/rest/v1/fr_invoices`, {
    method: "POST",
    headers: HEADERS_SUPA,
    body: JSON.stringify(invoiceRow),
  });
  const invoiceData = await invoiceRes.json();
  if (!Array.isArray(invoiceData) || !invoiceData[0]) {
    return resp(500, { error: "Failed to create invoice", detail: invoiceData });
  }

  // 5. Mark services_log entries as billed
  const markedAt = new Date().toISOString();
  await fetch(
    `${SUPA_URL}/rest/v1/fr_services_log?client_id=eq.${encodeURIComponent(body.client_id)}` +
    `&service_date=gte.${periodStart}&service_date=lte.${periodEnd}&status=eq.logged`,
    {
      method: "PATCH",
      headers: HEADERS_SUPA,
      body: JSON.stringify({
        status: "billed",
        invoice_period: body.period,
        invoice_id: invoiceNumber,
        updated_at: markedAt,
      }),
    }
  );

  return resp(201, invoiceData[0]);
}

// ════════════════════════════════════════════════════════════════════════════
// HISTORY — list invoices for a client
// ════════════════════════════════════════════════════════════════════════════
async function getHistory(params) {
  const clientId = params.client_id;
  const limit = Math.min(parseInt(params.limit || "50", 10), 200);
  let url = `${SUPA_URL}/rest/v1/fr_invoices?order=period.desc,id.desc&limit=${limit}`;
  if (clientId) url += `&client_id=eq.${encodeURIComponent(clientId)}`;
  const r = await fetch(url, { headers: HEADERS_SUPA });
  const data = await r.json();
  if (!Array.isArray(data)) return resp(500, { error: data });
  return resp(200, data);
}

async function getInvoiceById(params) {
  if (!params.id) return resp(400, { error: "id required" });
  const r = await fetch(`${SUPA_URL}/rest/v1/fr_invoices?id=eq.${params.id}`, { headers: HEADERS_SUPA });
  const data = await r.json();
  if (!Array.isArray(data) || !data[0]) return resp(404, { error: "Invoice not found" });
  return resp(200, data[0]);
}

// ════════════════════════════════════════════════════════════════════════════
// LOADERS
// ════════════════════════════════════════════════════════════════════════════
async function loadClient(id) {
  const r = await fetch(`${SUPA_URL}/rest/v1/fr_clients?id=eq.${encodeURIComponent(id)}`, { headers: HEADERS_SUPA });
  const data = await r.json();
  return Array.isArray(data) && data[0] ? data[0] : null;
}

async function loadCatalog() {
  const r = await fetch(`${SUPA_URL}/rest/v1/fr_service_catalog?active=eq.true`, { headers: HEADERS_SUPA });
  const data = await r.json();
  if (!Array.isArray(data)) return {};
  const map = {};
  data.forEach(s => { map[s.service_code] = parseFloat(s.default_rate); });
  return map;
}

function buildRateCard(client, catalogMap) {
  // start from catalog defaults, then apply per-client overrides
  const rates = { ...catalogMap };
  const overrides = client.rate_overrides || {};
  Object.keys(overrides).forEach(code => { rates[code] = parseFloat(overrides[code]); });
  return rates;
}

async function loadServicesLog(clientId, from, to) {
  // Use the pending billing view we built in Services Log Phase 1
  const url = `${SUPA_URL}/rest/v1/fr_services_pending_billing` +
              `?client_id=eq.${encodeURIComponent(clientId)}&period=eq.${from.slice(0,7)}`;
  const r = await fetch(url, { headers: HEADERS_SUPA });
  const data = await r.json();
  return Array.isArray(data) ? data : [];
}

async function loadShipments(clientId, from, to) {
  // Canonical lookup by client_id (FK to fr_clients.id).
  // Real types observed: "Outbound (Drop-Shipment)", "Inbound (Drop-Shipment)",
  // "Inbound (General)", "RMA (Returns)", "Outbound (Shipment)".
  // No quantity column — each row is one shipment, count rows.
  const result = {
    cartonsIn: 0, cartonsOut: 0, palletsIn: 0, palletsOut: 0, total: 0,
    inboundDropship: 0, outboundDropship: 0, returns: 0, inboundGeneral: 0,
  };

  if (!clientId) return result;

  const url = `${SUPA_URL}/rest/v1/shipments_general?` +
              `client_id=eq.${encodeURIComponent(clientId)}&` +
              `created_at=gte.${from}&created_at=lte.${to}T23:59:59&` +
              `select=direction,type,tracking,carrier&limit=5000`;

  const r = await fetch(url, { headers: HEADERS_SUPA });
  const data = await r.json();
  if (!Array.isArray(data)) return result;

  data.forEach(s => {
    const dir  = (s.direction || '').toLowerCase();
    const type = (s.type || '').toLowerCase();

    // Inbound family — receiving (count as cartons, default rate from catalog)
    if (dir === 'inbound') {
      if (type.includes('rma') || type.includes('return')) {
        result.returns += 1;
      } else if (type.includes('drop')) {
        result.inboundDropship += 1;
        result.cartonsIn += 1;
      } else {
        result.inboundGeneral += 1;
        result.cartonsIn += 1;
      }
    }

    // Outbound family — shipping out (count as cartons out)
    if (dir === 'outbound') {
      if (type.includes('drop')) {
        result.outboundDropship += 1;
      }
      result.cartonsOut += 1;
    }

    result.total += 1;
  });

  return result;
}

async function loadShipStation(client, from, to) {
  const result = { orderCount: 0, totalCarrierCost: 0, storesMatched: [] };

  if (!SS_KEY || !SS_SECRET) return result;  // No ShipStation = skip silently

  const auth = Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString('base64');
  const ssHeaders = { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' };

  try {
    let page = 1, totalPages = 1;
    let allShipments = [];
    do {
      const url = `${SS_BASE}/shipments?shipDateStart=${from}&shipDateEnd=${to}&pageSize=500&page=${page}`;
      const r = await fetch(url, { headers: ssHeaders });
      if (!r.ok) break;
      const d = await r.json();
      allShipments = allShipments.concat(d.shipments || []);
      totalPages = d.pages || 1;
      page++;
    } while (page <= totalPages && page <= 5);

    // Match by store_name or store_id from fr_clients
    const sId   = String(client.store_id || '').trim();
    const sName = (client.store_name || client.name || '').toLowerCase().trim();
    const cName = (client.name || '').toLowerCase().trim();
    const cCmp  = (client.company || '').toLowerCase().trim();

    const matched = allShipments.filter(s => {
      const shipStore   = (s.storeName || '').toLowerCase();
      const shipStoreId = String(s.advancedOptions?.storeId || '');
      if (sId   && shipStoreId === sId) return true;
      if (sName && shipStore.includes(sName)) return true;
      if (cName && shipStore.includes(cName)) return true;
      if (cCmp  && shipStore.includes(cCmp))  return true;
      return false;
    });

    result.orderCount = matched.length;
    result.totalCarrierCost = round2(matched.reduce((s, x) => s + (x.shipmentCost || 0), 0));
    result.storesMatched = [...new Set(matched.map(s => s.storeName).filter(Boolean))];
  } catch (e) {
    // Swallow ShipStation errors — show 0 orders, user can adjust manually
  }

  return result;
}

async function checkExistingInvoice(clientId, period) {
  const url = `${SUPA_URL}/rest/v1/fr_invoices?client_id=eq.${encodeURIComponent(clientId)}` +
              `&period=eq.${period}&status=in.(locked,sent,paid)&limit=1`;
  const r = await fetch(url, { headers: HEADERS_SUPA });
  const data = await r.json();
  return Array.isArray(data) && data[0] ? data[0] : null;
}

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════
function resp(statusCode, payload) {
  return { statusCode, headers: HEADERS_RESP, body: JSON.stringify(payload) };
}

function safeJSON(s) {
  try { return JSON.parse(s || "{}"); } catch { return {}; }
}

function round2(n) {
  return Math.round((parseFloat(n) || 0) * 100) / 100;
}
