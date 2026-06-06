// ════════════════════════════════════════════════════════════════════════════
// dashboard-kpis.js — FR-Logistics Executive Dashboard KPI API
// Storage: Supabase (KPI views v_kpi_*) + SkuVault API (inventory only)
// Pattern: same as billing-generator.js / services-log.js
//
// Endpoint:
//   GET ?area=<area>
//     area = overview | sla | profitability | operations | inventory | all
//     (default = all)
//
//   Returns: { ok, area, generated_at, data: { ... } }
//
// Each area maps to one or more v_kpi_* views (read-only, security_invoker).
// Inventory is NOT in Supabase — it pulls live from SkuVault, same as the
// client portal Inventory tab. That branch is slower (external API) so the
// dashboard's per-area refresh treats it accordingly.
//
// Designed for the per-area refresh buttons on dashboard v6: each button
// calls this function with its own ?area= so only that panel re-queries,
// independent of any cron routine.
// ════════════════════════════════════════════════════════════════════════════

const SUPA_URL  = process.env.SUPABASE_URL;
const SUPA_KEY  = process.env.SUPABASE_SERVICE_KEY;
// SkuVault: single env var "tenantToken|userToken" (existing FR convention).
// We pull getProducts directly here (not inventory.js) because inventory.js
// groups by warehouse (WH001) and does NOT expose the Client field, so it
// can't drive per-client health. getProducts has Client + IsAlternateSKU.
const SV_TOKENS = process.env.SKUVAULT_TENANT_TOKEN || "";
const [SV_TENANT, SV_USER] = SV_TOKENS.split("|");
const SV_BASE   = "https://app.skuvault.com/api";
// ShipStation (orders shipped) — same creds as portal-tracking.js / daily report
const SS_KEY    = process.env.SS_API_KEY;
const SS_SECRET = process.env.SS_API_SECRET;
const SS_BASE   = "https://ssapi.shipstation.com";

const HEADERS_SUPA = {
  "apikey":        SUPA_KEY,
  "Authorization": "Bearer " + SUPA_KEY,
  "Content-Type":  "application/json",
};

// ── helpers ─────────────────────────────────────────────────────────────────
function resp(code, body) {
  return {
    statusCode: code,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

// Query a single KPI view via PostgREST. Returns array of rows.
async function view(name, opts = {}) {
  let url = `${SUPA_URL}/rest/v1/${name}?select=*`;
  if (opts.order) url += `&order=${opts.order}`;
  if (opts.limit) url += `&limit=${opts.limit}`;
  const r = await fetch(url, { headers: HEADERS_SUPA });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`view ${name} failed (${r.status}): ${txt}`);
  }
  return r.json();
}

// A single-row view returns [{...}]; unwrap to {...} (or {} if empty).
function one(rows) {
  return Array.isArray(rows) && rows.length ? rows[0] : {};
}

// ── area builders ───────────────────────────────────────────────────────────
async function buildOverview() {
  const [overview, pipeline] = await Promise.all([
    view("v_kpi_overview"),
    view("v_kpi_pipeline"),
  ]);
  return {
    ...one(overview),
    pipeline: one(pipeline),
  };
}

async function buildSla() {
  const [sla, byClient, manifests, returns] = await Promise.all([
    view("v_kpi_sla"),
    view("v_kpi_sla_by_client", { order: "volume.desc" }),
    view("v_kpi_manifests", { order: "created_at.desc", limit: 10 }),
    view("v_kpi_returns"),
  ]);
  return {
    summary:   one(sla),
    by_client: byClient,
    manifests: manifests,
    returns:   one(returns),
  };
}

async function buildProfitability() {
  const [prof, byClient] = await Promise.all([
    view("v_kpi_profitability"),
    view("v_kpi_revenue_by_client", { order: "invoiced.desc" }),
  ]);
  return {
    summary:   one(prof),
    by_client: byClient,
  };
}

async function buildOperations() {
  const [ops, io, ioByClient, manifests, ssShipped] = await Promise.all([
    view("v_kpi_operations"),
    view("v_kpi_inbound_outbound"),
    view("v_kpi_io_by_client", { order: "total.desc", limit: 10 }),
    view("v_kpi_manifests", { order: "created_at.desc", limit: 5 }),
    shipStationShipped(),
  ]);
  return {
    status_machine:  one(ops),         // dropshipments status
    inbound_outbound: one(io),         // shipments_general (Inbound/Outbound app)
    io_by_client:    ioByClient,
    manifests:       manifests,
    shipstation:     ssShipped,        // orders shipped via ShipStation
  };
}

// ShipStation: pull BOTH awaiting-shipment orders (actionable backlog) and
// shipped orders in the last 30 days, each grouped by store. Mirrors the
// daily-ops-report.js auth pattern. Wrapped so a ShipStation outage never
// breaks the rest of the Operations panel.
async function shipStationShipped() {
  if (!SS_KEY || !SS_SECRET) return { error: "ShipStation env vars missing", pending_total: 0, pending_by_store: [], total: 0, by_store: [] };
  try {
    const auth = Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString("base64");
    const H = { Authorization: "Basic " + auth };
    const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    // stores (name map) + shipped (last 30d) + awaiting_shipment orders (current backlog)
    const [storesR, shipR, pendR] = await Promise.all([
      fetch(`${SS_BASE}/stores`, { headers: H }),
      fetch(`${SS_BASE}/shipments?shipDateStart=${since}&pageSize=500`, { headers: H }),
      fetch(`${SS_BASE}/orders?orderStatus=awaiting_shipment&pageSize=500`, { headers: H }),
    ]);
    const stores = storesR.ok ? await storesR.json() : [];
    const storeName = {};
    (Array.isArray(stores) ? stores : []).forEach(s => { storeName[s.storeId] = s.storeName; });

    // shipped
    const ship = shipR.ok ? await shipR.json() : { shipments: [] };
    const shipments = (ship.shipments || []).filter(s => !s.voided);
    const byStore = {};
    for (const s of shipments) {
      const nm = storeName[s.advancedOptions?.storeId] || "Unknown store";
      byStore[nm] = (byStore[nm] || 0) + 1;
    }

    // pending (awaiting shipment) — orders carry storeId directly
    const pend = pendR.ok ? await pendR.json() : { orders: [] };
    const orders = pend.orders || [];
    const pendByStore = {};
    for (const o of orders) {
      const nm = storeName[o.advancedOptions?.storeId ?? o.storeId] || "Unknown store";
      pendByStore[nm] = (pendByStore[nm] || 0) + 1;
    }

    return {
      pending_total: orders.length,
      pending_by_store: Object.entries(pendByStore).map(([store, count]) => ({ store, count })).sort((a, b) => b.count - a.count),
      total: shipments.length,
      by_store: Object.entries(byStore).map(([store, count]) => ({ store, count })).sort((a, b) => b.count - a.count),
    };
  } catch (e) {
    return { error: String(e.message || e), pending_total: 0, pending_by_store: [], total: 0, by_store: [] };
  }
}

// Inventory pulled from SkuVault getProducts, filtered IsAlternateSKU !== true
// (memory #25, else stock multi-counts), grouped by the native Client field
// (memory #26, matches fr_clients.name). Health thresholds: out <=0, low <10.
async function buildInventory() {
  if (!SV_TENANT || !SV_USER) {
    return { error: "SkuVault env vars missing", total_skus: 0, by_client: [] };
  }
  const r = await fetch(`${SV_BASE}/products/getProducts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      TenantToken: SV_TENANT,
      UserToken: SV_USER,
      PageNumber: 0,
      PageSize: 10000,
    }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`SkuVault getProducts failed (${r.status}): ${txt}`);
  }
  const payload = await r.json();
  // exclude alternate SKUs so counts match SkuVault UI / CSV
  const products = (payload.Products || []).filter(p => p.IsAlternateSKU !== true);

  let inStock = 0, low = 0, out = 0, totalUnits = 0;
  const byClient = {};
  for (const p of products) {
    const qty = p.QuantityAvailable ?? p.QuantityOnHand ?? 0;
    const client = (p.Client && p.Client.trim()) ? p.Client : "Unassigned";
    if (!byClient[client]) byClient[client] = { client, skus: 0, units: 0, low: 0, out: 0, items: [] };
    byClient[client].skus++;
    byClient[client].units += qty;
    totalUnits += qty;
    let st;
    if (qty <= 0)       { out++;     byClient[client].out++;  st = "out"; }
    else if (qty < 10)  { low++;     byClient[client].low++;  st = "low"; }
    else                { inStock++;                          st = "ok";  }
    // Only list SKUs with stock in the detail view; 0-unit (OOS) SKUs still
    // count in the totals above but are hidden from the dropdown to reduce noise.
    if (qty > 0) {
      byClient[client].items.push({
        sku: p.Sku,
        title: p.Description || p.Title || "",
        units: qty,
        status: st,
      });
    }
  }
  // sort each client's items by units desc (biggest stock first)
  for (const c of Object.values(byClient)) c.items.sort((a, b) => b.units - a.units);
  const total = products.length;
  return {
    total_skus: total,
    total_units: totalUnits,
    in_stock: inStock,
    low_stock: low,
    out_of_stock: out,
    health_pct: total ? Math.round((inStock / total) * 1000) / 10 : 0,
    by_client: Object.values(byClient).sort((a, b) => b.skus - a.skus),
  };
}

// ── handler ─────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return resp(204, {});
  if (!SUPA_URL || !SUPA_KEY) {
    return resp(500, { ok: false, error: "Supabase env vars missing" });
  }

  const area = (event.queryStringParameters || {}).area || "all";
  const generated_at = new Date().toISOString();

  try {
    let data;
    switch (area) {
      case "overview":      data = await buildOverview();      break;
      case "sla":           data = await buildSla();           break;
      case "profitability": data = await buildProfitability(); break;
      case "operations":    data = await buildOperations();    break;
      case "inventory":     data = await buildInventory();     break;
      case "all": {
        // full load — everything except inventory (which is slow/external);
        // inventory loads on demand via its own refresh button
        const [overview, sla, profitability, operations] = await Promise.all([
          buildOverview(),
          buildSla(),
          buildProfitability(),
          buildOperations(),
        ]);
        data = { overview, sla, profitability, operations };
        break;
      }
      default:
        return resp(400, { ok: false, error: `unknown area: ${area}` });
    }
    return resp(200, { ok: true, area, generated_at, data });
  } catch (err) {
    return resp(500, { ok: false, area, error: String(err.message || err) });
  }
};
