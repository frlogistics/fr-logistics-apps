// netlify/functions/inventory.js
// FR-Logistics Miami - SKUVault Inventory Proxy
// Env var: SKUVAULT_TENANT_TOKEN (format: tenantToken|userToken)

const SKUVAULT_BASE = "https://app.skuvault.com/api";
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = { data: null, ts: 0 };

exports.handler = async function (event, context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (cache.data && Date.now() - cache.ts < CACHE_TTL_MS)
    return { statusCode: 200, headers: { ...headers, "X-Cache": "HIT" }, body: JSON.stringify(cache.data) };

  const token = process.env.SKUVAULT_TENANT_TOKEN;
  if (!token) return { statusCode: 500, headers, body: JSON.stringify({ error: "SKUVAULT_TENANT_TOKEN not configured" }) };
  const [tenantToken, userToken] = token.split("|");

  try {
    const [invRes, whRes] = await Promise.all([
      fetch(SKUVAULT_BASE + "/inventory/getInventoryByLocation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ TenantToken: tenantToken, UserToken: userToken, PageNumber: 0, PageSize: 10000 }),
      }),
      fetch(SKUVAULT_BASE + "/inventory/getWarehouses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ TenantToken: tenantToken, UserToken: userToken }),
      }),
    ]);
    if (!invRes.ok) throw new Error("SKUVault API error: " + invRes.status);

    const invData = await invRes.json();
    const whData = whRes.ok ? await whRes.json() : { Warehouses: [] };
    const skuMap = {};
    for (const item of (invData.Items || [])) {
      if (!skuMap[item.Sku]) skuMap[item.Sku] = { sku: item.Sku, title: item.Description || item.Sku, onHand: 0, allocated: 0, locations: [] };
      skuMap[item.Sku].onHand += item.Quantity || 0;
      skuMap[item.Sku].allocated += item.AllocatedQuantity || 0;
      if (item.LocationCode) skuMap[item.Sku].locations.push(item.LocationCode);
    }

    const skus = Object.values(skuMap).map(s => {
      s.available = s.onHand - s.allocated;
      s.status = s.available <= 0 ? "out" : s.available < 20 ? "low" : "ok";
      s.locations = [...new Set(s.locations)];
      return s;
    }).sort((a, b) => b.onHand - a.onHand);

    const total = skus.reduce((s, x) => s + x.onHand, 0);
    const out = skus.filter(s => s.status === "out").length;
    const low = skus.filter(s => s.status === "low").length;
    const fba = skus.reduce((s, x) => s + (x.locations.some(l => /^FBA/i.test(l)) ? x.onHand : 0), 0);
    const fbm = skus.reduce((s, x) => s + (x.locations.some(l => /^FBM/i.test(l)) ? x.onHand : 0), 0);

    const payload = {
      lastSync: new Date().toISOString(),
      kpis: { totalUnits: total, totalSKUs: skus.length, outOfStock: out, lowStock: low, reorderAlerts: out + low },
      channels: { fba, fbm, shopify: Math.max(0, total - fba - fbm), total },
      skus: skus.slice(0, 50),
      warehouses: (whData.Warehouses || []).map(w => ({ id: w.Id, name: w.Name, code: w.Code })),
    };
    cache = { data: payload, ts: Date.now() };
    return { statusCode: 200, headers: { ...headers, "X-Cache": "MISS" }, body: JSON.stringify(payload) };

  } catch (err) {
    if (cache.data) return { statusCode: 200, headers: { ...headers, "X-Cache": "STALE" }, body: JSON.stringify({ ...cache.data, stale: true }) };
    return { statusCode: 502, headers, body: JSON.stringify({ error: "Failed to fetch inventory", detail: err.message }) };
  }
};
