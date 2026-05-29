// netlify/functions/quote-leads.js
// Secure read proxy for the Quote Builder "Import from Lead" feature.
// GET  /.netlify/functions/quote-leads            -> list recent importable leads
// GET  /.netlify/functions/quote-leads?id={uuid}  -> single lead, full detail
// PATCH /.netlify/functions/quote-leads            -> mark a lead as quoted ({ id, status })
//
// wa_leads is under RLS, so this function uses the SUPABASE_SERVICE_KEY (server-side only).
// Follows the existing FR-Logistics proxy pattern (shipments-proxy.js, etc.).

const SUPA_URL = "https://rijbschnchjiuggrhfrx.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, PATCH, OPTIONS",
  "Content-Type": "application/json",
};

// Columns we expose to the Quote Builder. No PII beyond what the operator already
// sees in the lead email; nothing sensitive.
const FIELDS = [
  "id", "created_at", "name", "email", "phone", "country", "language",
  "service", "service_detail", "monthly_volume", "skus", "product_type",
  "origin", "destination", "status", "notes", "conversation_summary", "source",
].join(",");

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase ${res.status}: ${body}`);
  }
  // PATCH with return=minimal yields empty body
  const txt = await res.text();
  return txt ? JSON.parse(txt) : [];
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }

  if (!SERVICE_KEY) {
    return { statusCode: 500, headers: CORS,
      body: JSON.stringify({ error: "SUPABASE_SERVICE_KEY not configured" }) };
  }

  try {
    // ---- Single lead by id ----
    if (event.httpMethod === "GET" && event.queryStringParameters?.id) {
      const id = encodeURIComponent(event.queryStringParameters.id);
      const rows = await sb(`wa_leads?id=eq.${id}&select=${FIELDS}`);
      if (!rows.length) {
        return { statusCode: 404, headers: CORS,
          body: JSON.stringify({ error: "Lead not found" }) };
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify(rows[0]) };
    }

    // ---- List recent importable leads ----
    if (event.httpMethod === "GET") {
      // Show actionable leads: anything not already won/lost, last 60 days.
      const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
      const rows = await sb(
        `wa_leads?select=${FIELDS}` +
        `&status=in.(new,qualifying,sent_to_sales)` +
        `&created_at=gte.${since}` +
        `&order=created_at.desc&limit=50`
      );
      return { statusCode: 200, headers: CORS, body: JSON.stringify(rows) };
    }

    // ---- Mark a lead as quoted / update status ----
    if (event.httpMethod === "PATCH") {
      const { id, status } = JSON.parse(event.body || "{}");
      if (!id) {
        return { statusCode: 400, headers: CORS,
          body: JSON.stringify({ error: "id required" }) };
      }
      const allowed = ["new", "qualifying", "sent_to_sales", "won", "lost"];
      const next = allowed.includes(status) ? status : "sent_to_sales";
      await sb(`wa_leads?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: next, updated_at: new Date().toISOString() }),
      });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, status: next }) };
    }

    return { statusCode: 405, headers: CORS,
      body: JSON.stringify({ error: "Method not allowed" }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS,
      body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
