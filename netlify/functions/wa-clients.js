// netlify/functions/wa-clients.js
// FR-Logistics — Client CRUD (GET / POST / PATCH / DELETE)
// select=* returns ALL fr_clients columns including billing config fields:
//   billing_source, shipping_markup, mmb, wms_integration, ss_custom_field_1

import Netlify from "@netlify/functions";

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY");

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

// select=* returns all columns — no need to update this file when new columns are added
const SELECT_COLS = "*";

export default async (req) => {
  if (req.method === "OPTIONS")
    return new Response("", { status: 200, headers: cors });

  const method = req.method;
  const url    = new URL(req.url);
  const action = url.searchParams.get("action");

  // ── GET — fetch all active clients ────────────────────────────────────────
  if (method === "GET" && !action) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/fr_clients?select=${SELECT_COLS}&order=name.asc`,
      { headers: sbHeaders }
    );
    const data = await res.json();

    // Normalize services array — strip any extra quotes stored in Supabase
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

    return new Response(JSON.stringify(clean), { status: 200, headers: cors });
  }

  // ── POST — create new client ───────────────────────────────────────────────
  if (method === "POST") {
    const body = await req.json();
    const res  = await fetch(
      `${SUPABASE_URL}/rest/v1/fr_clients`,
      { method: "POST", headers: sbHeaders, body: JSON.stringify(body) }
    );
    const data = await res.json();
    return new Response(JSON.stringify(data), { status: res.status, headers: cors });
  }

  // ── PATCH — update existing client (passes through ALL fields) ─────────────
  if (method === "PATCH") {
    const body       = await req.json();
    const { id, ...fields } = body;  // dynamic — works with any new columns

    if (!id)
      return new Response(
        JSON.stringify({ error: "id required for PATCH" }),
        { status: 400, headers: cors }
      );

    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/fr_clients?id=eq.${id}`,
      { method: "PATCH", headers: sbHeaders, body: JSON.stringify(fields) }
    );
    const data = await res.json();
    return new Response(JSON.stringify(data), { status: res.status, headers: cors });
  }

  // ── DELETE — remove client ─────────────────────────────────────────────────
  if (method === "DELETE") {
    const { id } = await req.json();

    if (!id)
      return new Response(
        JSON.stringify({ error: "id required for DELETE" }),
        { status: 400, headers: cors }
      );

    await fetch(
      `${SUPABASE_URL}/rest/v1/fr_clients?id=eq.${id}`,
      { method: "DELETE", headers: sbHeaders }
    );
    return new Response(JSON.stringify({ deleted: true }), { status: 200, headers: cors });
  }

  return new Response(
    JSON.stringify({ error: "Method not allowed" }),
    { status: 405, headers: cors }
  );
};
