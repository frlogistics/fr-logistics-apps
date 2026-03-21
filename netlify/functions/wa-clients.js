const SUPA_URL = "https://rijbschnchjiuggrhfrx.supabase.co";
const SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJpamJzY2huY2hqaXVnZ3JoZnJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzMTQwOTQsImV4cCI6MjA4ODg5MDA5NH0.s3T4CStjWqOvz7qDpYtjt0yVJ0iyOMAKKwxkADSEs4s";
const TABLE = "wa_clients";
const HDR = { "Content-Type": "application/json" };

async function sb(method, path, body) {
  const res = await fetch(SUPA_URL + path, {
    method,
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      "Content-Type": "application/json",
      Prefer: method === "POST" ? "return=representation" : ""
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

exports.handler = async function(event) {
  const method = event.httpMethod;

  try {
    if (method === "GET") {
      // Get all clients ordered by name
      const data = await sb("GET", `/rest/v1/${TABLE}?order=name.asc&limit=200`);
      return { statusCode: 200, headers: HDR, body: JSON.stringify(Array.isArray(data) ? data : []) };
    }

    if (method === "POST") {
      const body = JSON.parse(event.body || "{}");

      if (body.action === "save_all") {
        // Upsert all clients
        const clients = (body.clients || []).map(c => ({
          id: c.id || Date.now().toString(),
          name: c.name || "",
          company: c.company || "",
          email: c.email || "",
          phone: c.phone || "",
          country: c.country || "US",
          wa_number: c.waNumber || "",
          store_id: c.storeId || "",
          store_name: c.storeName || "",
          active: c.active || false,
          notes: c.notes || ""
        }));

        // Delete all and reinsert (simple sync)
        await sb("DELETE", `/rest/v1/${TABLE}?id=neq.00000000-0000-0000-0000-000000000000`);
        if (clients.length > 0) {
          await sb("POST", `/rest/v1/${TABLE}`, clients);
        }
        return { statusCode: 200, headers: HDR, body: JSON.stringify({ ok: true }) };
      }
    }

    return { statusCode: 405, body: "Method not allowed" };
  } catch (err) {
    console.error("[wa-clients]", err.message);
    return { statusCode: 500, headers: HDR, body: JSON.stringify({ error: err.message }) };
  }
};
