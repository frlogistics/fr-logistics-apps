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
// Inventory is NOT pulled here. We reuse the existing inventory.js function
// (fr-logistics-apps) which already pulls SkuVault with caching, the
// IsAlternateSKU !== true filter, and per-client grouping. DRY: one source.
const SELF_BASE = process.env.URL || "https://apps.fr-logistics.net";

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
  const [ops, manifests] = await Promise.all([
    view("v_kpi_operations"),
    view("v_kpi_manifests", { order: "created_at.desc", limit: 5 }),
  ]);
  return {
    status_machine: one(ops),
    manifests:      manifests,
  };
}

// Inventory comes from the existing inventory.js function, which already
// handles SkuVault auth, 5-min cache, the IsAlternateSKU !== true filter
// (memory #25), and per-client grouping (memory #26). We just call it and
// reshape its output into the dashboard's health KPIs. This keeps a single
// source of truth for inventory logic instead of duplicating the SkuVault pull.
async function buildInventory() {
  const r = await fetch(`${SELF_BASE}/.netlify/functions/inventory`);
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`inventory.js call failed (${r.status}): ${txt}`);
  }
  const inv = await r.json();
  // inventory.js returns an array of SKU rows (sku, title, onHand, allocated,
  // available, status, client). Reshape into KPIs + per-client breakdown.
  const skus = Array.isArray(inv) ? inv : (inv.skus || inv.items || []);

  let inStock = 0, low = 0, out = 0;
  const byClient = {};
  for (const s of skus) {
    const status = s.status || (
      (s.available ?? s.onHand ?? 0) <= 0 ? "out"
      : (s.available ?? s.onHand ?? 0) < 10 ? "low" : "ok"
    );
    const client = s.client || s.Client || "Unassigned";
    if (!byClient[client]) byClient[client] = { client, skus: 0, low: 0, out: 0 };
    byClient[client].skus++;
    if (status === "out")      { out++;     byClient[client].out++; }
    else if (status === "low") { low++;     byClient[client].low++; }
    else                       { inStock++; }
  }
  const total = skus.length;
  return {
    total_skus: total,
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
