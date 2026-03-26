const { getStore } = require("@netlify/blobs");

const STORE_NAME = "fr-clients-master";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// Normalize client — full schema, backwards compatible with old format
function normalizeClient(c) {
  return {
    id:        c.id        || String(Date.now()) + Math.random().toString(36).slice(2),
    name:      c.name      || "",
    company:   c.company   || "",
    storeName: c.store_name || c.storeName || "",
    storeId:   c.store_id  || c.storeId   || "",
    country:   c.country   || "US",
    lang:      c.lang      || "EN",
    type:      c.type      || "Business",
    // keep both key names for compatibility with portal and Inbound/Outbound
    wa_number: c.wa_number || c.waNumber  || "",
    waNumber:  c.wa_number || c.waNumber  || "",
    email:     c.email     || "",
    phone:     c.phone     || "",
    // services always stored as array
    services: Array.isArray(c.services)
      ? c.services
      : (typeof c.services === "string"
          ? c.services.split(",").map(s => s.trim()).filter(Boolean)
          : []),
    status:     c.status    || (c.active ? "Active" : "Inactive"),
    active:     c.active    !== undefined ? c.active : (c.status === "Active"),
    wa_consent: c.wa_consent || c.waConsent || "Pending",
    waConsent:  c.wa_consent || c.waConsent || "Pending",
    notes:      c.notes     || "",
  };
}

exports.handler = async function(event, context) {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }

  let store;
  try {
    store = getStore(STORE_NAME);
  } catch (e) {
    console.error("getStore error:", e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Store unavailable" }) };
  }

  // ── GET: return all clients ──────────────────────────────────
  if (event.httpMethod === "GET") {
    try {
      const data = await store.get("clients", { type: "json" });
      const clients = Array.isArray(data) ? data.map(normalizeClient) : [];
      return { statusCode: 200, headers: CORS, body: JSON.stringify(clients) };
    } catch (err) {
      console.error("wa-clients GET error:", err);
      return { statusCode: 200, headers: CORS, body: JSON.stringify([]) };
    }
  }

  // ── POST: save_all | upsert | delete ─────────────────────────
  if (event.httpMethod === "POST") {
    try {
      const body = JSON.parse(event.body || "{}");

      // save_all — replace entire array (used by portal Save button)
      if (body.action === "save_all") {
        const clients = Array.isArray(body.clients)
          ? body.clients.map(normalizeClient)
          : [];
        await store.setJSON("clients", clients);
        return {
          statusCode: 200,
          headers: CORS,
          body: JSON.stringify({ ok: true, saved: clients.length }),
        };
      }

      // upsert — add or update a single client
      if (body.action === "upsert" && body.client) {
        const existing = await store.get("clients", { type: "json" }) || [];
        const client = normalizeClient(body.client);
        const idx = existing.findIndex(c => c.id === client.id);
        if (idx >= 0) {
          existing[idx] = client;
        } else {
          existing.push(client);
        }
        await store.setJSON("clients", existing);
        return {
          statusCode: 200,
          headers: CORS,
          body: JSON.stringify({ ok: true, client }),
        };
      }

      // delete — remove single client by id
      if (body.action === "delete" && body.id) {
        const existing = await store.get("clients", { type: "json" }) || [];
        const filtered = existing.filter(c => c.id !== body.id);
        await store.setJSON("clients", filtered);
        return {
          statusCode: 200,
          headers: CORS,
          body: JSON.stringify({ ok: true, remaining: filtered.length }),
        };
      }

      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: "Unknown action" }),
      };

    } catch (err) {
      console.error("wa-clients POST error:", err);
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({ error: "Internal error", detail: String(err) }),
      };
    }
  }

  return {
    statusCode: 405,
    headers: CORS,
    body: JSON.stringify({ error: "Method not allowed" }),
  };
};
