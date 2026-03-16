// netlify/functions/inventory.js - FR-Logistics Miami v5 FINAL
// Uses getItemQuantities (quantities) + getProducts (descriptions) + getInventoryByLocation (locations)
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
    const [qtyRes, prodRes, locRes] = await Promise.all([
      fetch(SKUVAULT_BASE + "/inventory/getItemQuantities", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ TenantToken: tenantToken, UserToken: userToken, PageNumber: 0, PageSize: 10000 }),
      }),
      fetch(SKUVAULT_BASE + "/products/getProducts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ TenantToken: tenantToken, UserToken: userToken, PageNumber: 0, PageSize: 10000 }),
      }),
      fetch(SKUVAULT_BASE + "/inventory/getInventoryByLocation", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ TenantToken: tenantToken, UserToken: userToken, PageNumber: 0, PageSize: 10000 }),
      }),
    ]);

    if (!qtyRes.ok) throw new Error("getItemQuantities error: " + qtyRes.status);

    const qtyData = await qtyRes.json();
    const prodData = prodRes.ok ? await prodRes.json() : { Products: [] };
    const locData = locRes.ok ? await locRes.json() : { Items: {} };

    // Build description map from products
    const descMap = {};
    for (const p of (prodData.Products || [])) {
      descMap[p.Sku] = p.Description || p.ShortDescription || p.Sku;
    }

    // Build location map from getInventoryByLocation
    // Items is an object: { "SKU_CODE": [{WarehouseCode, LocationCode, Quantity}] }
    const locMap = {};
    const locItems = locData.Items || {};
    for (const [skuCode, locs] of Object.entries(locItems)) {
      if (Array.isArray(locs)) {
        locMap[skuCode] = [...new Set(locs.map(l => l.WarehouseCode).filter(Boolean))];
      }
    }

    // Build SKU list from quantities
    const items = qtyData.Items || [];
    const skus = items.map(item => {
      const onHand = item.TotalOnHand || 0;
      const allocated = item.HeldQuantity || item.PickedQuantity || 0;
      const available = item.AvailableQuantity != null ? item.AvailableQuantity : (onHand - allocated);
      const locations = locMap[item.Code] || locMap[item.Sku] || [];

      return {
        sku: item.Sku || '',
        title: descMap[item.Sku] || item.Sku || '',
        onHand,
        allocated,
        available,
        status: available <= 0 ? "out" : available < 10 ? "low" : "ok",
        locations,
      };
    }).filter(s => s.sku && s.onHand > 0).sort((a, b) => b.onHand - a.onHand);

    const total = skus.reduce((s, x) => s + x.onHand, 0);
    const out = skus.filter(s => s.status === "out").length;
    const low = skus.filter(s => s.status === "low").length;
    const fba = skus.reduce((s, x) => s + (x.locations.some(l => /FBA|AMAZON/i.test(l)) ? x.onHand : 0), 0);
    const fbm = skus.reduce((s, x) => s + (x.locations.some(l => /FBM/i.test(l)) ? x.onHand : 0), 0);

    const payload = {
      lastSync: new Date().toISOString(),
      kpis: { totalUnits: total, totalSKUs: skus.length, outOfStock: out, lowStock: low, reorderAlerts: out + low },
      channels: { fba, fbm, shopify: Math.max(0, total - fba - fbm), total },
      skus: skus.slice(0, 50),
      warehouses: [],
    };

    cache = { data: payload, ts: Date.now() };
    return { statusCode: 200, headers: { ...headers, "X-Cache": "MISS" }, body: JSON.stringify(payload) };

  } catch (err) {
    if (cache.data) return { statusCode: 200, headers: { ...headers, "X-Cache": "STALE" }, body: JSON.stringify({ ...cache.data, stale: true }) };
    return { statusCode: 502, headers, body: JSON.stringify({ error: "Failed to fetch inventory", detail: err.message }) };
  }
};
