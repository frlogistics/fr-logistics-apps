// netlify/functions/whatsapp-webhook.js
// Receives inbound WhatsApp messages via Meta webhook
// Stores in Supabase wa_messages table (no external packages needed)

const VERIFY_TOKEN  = process.env.WHATSAPP_WEBHOOK_SECRET || "frlogistics_wa_2026";
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const WA_TOKEN      = process.env.WHATSAPP_TOKEN;
const PHONE_ID      = process.env.WHATSAPP_PHONE_ID;

// ── Supabase helper (no SDK, pure fetch) ─────────────────────────
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
  if (!res.ok) {
    const err = await res.text();
    console.error(`Supabase insert error [${table}]:`, err);
  }
  return res.ok;
}

export default async function handler(req, context) {
  const method = req.method;

  // ── GET: webhook verification ────────────────────────────────────
  if (method === "GET") {
    const url       = new URL(req.url);
    const mode      = url.searchParams.get("hub.mode");
    const token     = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return new Response(challenge, { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  // ── POST: inbound message ────────────────────────────────────────
  if (method === "POST") {
    let payload;
    try { payload = await req.json(); } catch {
      return new Response("Bad Request", { status: 400 });
    }

    const entry    = payload?.entry?.[0];
    const changes  = entry?.changes?.[0];
    const value    = changes?.value;
    const msgs     = value?.messages;
    const contacts = value?.contacts || [];

    // Status update (not a real message) — return OK immediately
    if (!msgs || msgs.length === 0) {
      return new Response("OK", { status: 200 });
    }

    for (const msg of msgs) {
      const from      = msg.from;
      const msgId     = msg.id;
      const timestamp = parseInt(msg.timestamp, 10);
      const type      = msg.type || "text";

      let text = "";
      if (type === "text")      text = msg.text?.body || "";
      else if (type === "image")     text = "[Image]";
      else if (type === "document")  text = "[Document]";
      else if (type === "audio")     text = "[Audio]";
      else if (type === "video")     text = "[Video]";
      else if (type === "location")  text = `[Location: ${msg.location?.latitude}, ${msg.location?.longitude}]`;
      else text = `[${type}]`;

      const contact    = contacts.find(c => c.wa_id === from);
      const clientName = contact?.profile?.name || "";

      console.log(`[WA INBOUND] +${from} (${clientName}): ${text}`);

      // Save to Supabase wa_messages table
      await sbInsert("wa_messages", {
        wa_msg_id:   msgId,
        direction:   "inbound",
        from_number: from,
        to_number:   PHONE_ID || "",
        client_name: clientName,
        body:        text,
        msg_type:    type,
        timestamp:   new Date(timestamp * 1000).toISOString(),
        read:        false,
        replied:     false
      });
    }

    return new Response("OK", { status: 200 });
  }

  return new Response("Method Not Allowed", { status: 405 });
}

export const config = {
  path: "/.netlify/functions/whatsapp-webhook"
};
