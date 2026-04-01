// netlify/functions/wa-messages.js
// GET  — returns inbox messages from Supabase wa_messages table
// POST — sends WA template or free-text reply, records outbound

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WA_TOKEN     = process.env.WHATSAPP_TOKEN;
const PHONE_ID     = process.env.WHATSAPP_PHONE_ID;
const WA_BASE      = `https://graph.facebook.com/v21.0/${PHONE_ID}`;

// ── Supabase helpers ──────────────────────────────────────────────
async function sbSelect(table, params = "") {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${params}`, {
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json"
    }
  });
  if (!res.ok) return [];
  return res.json();
}

async function sbInsert(table, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal"
    },
    body: JSON.stringify(row)
  });
  return res.ok;
}

async function sbPatch(table, filter, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal"
    },
    body: JSON.stringify(data)
  });
  return res.ok;
}

// ── Template component builder ────────────────────────────────────
/* NEW */
function buildComponents(type, data) {
  const templates = {
    order_received: [{ type: "body", parameters: [
      { type: "text", text: data.clientName || "" },
      { type: "text", text: data.orderNumber || "" }
    ]}],
    tracking_update: [{ type: "body", parameters: [
      { type: "text", text: data.clientName || "" },
      { type: "text", text: data.orderNumber || "" },
      { type: "text", text: data.trackingNumber || "" },
      { type: "text", text: data.carrier || "" }
    ]}],
    payment_link: [{ type: "body", parameters: [
      { type: "text", text: data.clientName || "" },
      { type: "text", text: data.amount || "" },
      { type: "text", text: data.link || "" }
    ]}],
    daily_summary: [{ type: "body", parameters: [
      { type: "text", text: data.clientName || "" },
      { type: "text", text: data.dateLabel || new Date().toLocaleDateString("en-US") },
      { type: "text", text: String(data.inbound || "0") },
      { type: "text", text: String(data.outbound || "0") }
    ]}],
    ecopack_package_received: [{ type: "body", parameters: [
      { type: "text", text: data.clientName || "" }
    ]}],
    ecopack_multi_package: [{ type: "body", parameters: [
      { type: "text", text: data.clientName || "" },
      { type: "text", text: String(data.packageCount || data.package_count || "0") }
    ]}],
    ecopack_pickup_scheduled: [{ type: "body", parameters: [
      { type: "text", text: data.clientName || "" },
      { type: "text", text: data.date || "" },
      { type: "text", text: data.time || "" },
      { type: "text", text: String(data.packageCount || data.package_count || "0") }
    ]}]
  };
  return templates[type] || null;
}
/* NEW */
function buildPreviewText(type, data) {
  const map = {
    order_received:           `Hi ${data.clientName}, we received your shipment at FR-Logistics Miami. Order #${data.orderNumber}.`,
    tracking_update:          `Hi ${data.clientName}, your order #${data.orderNumber} has been processed. Tracking: ${data.trackingNumber} with ${data.carrier}.`,
    payment_link:             `Hi ${data.clientName}, your FR-Logistics invoice for $${data.amount} is ready. Pay here: ${data.link}.`,
    daily_summary:            `Hi ${data.clientName}, daily summary ${data.dateLabel} — Inbound: ${data.inbound}. Outbound: ${data.outbound}.`,
    ecopack_package_received: `Hi ${data.clientName}, we received a package for you at FR-Logistics! Reply PICKUP to schedule or HOURS for availability.`,
    ecopack_multi_package:    `Hi ${data.clientName}, you now have ${data.packageCount || data.package_count || 0} packages waiting at FR-Logistics. Reply PICKUP to schedule.`,
    ecopack_pickup_scheduled: `Hi ${data.clientName}, your EcoPack+ pickup is scheduled for ${data.date} at ${data.time}. You have ${data.packageCount || data.package_count || 0} packages ready.`
  };
  return map[type] || "";
}


export default async function handler(req, context) {
  const method = req.method;
  const url    = new URL(req.url);

  // ── GET — return messages ────────────────────────────────────────
  if (method === "GET") {
    try {
      const limit  = url.searchParams.get("limit") || "100";
      const phone  = url.searchParams.get("phone") || "";

      let params = `?order=timestamp.desc&limit=${limit}`;
      if (phone) params += `&or=(from_number.eq.${phone},to_number.eq.${phone})`;

      const messages = await sbSelect("wa_messages", params);

      // Map Supabase fields to portal-friendly format
      const mapped = messages.map(m => ({
        id:          m.id,
        wa_msg_id:   m.wa_msg_id,
        direction:   m.direction,
        from:        m.from_number,
        to:          m.to_number,
        clientName:  m.client_name,
        text:        m.body,
        type:        m.msg_type,
        timestamp:   Math.floor(new Date(m.timestamp).getTime() / 1000),
        read:        m.read,
        replied:     m.replied
      }));

      return new Response(JSON.stringify(mapped), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      console.error("GET wa-messages error:", err);
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  // ── POST — send or action ────────────────────────────────────────
  if (method === "POST") {
    let body;
    try { body = await req.json(); } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
    }

    // Action: mark as read
    if (body.action === "mark_read" && body.id) {
      await sbPatch("wa_messages", `id=eq.${body.id}`, { read: true });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    }

    // Action: free-text reply (within 24h window)
    if (body.action === "reply" && body.to && body.text) {
      const to = body.to.replace(/\D/g, "");
      const waPayload = {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: body.text }
      };

      const waRes  = await fetch(`${WA_BASE}/messages`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(waPayload)
      });
      const result = await waRes.json();

      if (waRes.ok) {
        // Record outbound in Supabase
        await sbInsert("wa_messages", {
          wa_msg_id:   result.messages?.[0]?.id || `out-${Date.now()}`,
          direction:   "outbound",
          from_number: PHONE_ID || "",
          to_number:   to,
          client_name: body.clientName || "",
          body:        body.text,
          msg_type:    "text",
          timestamp:   new Date().toISOString(),
          read:        true,
          replied:     false
        });
        // Mark original as replied
        if (body.replyToId) {
          await sbPatch("wa_messages", `id=eq.${body.replyToId}`, { replied: true });
        }
      }

      return new Response(JSON.stringify(result), {
        status: waRes.ok ? 200 : 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Action: send template
    if (body.type && body.to && body.data) {
      const to         = body.to.replace(/\D/g, "");
      const components = buildComponents(body.type, body.data);
      if (!components) {
        return new Response(JSON.stringify({ error: "Unknown template: " + body.type }), { status: 400 });
      }

      const waPayload = {
        messaging_product: "whatsapp",
        to,
      
      template: {
          name:       body.type,
          language:   { code: body.type.startsWith("ecopack_") ? "es" : "en_US" },
          components
        }
      };

      const waRes  = await fetch(`${WA_BASE}/messages`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(waPayload)
      });
      const result = await waRes.json();

      if (waRes.ok) {
        // Record outbound in Supabase
        const preview = buildPreviewText(body.type, body.data);
        await sbInsert("wa_messages", {
          wa_msg_id:   result.messages?.[0]?.id || `out-${Date.now()}`,
          direction:   "outbound",
          from_number: PHONE_ID || "",
          to_number:   to,
          client_name: body.data?.clientName || "",
          body:        preview,
          msg_type:    "template",
          timestamp:   new Date().toISOString(),
          read:        true,
          replied:     false
        });
      }

      return new Response(JSON.stringify(result), {
        status: waRes.ok ? 200 : 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action or missing fields" }), { status: 400 });
  }

  return new Response("Method Not Allowed", { status: 405 });
}

export const config = {
  path: "/.netlify/functions/wa-messages"
};
