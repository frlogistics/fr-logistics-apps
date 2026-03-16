// netlify/functions/inventory.js - endpoint discovery v4
const SKUVAULT_BASE = "https://app.skuvault.com/api";
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = { data: null, ts: 0 };

exports.handler = async function (event, context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (cache.data && Date.now() - cache.ts < CACHE_TTL_MS)
    return { statusCode: 200, headers: { ...headers, "X-Cache": "HIT" }, body: JSON.stringify(cache.data) };

  const token = process.env.SKUVAULT_TENANT_TOKEN;
  if (!token) return { statusCode: 500, headers, body: JSON.stringify({ error: "SKUVAULT_TENANT_TOKEN not configured" }) };
  const [tenantToken, userToken] = token.split("|");

  const endpoints = [
    "/inventory/getInventoryByLocation",
    "/inventory/getInventory",
    "/products/getProducts",
    "/inventory/getItemQuantities",
  ];

  const results = {};
  for (const ep of endpoints) {
    try {
      const r = await fetch(SKUVAULT_BASE + ep, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ TenantToken: tenantToken, UserToken: userToken, PageNumber: 0, PageSize: 5 }),
      });
      const txt = await r.text();
      let parsed;
      try { parsed = JSON.parse(txt); } catch(e) { parsed = txt; }
      results[ep] = {
        status: r.status,
        keys: typeof parsed === 'object' && parsed ? Object.keys(parsed) : [],
        sample: typeof parsed === 'object' && parsed ? JSON.stringify(parsed).substring(0, 200) : String(txt).substring(0, 200),
      };
    } catch(e) {
      results[ep] = { error: e.message };
    }
  }

  return { statusCode: 200, headers, body: JSON.stringify(results, null, 2) };
};
