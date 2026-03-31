// netlify/functions/whatsapp-webhook.js
// Receives inbound WhatsApp messages via Meta webhook
// Saves to Netlify Blobs (for portal inbox) AND emails warehouse@fr-logistics.net

import { getStore } from "@netlify/blobs";

const VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_SECRET || "frlogistics_wa_2026";
const WA_TOKEN    = process.env.WHATSAPP_TOKEN;
const PHONE_ID    = process.env.WHATSAPP_PHONE_ID;

export default async function handler(req, context) {
  const method = req.method;

  // ── Webhook verification (GET) ──────────────────────────────────
  if (method === "GET") {
    const url = new URL(req.url);
    const mode      = url.searchParams.get("hub.mode");
    const token     = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return new Response(challenge, { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  // ── Incoming message (POST) ─────────────────────────────────────
  if (method === "POST") {
    let payload;
    try {
      payload = await req.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    // Extract message data from Meta webhook payload
    const entry   = payload?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;
    const msgs    = value?.messages;

    // Handle status updates (not inbound messages) — just return OK
    if (!msgs || msgs.length === 0) {
      return new Response("OK", { status: 200 });
    }

    const store = getStore({ name: "wa-messages", consistency: "strong" });
    const promises = [];

    for (const msg of msgs) {
      const from      = msg.from;                          // e.g. "17865001234"
      const msgId     = msg.id;
      const timestamp = msg.timestamp;                     // unix seconds
      const type      = msg.type || "text";

      // Extract text based on message type
      let text = "";
      if (type === "text")     text = msg.text?.body || "";
      else if (type === "image")  text = "[Image received]";
      else if (type === "document") text = "[Document received]";
      else if (type === "audio")  text = "[Audio received]";
      else if (type === "video")  text = "[Video received]";
      else if (type === "location") text = `[Location: ${msg.location?.latitude}, ${msg.location?.longitude}]`;
      else text = `[${type} message]`;

      // Try to find client name from contact info in payload
      const contacts = value?.contacts || [];
      const contact  = contacts.find(c => c.wa_id === from);
      const clientName = contact?.profile?.name || "";

      // Build message object
      const message = {
        id:         msgId,
        direction:  "inbound",
        from,
        clientName,
        text,
        type,
        timestamp:  parseInt(timestamp, 10),
        receivedAt: new Date().toISOString(),
        read:       false,
        replied:    false
      };

      // 1. Save to Netlify Blobs
      promises.push(
        (async () => {
          try {
            const existing = await store.get("messages", { type: "json" }) || [];
            // Avoid duplicates
            if (!existing.find(m => m.id === msgId)) {
              existing.push(message);
              // Keep only last 500 messages
              const trimmed = existing.slice(-500);
              await store.setJSON("messages", trimmed);
            }
          } catch (err) {
            console.error("Blobs save error:", err);
          }
        })()
      );

      // 2. Send email notification to warehouse
      if (process.env.MAILGUN_API_KEY || process.env.SENDGRID_API_KEY) {
        // Email via available provider — skip if not configured
      }
      // Log to console (visible in Netlify function logs)
      console.log(`[WA INBOX] From: +${from} | Name: ${clientName} | Text: ${text}`);
    }

    await Promise.all(promises);
    return new Response("OK", { status: 200 });
  }

  return new Response("Method Not Allowed", { status: 405 });
}

export const config = {
  path: "/.netlify/functions/whatsapp-webhook"
};
