// netlify/functions/inventory.js - DEBUG v3
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

  const token = process.env.SKUVAULT_TENANT_TOKEN;
  if (!token) return { statusCode: 500, headers, body: JSON.stringify({ error: "SKUVAULT_TENANT_TOKEN not configured" }) };
  const [tenantToken, userToken] = token.split("|");

  try {
    const invRes = await fetch(SKUVAULT_BASE + "/inventory/getInventory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ TenantToken: tenantToken, UserToken: userToken, PageNumber: 0, PageSize: 10 }),
    });

    const rawText = await invRes.text();
    let parsed;
    try { parsed = JSON.parse(rawText); } catch(e) { parsed = rawText; }

    const keys = typeof parsed === 'object' && parsed !== null ? Object.keys(parsed) : [];
    const sample = typeof parsed === 'object' && parsed !== null
      ? JSON.stringify(parsed).substring(0, 500)
      : String(rawText).substring(0, 500);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status: invRes.status,
        keys,
        sample,
        isArray: Array.isArray(parsed),
        type: typeof parsed,
      })
    };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: err.message }) };
  }
};
