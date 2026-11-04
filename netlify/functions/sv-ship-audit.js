// netlify/functions/sv-ship-audit.js — FR-Logistics
// READ-ONLY audit: did the orders shipped in ShipStation actually remove
// quantity in SkuVault?
//
// Why this exists (2026-11-04): FR runs SkuVault in Pick + QC Manual mode, so
// quantity leaves SkuVault at the PICK, not when ShipStation marks the order
// shipped. When an operator ships straight from ShipStation, the sale shows
// "Completed" in SkuVault but On Hand never moves — and nothing on screen
// says so. This function crosses three sources for a date window:
//
//   1. ShipStation /shipments (includeShipmentItems=true) → what physically
//      left, with SKU + qty per shipment.
//   2. SkuVault /sales/getSales → whether SkuVault even knows the order.
//   3. SkuVault /inventory/getTransactions → the Remove transactions that a
//      real pick would have written (this is the ground truth).
//
// It writes NOTHING. GET only.
//
//   GET /.netlify/functions/sv-ship-audit?start=2026-11-02&end=2026-11-04
//   optional: &store=<storeName substring>  (filter ShipStation by store)
//             &raw=1                        (include raw payloads, big)
//
// Env (all already present in Netlify): SS_API_KEY, SS_API_SECRET,
// SKUVAULT_TENANT_TOKEN ("tenant|user" convention) [, SKUVAULT_USER_TOKEN].

const SS = "https://ssapi.shipstation.com";
const SV = "https://app.skuvault.com/api";
const H  = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

function svTokens() {
  const t = String(process.env.SKUVAULT_TENANT_TOKEN || "");
  if (t.includes("|")) { const [TenantToken, UserToken] = t.split("|"); return { TenantToken, UserToken }; }
  return { TenantToken: t, UserToken: String(process.env.SKUVAULT_USER_TOKEN || "") };
}

async function svPost(path, body) {
  const r = await fetch(SV + path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...svTokens(), ...body }),
  });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch { j = { _raw: txt }; }
  if (!r.ok) throw new Error(`SkuVault ${path} → ${r.status}: ${txt.slice(0, 300)}`);
  return j;
}

async function ssGetAll(url, auth, maxPages = 10) {
  const out = []; let page = 1, pages = 1;
  while (page <= pages && page <= maxPages) {
    const r = await fetch(`${url}&page=${page}&pageSize=500`, { headers: auth });
    const txt = await r.text();
    if (!r.ok) throw new Error(`ShipStation ${url.split("?")[0]} → ${r.status}: ${txt.slice(0, 300)}`);
    const j = JSON.parse(txt);
    out.push(...(j.shipments || j.orders || []));
    pages = j.pages || 1; page++;
  }
  return out;
}

// SkuVault caps getTransactions at a 7-day window → walk the range in chunks.
async function svTransactions(start, end) {
  const all = [];
  let from = new Date(start + "T00:00:00Z");
  const to  = new Date(end + "T23:59:59Z");
  while (from <= to) {
    const chunkEnd = new Date(Math.min(from.getTime() + 6 * 86400000 + 86399000, to.getTime()));
    let page = 0;
    for (;;) {
      const j = await svPost("/inventory/getTransactions", {
        FromDate: from.toISOString(), ToDate: chunkEnd.toISOString(),
        PageNumber: page, PageSize: 10000,
      });
      if (page === 0 && !DIAG.tx_keys) DIAG.tx_keys = Object.keys(j);
      const tx = j.Transactions || [];
      all.push(...tx);
      if (tx.length < 10000) break;
      page++;
    }
    from = new Date(chunkEnd.getTime() + 1000);
  }
  return all;
}

async function svSales(start, end) {
  const all = [];
  let page = 0;
  for (;;) {
    // SkuVault filters sales by MODIFIED time (UTC); FromDate/ToDate are
    // silently ignored. Pad the window a day each side so timezone edges
    // don't drop orders.
    const j = await svPost("/sales/getSales", {
      ModifiedAfterDateTimeUtc: new Date(new Date(start + "T00:00:00Z").getTime() - 86400000).toISOString(),
      ModifiedBeforeDateTimeUtc: new Date(new Date(end + "T23:59:59Z").getTime() + 86400000).toISOString(),
      PageNumber: page, PageSize: 10000,
    });
    if (page === 0) DIAG.sales_keys = Object.keys(j);
    const s = j.Sales || [];
    all.push(...s);
    if (s.length < 10000) break;
    page++;
  }
  return all;
}

let DIAG = {};

// Which SKUs does SkuVault actually track? Some clients (e.g. SalesStart)
// don't pay for the platform, so their SKUs never exist in SkuVault and a
// "gap" on them is not a missed pick — it's expected. We resolve this from
// the Supabase mirror (inventory_by_location, rebuilt from SkuVault every
// 2 h) plus wh_sku_clients (SKU ownership). A SKU in neither is untracked.
async function trackedSkuSet() {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  const h = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` };
  const [a, b] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/inventory_by_location?select=sku&limit=20000`, { headers: h }).then((r) => r.json()),
    fetch(`${SUPABASE_URL}/rest/v1/wh_sku_clients?select=sku&limit=20000`, { headers: h }).then((r) => r.json()),
  ]);
  const set = new Set();
  for (const r of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) if (r && r.sku) set.add(norm(r.sku));
  return set;
}

const norm = (s) => String(s || "").trim().toLowerCase();

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };
  const p = event.queryStringParameters || {};
  const start = (p.start || "").trim(), end = (p.end || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end))
    return { statusCode: 400, headers: H, body: JSON.stringify({ error: "start and end required, YYYY-MM-DD" }) };

  const key = process.env.SS_API_KEY, sec = process.env.SS_API_SECRET;
  if (!key || !sec) return { statusCode: 500, headers: H, body: JSON.stringify({ error: "SS credentials missing" }) };
  const auth = { Authorization: `Basic ${Buffer.from(`${key}:${sec}`).toString("base64")}` };

  const errors = {};
  DIAG = {};
  const safe = (name, pr) => pr.catch((e) => { errors[name] = String(e.message || e); return []; });

  const [shipments, sales, tx, tracked] = await Promise.all([
    safe("shipstation", ssGetAll(`${SS}/shipments?shipDateStart=${start}&shipDateEnd=${end}&includeShipmentItems=true`, auth)),
    safe("skuvault_sales", svSales(start, end)),
    safe("skuvault_transactions", svTransactions(start, end)),
    trackedSkuSet().catch((e) => { errors.tracked_skus = String(e.message || e); return null; }),
  ]);

  const storeFilter = norm(p.store);
  const ships = shipments.filter((s) => !s.voided && (!storeFilter || norm(s.storeName).includes(storeFilter)));

  // ── SkuVault sales by order number (OrderId / SaleId / Id) ───────────────
  const saleByOrder = new Map();
  for (const s of sales) {
    for (const k of [s.OrderId, s.SaleId, s.Id]) if (k) saleByOrder.set(norm(k), s);
  }

  // ── Remove transactions per SKU (and per sale context when present) ──────
  const removes = tx.filter((t) => /remove|pick/i.test(String(t.TransactionType || "")) || /remove|pick|sold/i.test(String(t.TransactionReason || "")));
  const removedBySku = {};
  for (const t of removes) {
    const sku = String(t.Sku || "");
    removedBySku[sku] = (removedBySku[sku] || 0) + Math.abs(Number(t.Quantity) || 0);
  }

  // ── Cross ────────────────────────────────────────────────────────────────
  const shippedBySku = {};
  const orders = ships.map((s) => {
    const items = (s.shipmentItems || []).map((i) => ({ sku: i.sku, qty: i.quantity, name: i.name }));
    for (const i of items) shippedBySku[i.sku] = (shippedBySku[i.sku] || 0) + (Number(i.qty) || 0);
    const sale = saleByOrder.get(norm(s.orderNumber));
    return {
      order_number: s.orderNumber, shipment_id: s.shipmentId, ship_date: s.shipDate,
      store: s.storeName || null, tracking: s.trackingNumber, carrier: s.carrierCode,
      items,
      skuvault: sale ? { known: true, status: sale.Status, sale_date: sale.SaleDate, channel: sale.ChannelName, id: sale.Id || sale.SaleId }
                     : { known: false },
    };
  });

  const isTracked = (sku) => (tracked instanceof Set ? tracked.has(norm(sku)) : true);
  const bySkuAll = Object.keys(shippedBySku).sort().map((sku) => ({
    sku,
    tracked_in_skuvault: isTracked(sku),
    shipped_qty: shippedBySku[sku],
    removed_in_skuvault: removedBySku[sku] || 0,
    gap: isTracked(sku) ? shippedBySku[sku] - (removedBySku[sku] || 0) : 0,
  }));
  const bySku = bySkuAll.filter((r) => r.tracked_in_skuvault);
  const notInSkuvault = bySkuAll.filter((r) => !r.tracked_in_skuvault).map((r) => ({ sku: r.sku, shipped_qty: r.shipped_qty }));

  const summary = {
    window: { start, end },
    shipments: ships.length,
    orders_known_to_skuvault: orders.filter((o) => o.skuvault.known).length,
    orders_unknown_to_skuvault: orders.filter((o) => !o.skuvault.known).map((o) => o.order_number),
    units_shipped: bySkuAll.reduce((a, b) => a + b.shipped_qty, 0),
    units_shipped_tracked: bySku.reduce((a, b) => a + b.shipped_qty, 0),
    units_shipped_not_in_skuvault: notInSkuvault.reduce((a, b) => a + b.shipped_qty, 0),
    units_removed_in_skuvault: bySku.reduce((a, b) => a + b.removed_in_skuvault, 0),
    units_gap: bySku.reduce((a, b) => a + b.gap, 0),
    remove_transactions_in_window: removes.length,
    all_transactions_in_window: tx.length,
    errors,
    diag: DIAG,
  };

  const body = { summary, by_sku: bySku, not_in_skuvault: notInSkuvault, orders };
  if (p.raw === "1") body.raw = { sales, transactions: tx };
  return { statusCode: 200, headers: H, body: JSON.stringify(body) };
};
