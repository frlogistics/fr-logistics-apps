// netlify/functions/wa-messages.js
// GET  — returns inbox messages from Netlify Blobs
// POST — sends a WhatsApp template OR free-text reply, records outbound

import { getStore } from "@netlify/blobs";

const WA_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const WA_BASE  = `https://graph.facebook.com/v21.0/${PHONE_ID}`;

export default async function handler(req, context) {
  const method = req.method;
  const store  = getStore({ name: "wa-messages", consistency: "strong" });

  // ── GET — return inbox ──────────────────────────────────────────
  if (method === "GET") {
    try {
      const url = new URL(req.url);
      const limit = parseInt(url.searchParams.get("limit") || "100", 10);

      const messages = await store.get("messages", { type: "json" }) || [];
      // Sort newest first
      const sorted = [...messages].sort((a, b) => b.timestamp - a.timestamp);

      return new Response(JSON.stringify(sorted.slice(0, limit)), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      console.error("GET messages error:", err);
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  // ── POST — send message or perform action ───────────────────────
  if (method === "POST") {
    let body;
    try { body = await req.json(); } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
    }

    // Action: mark message as read
    if (body.action === "mark_read") {
      try {
        const messages = await store.get("messages", { type: "json" }) || [];
        const idx = messages.findIndex(m => m.id === body.id);
        if (idx !== -1) {
          messages[idx].read = true;
          await store.setJSON("messages", messages);
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // Action: send template message (for New Message modal)
    if (body.type && body.to && body.data) {
      return await sendTemplate(body, store);
    }

    // Action: send free-text reply (only works within 24h window)
    if (body.action === "reply" && body.to && body.text) {
      return await sendReply(body, store);
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), { status: 400 });
  }

  return new Response("Method Not Allowed", { status: 405 });
}

// ── Send template message ─────────────────────────────────────────
async function sendTemplate(body, store) {
  const { type, to, data } = body;

  // Template component builders
  const TEMPLATE_COMPONENTS = {
    order_received: [
      { type: "body", parameters: [
        { type: "text", text: data.clientName || "" },
        { type: "text", text: data.orderNumber || "" }
      ]}
    ],
    tracking_update: [
      { type: "body", parameters: [
        { type: "text", text: data.clientName || "" },
        { type: "text", text: data.orderNumber || "" },
        { type: "text", text: data.trackingNumber || "" },
        { type: "text", text: data.carrier || "" }
      ]}
    ],
    payment_link: [
      { type: "body", parameters: [
        { type: "text", text: data.clientName || "" },
        { type: "text", text: data.amount || "" },
        { type: "text", text: data.link || "" }
      ]}
    ],
    daily_summary: [
      { type: "body", parameters: [
        { type: "text", text: data.clientName || "" },
        { type: "text", text: data.dateLabel || new Date().toLocaleDateString("en-US") },
        { type: "text", text: String(data.inbound || "0") },
        { type: "text", text: String(data.outbound || "0") }
      ]}
    ]
  };

  const components = TEMPLATE_COMPONENTS[type];
  if (!components) {
    return new Response(JSON.stringify({ error: "Unknown template: " + type }), { status: 400 });
  }

  const waPayload = {
    messaging_product: "whatsapp",
    to: to.replace(/\D/g, ""),
    type: "template",
    template: {
      name: type,
      language: { code: "en_US" },
      components
    }
  };

  try {
    const res = await fetch(`${WA_BASE}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(waPayload)
    });
    const result = await res.json();

    // Record outbound in Blobs
    const preview = buildPreview(type, data);
    await recordOutbound(store, to, data.clientName || "", preview, type);

    return new Response(JSON.stringify(result), {
      status: res.ok ? 200 : 400,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

// ── Send free-text reply (within 24h window) ─────────────────────
async function sendReply(body, store) {
  const { to, text, clientName } = body;

  const waPayload = {
    messaging_product: "whatsapp",
    to: to.replace(/\D/g, ""),
    type: "text",
    text: { body: text }
  };

  try {
    const res = await fetch(`${WA_BASE}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(waPayload)
    });
    const result = await res.json();

    // Record outbound in Blobs
    await recordOutbound(store, to, clientName || "", text, "reply");

    return new Response(JSON.stringify(result), {
      status: res.ok ? 200 : 400,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

// ── Record outbound message in Blobs ─────────────────────────────
async function recordOutbound(store, to, clientName, text, template) {
  try {
    const messages = await store.get("messages", { type: "json" }) || [];
    messages.push({
      id:         `out-${Date.now()}`,
      direction:  "outbound",
      to,
      clientName,
      text,
      template,
      timestamp:  Math.floor(Date.now() / 1000),
      sentAt:     new Date().toISOString(),
      read:       true
    });
    await store.setJSON("messages", messages.slice(-500));
  } catch (err) {
    console.error("Record outbound error:", err);
  }
}

// ── Build preview text for outbound record ────────────────────────
function buildPreview(type, data) {
  const templates = {
    order_received:  `Hi ${data.clientName}, we received your shipment at FR-Logistics Miami. Order #${data.orderNumber}.`,
    tracking_update: `Hi ${data.clientName}, your order #${data.orderNumber} has been processed. Tracking: ${data.trackingNumber} with ${data.carrier}.`,
    payment_link:    `Hi ${data.clientName}, your FR-Logistics invoice for $${data.amount} is ready. Pay here: ${data.link}.`,
    daily_summary:   `Hi ${data.clientName}, daily summary ${data.dateLabel} — Inbound: ${data.inbound}. Outbound: ${data.outbound}.`
  };
  return templates[type] || "";
}

export const config = {
  path: "/.netlify/functions/wa-messages"
};
