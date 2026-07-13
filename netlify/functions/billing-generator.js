// ════════════════════════════════════════════════════════════════════════════
// billing-generator.js — FR-Logistics Monthly Invoice Builder
// REFACTORED 2026-05-07 (Phase 3.1) — Now consumes billing-rates API v2
// UPDATED   2026-06-17 — Pick & Pack billed by ShipStation weight tier
//
// Endpoints:
//   GET  ?action=preview&client_id=X&period=YYYY-MM   → preview line items
//   POST ?action=confirm                              → lock invoice
//   GET  ?action=history                              → list past invoices
//   GET  ?action=invoice&id=X                         → fetch one invoice
//   GET  ?action=email-template&id=X                  → branded HTML for Gmail
//
// CHANGES IN THIS VERSION:
//   - SERVICE_CATALOG expanded from 26 → 53 canonical services
//   - service_code values are now CANONICAL (PRP_BOXING vs old BCUIB, etc.)
//     to match fr_service_catalog VIEW and fr_services_log post-migration
//   - buildLineItem reads new billing-rates API format: rateCard[code].rate
//   - Pick & Pack (FUL_PP1) is now billed in 3 weight tiers (Small/Standard/
//     Oversized). billing-shipstation returns per-tier order counts
//     (ppSmall/ppStandard/ppOversized) by classifying each shipment's weight.
//     Each tier reads its rate from rateCard.FUL_PP1.tiers (single source of
//     truth from billing-rates). Tiers with 0 orders are auto-hidden (optional).
//     All three tiers share the canonical service_code FUL_PP1 for billing/
//     traceability but carry distinct qbo_name values so QBO reports split by
//     weight. The additional-item rate (FUL_PPN) stays manual.
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
// SERVICE CATALOG — canonical services
//
// `code` matches the canonical service_code in fr_service_catalog VIEW and
//  fr_services_log entries.
// `qbo_name` is what shows up on the QBO invoice line.
// `source` determines where the quantity comes from:
//   - 'fixed':         quantity = 1 if rate>0, else 0 (e.g. WMS subscription)
//   - 'inbound':       quantity from billing-inbound function (warehouse log)
//   - 'shipstation':   quantity from billing-shipstation function (ShipStation API)
//   - 'services_log':  quantity from fr_services_pending_billing view (warehouse entries)
//   - 'manual':        quantity entered by Jose in billing.html UI
//
// HYBRID AUTO-FILL (2026-07-13): EVERY 'manual' line now also checks the
// Services Log first. If the warehouse logged an entry for that service_code in
// the period (present in fr_services_pending_billing), the line auto-fills its
// quantity + rate from the log and is flagged from_log:true — while remaining
// fully editable in billing.html so Jose can override or add to it. If there is
// no log entry, the line behaves exactly as before (blank, manual entry). This
// makes pallet/carton/B2B lines like INB_PALLET and FUL_OUT_PAL reflect the
// Services Log automatically without losing manual-entry capability for clients
// who don't use the Services Log. No catalog source change required — the
// fallback is applied uniformly to all manual lines in buildLineItem.
//
// `auto_qty` only used when source = 'inbound' or 'shipstation'.
// `ppTier`: when set (small|standard|oversized), buildLineItem pulls the rate
//           from rateCard.FUL_PP1.tiers[ppTier] instead of rateCard[code].rate.
// `optional`: line is hidden when qty=0 AND rate=0 (keeps invoice clean).
// `__shipping_label__` and `__custom__` are special rate sources.
// ════════════════════════════════════════════════════════════════════════════
const SERVICE_CATALOG = [
  // ── FIXED MONTHLY ────────────────────────────────────────────────────────
  { code: 'TEC_WMS',       qbo_name: 'Automated WMS',                              name: 'Automated WMS Fees',                  unit: 'month',          source: 'fixed',       fixed: true },
  { code: 'STO_RACK',      qbo_name: 'Storage Fees Rack Position',                 name: 'Storage — Rack Position',             unit: 'rack',           source: 'fixed',       fixed: true, optional: true },
  { code: 'STO_LBIN',      qbo_name: 'Storage Fees Large Bin',                     name: 'Storage — Large Bin',                 unit: 'bin',            source: 'fixed',       fixed: true, optional: true },
  { code: 'STO_SBIN',      qbo_name: 'Storage Fees Small Bin',                     name: 'Storage — Small Bin',                 unit: 'bin',            source: 'fixed',       fixed: true, optional: true },
  { code: 'STO_LT',        qbo_name: 'Long-Term Storage',                          name: 'Storage — Long-Term (>180d)',         unit: 'rack',           source: 'fixed',       fixed: true, optional: true },

  // ── INBOUND (from warehouse log via billing-inbound) ─────────────────────
  { code: 'INB_CARTON',    qbo_name: 'Inbound Fees Packages',                      name: 'Inbound Receiving — Packages',        unit: 'cartons',        source: 'inbound',     auto_qty: 'count' },
  { code: 'INB_DROP',      qbo_name: 'Inbound-Dropshipment',                       name: 'Inbound Drop-Shipment',               unit: 'pkg',            source: 'inbound',     auto_qty: 'inboundDropshipCount', optional: true },
  { code: 'INB_PALLET',    qbo_name: 'Inbound Fees Pallets',                       name: 'Inbound — Pallets',                   unit: 'pallet',         source: 'manual',      optional: true },
  { code: 'INB_FLOOR',     qbo_name: 'Inbound Floor-Load',                         name: 'Inbound — Pallet Floor-Load',         unit: 'pallet',         source: 'manual',      optional: true },
  { code: 'INB_ECO',       qbo_name: 'In&Out-Eco',                                 name: 'Inbound — EcoPack+',                  unit: 'pkg',            source: 'manual',      optional: true },
  { code: 'INB_XDOCK_PKG', qbo_name: 'CD-Inbound-Pkg',                             name: 'Cross-Docking (package)',             unit: 'pkg',            source: 'manual',      optional: true },
  { code: 'INB_XDOCK_PAL', qbo_name: 'CD-Inbound-Pal',                             name: 'Cross-Docking (pallet)',              unit: 'pallet',         source: 'manual',      optional: true },

  // ── FULFILLMENT / OUTBOUND ────────────────────────────────────────────────
  // Pick & Pack — 1st Item, split into 3 weight tiers. All share code FUL_PP1
  // (canonical) but each pulls its rate from rateCard.FUL_PP1.tiers[ppTier] and
  // its quantity from the ShipStation per-tier order count. optional:true hides
  // any tier with 0 orders so the invoice stays clean.
  { code: 'FUL_PP1', ppTier: 'small',     qbo_name: 'Fulfillment Pick & Pack — Small',     name: 'Pick & Pack — Small (≤1.5 lb)',      unit: 'order', source: 'shipstation', auto_qty: 'ppSmall',     optional: true },
  { code: 'FUL_PP1', ppTier: 'standard',  qbo_name: 'Fulfillment Pick & Pack — Standard',  name: 'Pick & Pack — Standard (1.5–3 lb)',  unit: 'order', source: 'shipstation', auto_qty: 'ppStandard',  optional: true },
  { code: 'FUL_PP1', ppTier: 'oversized', qbo_name: 'Fulfillment Pick & Pack — Oversized', name: 'Pick & Pack — Oversized (>3 lb)',    unit: 'order', source: 'shipstation', auto_qty: 'ppOversized', optional: true },
  { code: 'FUL_PPN',       qbo_name: 'Pick & Pack Additional Item',                name: 'Pick & Pack — Additional Item',       unit: 'item',           source: 'manual',      optional: true },
  { code: 'FUL_LABEL_MARKUP', qbo_name: 'Shipping Label Fee',                      name: 'Shipping Label Fee (cost + markup)',  unit: 'period',         source: 'shipstation', auto_qty: 'shippingLabel', specialRate: '__shipping_label__' },
  { code: 'FUL_OUT_CART',  qbo_name: 'Outbound Fees Package',                      name: 'Outbound Fees — Package',             unit: 'pkg',            source: 'inbound',     auto_qty: 'outboundCount' },
  { code: 'FUL_OUT_DROP',  qbo_name: 'Drop-Shipment Service',                      name: 'Outbound Drop-Shipment',              unit: 'pkg',            source: 'inbound',     auto_qty: 'outboundDropshipCount' },
  { code: 'FUL_OUT_PAL',   qbo_name: 'Outbound Fees Pallets',                      name: 'Outbound — Pallets',                  unit: 'pallet',         source: 'manual',      optional: true },
  { code: 'FUL_OUT_OVS',   qbo_name: 'Outbound Oversized',                         name: 'Outbound — Oversized Pallet',         unit: 'pallet',         source: 'manual',      optional: true },
  { code: 'FUL_PICKUP',    qbo_name: 'Carrier-Pickup',                             name: 'Carrier Pickup Coordination',         unit: 'pickup',         source: 'services_log', optional: true },
  { code: 'FUL_LABEL_APP', qbo_name: 'Shipping-Label-App',                         name: 'Shipping Label Application',          unit: 'label',          source: 'manual',      optional: true },
  { code: 'FUL_CONSOL',    qbo_name: 'Order-Consol',                               name: 'Order Consolidation',                 unit: 'order',          source: 'manual',      optional: true },
  { code: 'FUL_RUSH',      qbo_name: 'Rush-Surcharge',                             name: 'Same-Day Rush Surcharge',             unit: 'order',          source: 'manual',      optional: true },
  { code: 'FUL_HEAVY',     qbo_name: 'Heavy-Surcharge',                            name: 'Heavy Order Surcharge',               unit: 'order',          source: 'manual',      optional: true },
  { code: 'FUL_BOX_UP',    qbo_name: 'Box-Upgrade',                                name: 'Box Upgrade / Double-Boxing',         unit: 'order',          source: 'manual',      optional: true },
  { code: 'FUL_ADDR_FIX',  qbo_name: 'Address-Correction',                         name: 'Address Correction (post-label)',     unit: 'occurrence',     source: 'services_log', optional: true },

  // ── PREP / VALUE-ADDED (from services_log) ───────────────────────────────
  { code: 'PRP_FNSKU',     qbo_name: 'FNSKU Label',                                name: 'FNSKU Labeling',                      unit: 'unit',           source: 'services_log' },
  { code: 'PRP_POLY',      qbo_name: 'Poly Bag',                                   name: 'Poly Bagging',                        unit: 'unit',           source: 'services_log' },
  { code: 'PRP_BUBBLE',    qbo_name: 'Bubble Wrap',                                name: 'Bubble Wrap Protection',              unit: 'unit',           source: 'services_log', optional: true },
  { code: 'PRP_BOXING',    qbo_name: 'Boxing-Collating',                           name: 'Boxing / Collating Units',            unit: 'unit',           source: 'services_log' },
  { code: 'PRP_KIT',       qbo_name: 'Kitting & Bundling',                         name: 'Kitting & Bundling',                  unit: 'unit',           source: 'services_log' },
  { code: 'PRP_BUNDLE',    qbo_name: 'Bundle Creation',                            name: 'Complex Bundle Creation',             unit: 'bundle',         source: 'services_log', optional: true },
  { code: 'PRP_SORT_UNIT', qbo_name: 'Sorting-Unit',                               name: 'Sorting (per unit)',                  unit: 'unit',           source: 'services_log', optional: true },
  { code: 'PRP_SORT_BOX',  qbo_name: 'Sorting-Box',                                name: 'Categorizing (per box)',              unit: 'box',            source: 'services_log', optional: true },
  { code: 'PRP_ROL',       qbo_name: 'Label Removal',                              name: 'Removal of Old Labels',               unit: 'unit',           source: 'services_log', optional: true },
  { code: 'PRP_PALLETIZE', qbo_name: 'Palletizing',                                name: 'Palletizing Labor',                   unit: 'pallet',         source: 'services_log', optional: true },
  { code: 'PRP_STRETCH',   qbo_name: 'Stretch Wrap',                               name: 'Stretch Wrapping',                    unit: 'pallet',         source: 'services_log', optional: true },
  { code: 'PRP_PALREPACK', qbo_name: 'Pallet Repack',                              name: 'Pallet Repack',                       unit: 'pallet',         source: 'services_log', optional: true },
  { code: 'PRP_HANGTAG',   qbo_name: 'Hang Tag',                                   name: 'Hang Tag / Branded Insert',           unit: 'unit',           source: 'services_log', optional: true },
  { code: 'PRP_INSERT',    qbo_name: 'Marketing Insert',                           name: 'Marketing Material Insert',           unit: 'insert',         source: 'services_log', optional: true },

  // ── QC / INSPECTION (from services_log) ──────────────────────────────────
  { code: 'QC_HOUR',       qbo_name: 'PIF',                                        name: 'Product Inspection (QC)',             unit: 'hour',           source: 'services_log' },
  { code: 'QC_PHOTO',      qbo_name: 'QC-Photo',                                   name: 'QC Photo Verification',               unit: 'unit',           source: 'services_log', optional: true },
  { code: 'QC_SAMPLE',     qbo_name: 'SKU-Intake',                                 name: 'Sample Intake / New SKU',             unit: 'SKU',            source: 'services_log', optional: true },

  // ── RETURNS ──────────────────────────────────────────────────────────────
  { code: 'RET_PROC',      qbo_name: 'RPF',                                        name: 'Return Processing',                   unit: 'unit',           source: 'inbound',     auto_qty: 'rmaCount' },
  { code: 'RET_REFURB',    qbo_name: 'R&R',                                        name: 'Return — Refurb / Recover',           unit: 'unit',           source: 'services_log', optional: true },
  { code: 'RET_DISPOSE',   qbo_name: 'Disposal',                                   name: 'Return — Disposal',                   unit: 'unit',           source: 'services_log', optional: true },
  { code: 'RET_REMOVAL',   qbo_name: 'Removal-Order',                              name: 'FBA Removal Order Processing',        unit: 'unit',           source: 'services_log', optional: true },

  // ── B2B / WHOLESALE ──────────────────────────────────────────────────────
  { code: 'B2B_CART',      qbo_name: 'B2B-Master-Carton',                          name: 'B2B Master Carton Pick',              unit: 'carton',         source: 'manual',      optional: true },
  { code: 'B2B_PALLET',    qbo_name: 'B2B-Pallet-Build',                           name: 'B2B Pallet Build & Wrap',             unit: 'pallet',         source: 'manual',      optional: true },
  { code: 'B2B_RETAIL',    qbo_name: 'Retail-Dist',                                name: 'Retail Distribution',                 unit: 'order',          source: 'manual',      optional: true },

  // ── TECHNOLOGY / ONE-TIME ────────────────────────────────────────────────
  { code: 'TEC_INTEG',     qbo_name: 'Integration-Setup',                          name: 'Marketplace Integration (one-time)',  unit: 'one-time',       source: 'manual',      optional: true },
  { code: 'TEC_SETUP',     qbo_name: 'Setup-Fee',                                  name: 'Account Setup / Onboarding',          unit: 'one-time',       source: 'manual',      optional: true },
  { code: 'TEC_AMZ_PLAN',  qbo_name: 'AMZ-Shipment-Plan',                          name: 'Amazon Shipment Plan Creation',       unit: 'plan',           source: 'services_log', optional: true },
  { code: 'TEC_CUSTOM',    qbo_name: 'Custom Project',                             name: 'Custom Project',                      unit: 'project',        source: 'services_log', optional: true, specialRate: '__custom__' },

  // ── SPECIAL ──────────────────────────────────────────────────────────────
  { code: 'SPC_SKU_SUR',   qbo_name: 'SKU-Surcharge',                              name: 'SKU Surcharge (>20 SKUs)',            unit: 'SKU added',      source: 'manual',      optional: true },
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
    // Pick & Pack weight-tier counts (default 0 when ShipStation skipped/portal)
    ppSmall:               ssData.ppSmall || 0,
    ppStandard:            ssData.ppStandard || 0,
    ppOversized:           ssData.ppOversized || 0,
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

// ────────────────────────────────────────────────────────────────────────────
// buildLineItem — reads billing-rates API v2
//
// Standard:    rateCard.QC_HOUR.rate            → 45.00
// Pick & Pack: rateCard.FUL_PP1.tiers[ppTier]   → 3.00 / 4.00 / 5.00 by weight
// ────────────────────────────────────────────────────────────────────────────
function buildLineItem(svc, rateCard, sources, servicesByCode, client) {
  let rate = 0;

  // Special rate sources (computed, not from rateCard)
  if (svc.specialRate === '__shipping_label__') {
    const pct = parseFloat(client.shipping_markup) || 10;
    rate = round2(sources.carrierCost * (1 + pct / 100));
  } else if (svc.specialRate === '__custom__') {
    rate = 0;  // user enters in billing.html UI
  } else if (svc.ppTier) {
    // Pick & Pack weight tier: read from rateCard.FUL_PP1.tiers[tier].
    // Falls back to the flat FUL_PP1.rate, then 0, if tiers are unavailable
    // (e.g. API not yet redeployed) — never crashes the preview.
    const entry = rateCard.FUL_PP1;
    const tiers = entry && entry.tiers ? entry.tiers : null;
    if (tiers && tiers[svc.ppTier] != null) {
      rate = parseFloat(tiers[svc.ppTier]);
    } else {
      rate = entry && entry.rate != null ? parseFloat(entry.rate) : 0;
    }
  } else {
    // Read rate from billing-rates API v2 response: rateCard[code].rate
    const entry = rateCard[svc.code];
    rate = entry && entry.rate != null ? parseFloat(entry.rate) : 0;
  }

  let quantity = 0, detail = '', hasMovement = false;

  if (svc.fixed) {
    if (svc.code === 'TEC_WMS') {
      quantity = rate > 0 ? 1 : 0;
    } else {
      quantity = 0; // Storage stays 0 until SKUVault hookup or manual entry
    }
    detail = quantity > 0 ? `Monthly subscription` : '';
    hasMovement = quantity > 0;
  }
  else if (svc.source === 'shipstation') {
    if (svc.specialRate === '__shipping_label__') {
      quantity = sources.shippingLabel;
      detail = sources.carrierCost > 0
        ? `Carrier cost $${sources.carrierCost.toFixed(2)} × ${(1 + (parseFloat(client.shipping_markup) || 10) / 100).toFixed(2)} markup`
        : '';
      hasMovement = quantity > 0;
    } else {
      quantity = sources[svc.auto_qty] || 0;
      // Tier lines describe the weight band; others keep the generic wording.
      if (svc.ppTier) {
        detail = quantity > 0 ? `${quantity} orders @ ${svc.ppTier} weight tier` : '';
      } else {
        detail = quantity > 0 ? `${quantity} ${svc.unit}s shipped (store)` : '';
      }
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
      // services_log entries snapshot the rate at log-time — prefer that over current rate
      if (sl.avg_unit_rate && parseFloat(sl.avg_unit_rate) > 0) rate = parseFloat(sl.avg_unit_rate);
      detail = `${sl.entry_count || 1} ${(sl.entry_count || 1) === 1 ? 'entry' : 'entries'} logged`;
    }
    hasMovement = quantity > 0;
  }
  // 'manual' source: HYBRID auto-fill. Check the Services Log first — if the
  // warehouse logged this service_code in the period, auto-fill qty + rate from
  // the log (from_log:true) while keeping the line editable in billing.html.
  // If no log entry exists, the line stays blank for manual entry as before.

  let fromLog = false;

  if (svc.source === 'manual') {
    const sl = servicesByCode[svc.code];
    if (sl && (parseFloat(sl.total_quantity) || 0) > 0) {
      quantity = parseFloat(sl.total_quantity) || 0;
      // Snapshot the rate logged at service-time; fall back to current rate card
      if (sl.avg_unit_rate && parseFloat(sl.avg_unit_rate) > 0) rate = parseFloat(sl.avg_unit_rate);
      detail = `${sl.entry_count || 1} ${(sl.entry_count || 1) === 1 ? 'entry' : 'entries'} logged`;
      hasMovement = true;
      fromLog = true;
    }
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
    pp_tier:       svc.ppTier || null,
    from_log:      fromLog,
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
  const empty = { mode: 'skipped', count: 0, carrierCost: 0, storeMatched: false, storeNames: [], ppSmall: 0, ppStandard: 0, ppOversized: 0 };
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
