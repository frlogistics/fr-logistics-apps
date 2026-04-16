// netlify/functions/wa-clients.js
// FR-Logistics — Client CRUD (GET / POST / PATCH / DELETE)
// Uses CommonJS (exports.handler) to match original file format
// select=* returns ALL fr_clients columns including new billing fields

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const sbHeaders = {
  "apikey":        SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type":  "application/json",
  "Prefer":        "return=representation",
};

const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type":                 "application/json",
};

// select=* returns ALL columns — no need to update when new columns are added to fr_clients
const SELECT_COLS = "*";

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS")
    return { statusCode: 200, headers: cors, body: "" };

  const method = event.httpMethod;
  const params = event.queryStringParameters || {};
  const action = params.action;

  // ── GET — fetch all clients ────────────────────────────────────────────────
  if (method === "GET" && !action) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/fr_clients?select=${SELECT_COLS}&order=name.asc`,
      { headers: sbHeaders }
    );
    const data = await res.json();

    // Normalize services array — strip extra quotes stored in Supabase
    const clean = Array.isArray(data)
      ? data.map(c => ({
          ...c,
          services: Array.isArray(c.services)
            ? c.services.map(s => String(s).replace(/"/g, "").trim())
            : typeof c.services === "string"
              ? c.services.split(",").map(s => s.replace(/"/g, "").trim()).filter(Boolean)
              : [],
        }))
      : data;

    return { statusCode: 200, headers: cors, body: JSON.stringify(clean) };
  }

  // ── POST — create new client ───────────────────────────────────────────────
  if (method === "POST") {
    const body = JSON.parse(event.body || "{}");
    const res  = await fetch(
      `${SUPABASE_URL}/rest/v1/fr_clients`,
      { method: "POST", headers: sbHeaders, body: JSON.stringify(body) }
    );
    const data = await res.json();
    return { statusCode: res.status, headers: cors, body: JSON.stringify(data) };
  }

  // ── PATCH — update existing client (dynamic — passes ALL fields through) ───
  if (method === "PATCH") {
    const body = JSON.parse(event.body || "{}");
    const { id, ...fields } = body;

    if (!id)
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "id required for PATCH" }) };

    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/fr_clients?id=eq.${id}`,
      { method: "PATCH", headers: sbHeaders, body: JSON.stringify(fields) }
    );
    const data = await res.json();
    return { statusCode: res.status, headers: cors, body: JSON.stringify(data) };
  }

  // ── DELETE — remove client ─────────────────────────────────────────────────
  if (method === "DELETE") {
    const { id } = JSON.parse(event.body || "{}");

    if (!id)
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "id required for DELETE" }) };

    await fetch(
      `${SUPABASE_URL}/rest/v1/fr_clients?id=eq.${id}`,
      { method: "DELETE", headers: sbHeaders }
    );
    return { statusCode: 200, headers: cors, body: JSON.stringify({ deleted: true }) };
  }

  return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "Method not allowed" }) };
};
