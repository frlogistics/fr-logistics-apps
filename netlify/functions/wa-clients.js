// wa-clients.js — FR-Logistics Master Client Table
// Storage: Supabase (same DB as shipments_general — already proven working)

const SUPA_URL = "https://rijbschnchjiuggrhfrx.supabase.co";
const SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJpamJzY2huY2hqaXVnZ3JoZnJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzMTQwOTQsImV4cCI6MjA4ODg5MDA5NH0.s3T4CStjWqOvz7qDpYtjt0yVJ0iyOMAKKwxkADSEs4s";
const TABLE   = "fr_clients";

const HEADERS_SUPA = {
  "apikey":        SUPA_KEY,
  "Authorization": "Bearer " + SUPA_KEY,
  "Content-Type":  "application/json",
  "Prefer":        "return=representation",
};

const HEADERS_RESP = { "Content-Type": "application/json" };

// Normalize services: always string for Supabase TEXT column, parsed to array for API response
function toServicesString(services) {
  if (Array.isArray(services)) return services.join(",");
  if (typeof services === "string") return services;
  return "";
}

function toServicesArray(str) {
  if (Array.isArray(str)) return str;
  if (typeof str === "string" && str.length > 0)
    return str.split(",").map(s => s.trim()).filter(Boolean);
  return [];
}

// Map Supabase row → API client object
function rowToClient(r) {
  const waNumber  = r.wa_number  || "";
  const waConsent = r.wa_consent || "Pending";
  const status    = r.status     || "Active";
  return {
    id:        r.id,
    name:      r.name      || "",
    company:   r.company   || "",
    storeName: r.store_name || "",
    storeId:   r.store_id   || "",
    country:   r.country   || "US",
    lang:      r.lang      || "EN",
    type:      r.type      || "Business",
    wa_number: waNumber,
    waNumber,
    email:     r.email     || "",
    phone:     r.phone     || "",
    services:  toServicesArray(r.services),
    status,
    active:    status === "Active",
    wa_consent: waConsent,
    waConsent,
    notes:     r.notes     || "",
  };
}

// Map portal client object → Supabase row
function clientToRow(c) {
  return {
    id:         c.id        || undefined,
    name:       c.name      || "",
    company:    c.company   || "",
    store_name: c.store_name || c.storeName || "",
    store_id:   c.store_id  || c.storeId   || "",
    country:    c.country   || "US",
    lang:       c.lang      || "EN",
    type:       c.type      || "Business",
    wa_number:  c.wa_number  || c.waNumber  || "",
    email:      c.email     || "",
    phone:      c.phone     || "",
    services:   toServicesString(c.services),
    status:     c.status    || (c.active ? "Active" : "Inactive"),
    active:     c.active    !== undefined ? c.active : (c.status === "Active"),
    wa_consent: c.wa_consent || c.waConsent || "Pending",
    notes:      c.notes     || "",
  };
}

async function sbFetch(method, path, body) {
  const res = await fetch(SUPA_URL + path, {
    method,
    headers: HEADERS_SUPA,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : [];
}

exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: HEADERS_RESP, body: "" };
  }

  // ── GET: all clients ──────────────────────────────────────────────────────
  if (event.httpMethod === "GET") {
    try {
      const rows = await sbFetch("GET", `/rest/v1/${TABLE}?order=name.asc&limit=500`);
      const clients = (rows || []).map(rowToClient);
      console.log(`[wa-clients] GET → ${clients.length} clients`);
      return { statusCode: 200, headers: HEADERS_RESP, body: JSON.stringify(clients) };
    } catch (err) {
      console.error("[wa-clients] GET error:", err.message);
      return { statusCode: 200, headers: HEADERS_RESP, body: JSON.stringify([]) };
    }
  }

  // ── POST ──────────────────────────────────────────────────────────────────
  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return { statusCode: 400, headers: HEADERS_RESP, body: JSON.stringify({ error: "Invalid JSON" }) }; }

    // save_all — upsert every client from portal
    if (body.action === "save_all" && Array.isArray(body.clients)) {
      try {
        // Delete all existing rows then insert fresh (simplest approach for ≤50 clients)
        await sbFetch("DELETE", `/rest/v1/${TABLE}?id=neq.00000000-0000-0000-0000-000000000000`);
        if (body.clients.length > 0) {
          const rows = body.clients.map(c => {
            const r = clientToRow(c);
            delete r.id; // let Supabase generate UUIDs
            return r;
          });
          await sbFetch("POST", `/rest/v1/${TABLE}`, rows);
        }
        console.log(`[wa-clients] save_all → ${body.clients.length} clients`);
        return { statusCode: 200, headers: HEADERS_RESP, body: JSON.stringify({ ok: true, saved: body.clients.length }) };
      } catch (err) {
        console.error("[wa-clients] save_all error:", err.message);
        return { statusCode: 500, headers: HEADERS_RESP, body: JSON.stringify({ error: err.message }) };
      }
    }

    // upsert — single client (insert or update by id)
    if (body.action === "upsert" && body.client) {
      try {
        const row = clientToRow(body.client);
        const result = await sbFetch("POST", `/rest/v1/${TABLE}?on_conflict=id`, row);
        return { statusCode: 200, headers: HEADERS_RESP, body: JSON.stringify({ ok: true, client: rowToClient(result[0] || row) }) };
      } catch (err) {
        console.error("[wa-clients] upsert error:", err.message);
        return { statusCode: 500, headers: HEADERS_RESP, body: JSON.stringify({ error: err.message }) };
      }
    }

    // delete — by id
    if (body.action === "delete" && body.id) {
      try {
        await sbFetch("DELETE", `/rest/v1/${TABLE}?id=eq.${encodeURIComponent(body.id)}`);
        return { statusCode: 200, headers: HEADERS_RESP, body: JSON.stringify({ ok: true }) };
      } catch (err) {
        console.error("[wa-clients] delete error:", err.message);
        return { statusCode: 500, headers: HEADERS_RESP, body: JSON.stringify({ error: err.message }) };
      }
    }

    return { statusCode: 400, headers: HEADERS_RESP, body: JSON.stringify({ error: "Unknown action" }) };
  }

  return { statusCode: 405, headers: HEADERS_RESP, body: JSON.stringify({ error: "Method not allowed" }) };
};
