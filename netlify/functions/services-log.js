// ════════════════════════════════════════════════════════════════════════════
// services-log.js — FR-Logistics Services Rendered Log API
// Storage: Supabase (fr_services_log + fr_service_catalog)
// Pattern: same as wa-clients.js / ecopack.js (HEADERS_SUPA, normalizers, status codes)
// Endpoints:
//   GET    ?catalog=true                          → list active service catalog
//   GET    ?client_id=&from=&to=&status=&limit=   → list log entries (filters optional)
//   POST   { client_id, client_name, service_code, service_name,
//            quantity, unit, unit_rate, service_date?, reference_id?,
//            performed_by?, notes?, logged_by? }   → create entry
//   PATCH  { id, ...fields }                      → update entry (locked once billed)
//   DELETE ?id=                                   → soft delete (status='voided')
// ════════════════════════════════════════════════════════════════════════════

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const TABLE_LOG = "fr_services_log";
const TABLE_CAT = "fr_service_catalog";

const HEADERS_SUPA = {
  "apikey":        SUPA_KEY,
  "Authorization": "Bearer " + SUPA_KEY,
  "Content-Type":  "application/json",
  "Prefer":        "return=representation",
};

const HEADERS_RESP = { "Content-Type": "application/json" };

// ── normalizers ────────────────────────────────────────────────────────────
function rowToEntry(r) {
  return {
    id:             r.id,
    client_id:      r.client_id      || "",
    client_name:    r.client_name    || "",
    service_code:   r.service_code   || "",
    service_name:   r.service_name   || "",
    quantity:       parseFloat(r.quantity || 0),
    unit:           r.unit           || "",
    unit_rate:      parseFloat(r.unit_rate || 0),
    line_total:     parseFloat(r.line_total || 0),
    service_date:   r.service_date,
    reference_id:   r.reference_id   || "",
    performed_by:   r.performed_by   || "",
    notes:          r.notes          || "",
    status:         r.status         || "logged",
    invoice_period: r.invoice_period || "",
    invoice_id:     r.invoice_id     || "",
    logged_by:      r.logged_by      || "",
    created_at:     r.created_at,
    updated_at:     r.updated_at,
  };
}

function entryToRow(e) {
  return {
    client_id:    e.client_id,
    client_name:  e.client_name,
    service_code: e.service_code,
    service_name: e.service_name,
    quantity:     parseFloat(e.quantity),
    unit:         e.unit,
    unit_rate:    parseFloat(e.unit_rate),
    service_date: e.service_date || new Date().toISOString().slice(0, 10),
    reference_id: e.reference_id || null,
    performed_by: e.performed_by || null,
    notes:        e.notes        || null,
    status:       e.status       || "logged",
    logged_by:    e.logged_by    || null,
  };
}

// ── handler ────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (!SUPA_URL || !SUPA_KEY) {
    return resp(500, { error: "Supabase env vars missing (SUPABASE_URL / SUPABASE_SERVICE_KEY)" });
  }

  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  try {
    // ── GET ?catalog=true → service catalog for the dropdown ──
    if (method === "GET" && params.catalog === "true") {
      const url = `${SUPA_URL}/rest/v1/${TABLE_CAT}?active=eq.true&order=sort_order.asc`;
      const r = await fetch(url, { headers: HEADERS_SUPA });
      const data = await r.json();
      if (!Array.isArray(data)) return resp(500, { error: data });
      return resp(200, data);
    }

    // ── GET → list log entries with optional filters ──
    if (method === "GET") {
      let url = `${SUPA_URL}/rest/v1/${TABLE_LOG}?order=service_date.desc,id.desc`;
      if (params.client_id) url += `&client_id=eq.${encodeURIComponent(params.client_id)}`;
      if (params.status)    url += `&status=eq.${encodeURIComponent(params.status)}`;
      if (params.from)      url += `&service_date=gte.${params.from}`;
      if (params.to)        url += `&service_date=lte.${params.to}`;
      const limit = Math.min(parseInt(params.limit || "200", 10) || 200, 1000);
      url += `&limit=${limit}`;

      const r = await fetch(url, { headers: HEADERS_SUPA });
      const data = await r.json();
      if (!Array.isArray(data)) return resp(500, { error: data });
      return resp(200, data.map(rowToEntry));
    }

    // ── POST → create new entry ──
    if (method === "POST") {
      const body = safeJSON(event.body);
      const err = validateEntry(body);
      if (err) return resp(400, { error: err });

      const row = entryToRow(body);
      const r = await fetch(`${SUPA_URL}/rest/v1/${TABLE_LOG}`, {
        method: "POST",
        headers: HEADERS_SUPA,
        body: JSON.stringify(row),
      });
      const data = await r.json();
      if (!Array.isArray(data) || !data[0]) return resp(500, { error: data });
      return resp(201, rowToEntry(data[0]));
    }

    // ── PATCH → update entry (locked once status='billed') ──
    if (method === "PATCH") {
      const body = safeJSON(event.body);
      if (!body.id) return resp(400, { error: "id required" });

      // Read current status — only logged/voided entries can be edited
      const checkRes = await fetch(
        `${SUPA_URL}/rest/v1/${TABLE_LOG}?id=eq.${body.id}&select=status`,
        { headers: HEADERS_SUPA }
      );
      const check = await checkRes.json();
      if (!Array.isArray(check) || !check[0]) return resp(404, { error: "Entry not found" });

      // Allow status transition logged → billed (set by fr-billing-generator)
      // and logged → voided (manual void). Anything else on a billed row is blocked.
      const isStatusFlip = body.status && (body.status === "billed" || body.status === "voided");
      if (check[0].status === "billed" && !isStatusFlip) {
        return resp(403, { error: "Billed entries are immutable. Void and create a new entry." });
      }

      const update = {};
      ["quantity","unit_rate","reference_id","performed_by","notes",
       "service_date","status","invoice_period","invoice_id","logged_by"]
        .forEach(f => { if (body[f] !== undefined) update[f] = body[f]; });

      const r = await fetch(`${SUPA_URL}/rest/v1/${TABLE_LOG}?id=eq.${body.id}`, {
        method: "PATCH",
        headers: HEADERS_SUPA,
        body: JSON.stringify(update),
      });
      const data = await r.json();
      if (!Array.isArray(data) || !data[0]) return resp(500, { error: data });
      return resp(200, rowToEntry(data[0]));
    }

    // ── DELETE → soft delete ──
    if (method === "DELETE") {
      const id = params.id;
      if (!id) return resp(400, { error: "id required" });

      const r = await fetch(`${SUPA_URL}/rest/v1/${TABLE_LOG}?id=eq.${id}`, {
        method: "PATCH",
        headers: HEADERS_SUPA,
        body: JSON.stringify({ status: "voided" }),
      });
      const data = await r.json();
      if (!Array.isArray(data) || !data[0]) return resp(404, { error: "Entry not found" });
      return resp(200, { success: true, id: data[0].id });
    }

    return resp(405, { error: "Method not allowed" });

  } catch (err) {
    return resp(500, { error: err.message || String(err) });
  }
};

// ── helpers ────────────────────────────────────────────────────────────────
function resp(statusCode, payload) {
  return { statusCode, headers: HEADERS_RESP, body: JSON.stringify(payload) };
}

function safeJSON(s) {
  try { return JSON.parse(s || "{}"); } catch { return {}; }
}

function validateEntry(b) {
  if (!b.client_id || !b.client_name) return "client_id and client_name required";
  if (!b.service_code || !b.service_name) return "service_code and service_name required";
  if (b.quantity == null || parseFloat(b.quantity) <= 0) return "quantity must be positive";
  if (b.unit_rate == null || parseFloat(b.unit_rate) < 0) return "unit_rate required and non-negative";
  if (!b.unit) return "unit required";
  return null;
}
