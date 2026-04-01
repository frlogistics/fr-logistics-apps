// ecopack-wa.js — FR-Logistics EcoPack+ WhatsApp Module
// Handles: package received notifications, multi-package alerts, pickup scheduling
//
// Actions (via ?action= query param):
//   POST ?action=notify    — send package received WA (called from Inbound app)
//   POST ?action=schedule  — create pickup record + send pickup_scheduled WA
//   GET  ?action=pending   — get pending package count for a client
//   GET  (no action)       — list pickups (optionally ?client_id=)
//   PATCH                  — update pickup status (confirmed/completed/cancelled)

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY");
const PHONE_ID     = Netlify.env.get("WHATSAPP_PHONE_ID");
const TOKEN        = Netlify.env.get("WHATSAPP_TOKEN");

const sbHeaders = {
  "apikey":        SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type":  "application/json",
  "Prefer":        "return=representation"
};

// ── WA Template sender ───────────────────────────────────────────
async function sendTemplate(to, templateName, params, lang = "en_US") {
  const res = await fetch(`https://graph.facebook.com/v20.0/${PHONE_ID}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: lang },
        components: params.length > 0 ? [{
          type: "body",
          parameters: params.map(text => ({ type: "text", text: String(text) }))
        }] : []
      }
    })
  });
  return res.json();
}

// ── Compute pending EcoPack+ packages for a client ───────────────
async function getPendingCount(clientName) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/shipments_general?client=eq.${encodeURIComponent(clientName)}&type=like.*EcoPack*&select=direction`,
    { headers: sbHeaders }
  );
  const data = await res.json();
  if (!Array.isArray(data)) return 0;
  const inbound  = data.filter(r => r.direction === "Inbound").length;
  const outbound = data.filter(r => r.direction === "Outbound").length;
  return Math.max(0, inbound - outbound);
}

export default async (req) => {
  const method   = req.method;
  const url      = new URL(req.url);
  const action   = url.searchParams.get("action");
  const clientId = url.searchParams.get("client_id");

  // ── GET — list pending pickups ────────────────────────────────────
  if (method === "GET" && !action) {
    const endpoint = clientId
      ? `${SUPABASE_URL}/rest/v1/ecopack_pickups?client_id=eq.${clientId}&order=created_at.desc`
      : `${SUPABASE_URL}/rest/v1/ecopack_pickups?status=neq.completed&status=neq.cancelled&order=scheduled_date.asc&limit=50`;
    const res  = await fetch(endpoint, { headers: sbHeaders });
    const data = await res.json();
    return new Response(JSON.stringify(data), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  }

  // ── GET ?action=pending — pending package count ───────────────────
  if (method === "GET" && action === "pending") {
    const clientName = url.searchParams.get("client_name") || "";
    const count = await getPendingCount(clientName);
    return new Response(JSON.stringify({ count }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  }

  // ── POST ?action=notify — package received WA ────────────────────
  // Called automatically from Inbound_Outbound.html after saving EcoPack+ inbound
  if (method === "POST" && action === "notify") {
    const body = await req.json();
    const { to, client_name, pending_count, lang } = body;

    if (!to) return new Response(JSON.stringify({ error: "to is required" }), { status: 400 });

    const isMulti       = pending_count >= 2;
    const templateName  = isMulti ? "ecopack_multi_package" : "ecopack_package_received";
    const templateLang  = "es"
    const params        = isMulti ? [client_name, String(pending_count)] : [client_name];

    try {
      const waResult = await sendTemplate(to, templateName, params, templateLang);
      console.log(`EcoPack notify → ${to} (${templateName}):`, JSON.stringify(waResult));
      return new Response(JSON.stringify({ success: true, waResult }), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
  }

  // ── POST ?action=schedule — create pickup + send WA ───────────────
  if (method === "POST" && action === "schedule") {
    const body = await req.json();
    const { client_id, client_name, wa_number, pending_count, scheduled_date, scheduled_time, lang } = body;

    if (!client_id || !client_name) {
      return new Response(JSON.stringify({ error: "client_id and client_name required" }), { status: 400 });
    }

    // 1. Create pickup record in Supabase
    const pickupRes = await fetch(`${SUPABASE_URL}/rest/v1/ecopack_pickups`, {
      method: "POST",
      headers: sbHeaders,
      body: JSON.stringify({
        client_id,
        client_name,
        wa_number:      wa_number || null,
        pending_count:  pending_count || 0,
        scheduled_date,
        scheduled_time,
        status: "scheduled"
      })
    });
    const pickup = await pickupRes.json();

    // 2. Send pickup_scheduled WA template
    let waResult = null;
    if (wa_number) {
      try {
        waResult = await sendTemplate(
          wa_number,
          "ecopack_pickup_scheduled",
          [client_name, scheduled_date, scheduled_time, String(pending_count || 0)],
          "es"
        );
        console.log(`EcoPack schedule → ${wa_number}:`, JSON.stringify(waResult));
      } catch (e) {
        console.error("WA send error:", e.message);
      }
    }

    return new Response(JSON.stringify({
      pickup: Array.isArray(pickup) ? pickup[0] : pickup,
      waResult
    }), { status: 201, headers: { "Content-Type": "application/json" } });
  }

  // ── PATCH — update pickup status ──────────────────────────────────
  if (method === "PATCH") {
    const body = await req.json();
    const { id, status } = body;
    if (!id || !status) {
      return new Response(JSON.stringify({ error: "id and status required" }), { status: 400 });
    }
    const updates = { status };
    if (status === "confirmed") updates.confirmed_at = new Date().toISOString();
    if (status === "completed") updates.completed_at = new Date().toISOString();

    const res  = await fetch(`${SUPABASE_URL}/rest/v1/ecopack_pickups?id=eq.${id}`, {
      method: "PATCH",
      headers: sbHeaders,
      body: JSON.stringify(updates)
    });
    const data = await res.json();
    return new Response(JSON.stringify(data), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
};
