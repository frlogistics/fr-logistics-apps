// wa-clients.js — FR-Logistics WhatsApp Client Manager
// CRUD for fr_clients table in Supabase
// Columns: name, company, wa_number, wa_notifications, daily_inbound, daily_outbound, email, phone, status, active, notes

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY");
const PHONE_ID = Netlify.env.get("WHATSAPP_PHONE_ID");
const TOKEN = Netlify.env.get("WHATSAPP_TOKEN");

const headers = {
  "apikey": SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  "Prefer": "return=representation"
};

// Send a WhatsApp template message
async function sendTemplate(to, templateName, params) {
  const res = await fetch(`https://graph.facebook.com/v20.0/${PHONE_ID}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: "en_US" },
        components: params.length > 0 ? [{
          type: "body",
          parameters: params.map(text => ({ type: "text", text: String(text) }))
        }] : []
      }
    })
  });
  return res.json();
}

export default async (req) => {
  const method = req.method;
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  // ── GET clients ─────────────────────────────────────────
  if (method === "GET" && !action) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/fr_clients?select=id,name,company,wa_number,wa_notifications,daily_inbound,daily_outbound,email,phone,status,active,notes,created_at&order=name.asc`,
      { headers }
    );
    const data = await res.json();
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // ── POST — create client ─────────────────────────────────
  if (method === "POST" && !action) {
    const body = await req.json();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/fr_clients`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: body.name,
        company: body.company || null,
        wa_number: body.wa_number || null,
        wa_notifications: body.wa_notifications || false,
        daily_inbound: body.daily_inbound || 0,
        daily_outbound: body.daily_outbound || 0,
        email: body.email || null,
        phone: body.phone || null,
        status: body.status || "active",
        active: true,
        notes: body.notes || null
      })
    });
    const data = await res.json();
    return new Response(JSON.stringify(data), { status: 201, headers: { "Content-Type": "application/json" } });
  }

  // ── PATCH — update client ────────────────────────────────
  if (method === "PATCH") {
    const body = await req.json();
    const { id, ...updates } = body;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/fr_clients?id=eq.${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(updates)
    });
    const data = await res.json();
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // ── DELETE — remove client ───────────────────────────────
  if (method === "DELETE") {
    const body = await req.json();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/fr_clients?id=eq.${body.id}`, {
      method: "DELETE",
      headers
    });
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // ── POST action=send — send WA message to client ─────────
  if (method === "POST" && action === "send") {
    const body = await req.json();
    const { wa_number, template, params = [], client_name } = body;

    if (!wa_number || !template) {
      return new Response(JSON.stringify({ error: "wa_number and template required" }), { status: 400 });
    }

    const result = await sendTemplate(wa_number, template, params);
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
};
