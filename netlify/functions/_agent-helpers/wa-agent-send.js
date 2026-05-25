// netlify/functions-helpers/wa-agent-send.js
//
// Sends outbound WhatsApp messages via Meta Cloud API.
// Mirrors the pattern used by whatsapp-notify.js but tailored to agent use:
//   - text-only (templates come later in Sprint 4 for proactive flows)
//   - records the outbound in Netlify Blobs (wa-messages store) so the
//     portal Inbox shows the conversation as bidirectional
//   - updates wa_agent_conversations.last_agent_message_at on success
//
// Used by: wa-agent-router.js, wa-agent-greet.js, future state handlers.

import { getStore } from "@netlify/blobs";

const WA_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const WA_BASE  = `https://graph.facebook.com/v21.0/${PHONE_ID}`;

/**
 * Sends a free-text WhatsApp message via Meta Cloud API.
 * 
 * Limitation: Meta requires that the user has sent us a message within
 * the last 24h to allow free-text replies. The agent ALWAYS replies inside
 * that window (since it replies to incoming messages), so this is fine
 * for Sprint 1-3. Proactive outbound (templates) is Sprint 4+.
 * 
 * @param {string} to - Recipient phone in E.164 without + (e.g. "17863001443")
 * @param {string} text - Message body (max 4096 chars)
 * @returns {Promise<{ok: boolean, messageId?: string, error?: string}>}
 */
export async function sendAgentText(to, text) {
  if (!WA_TOKEN || !PHONE_ID) {
    return { ok: false, error: "WA_TOKEN or PHONE_ID env missing" };
  }
  if (!to || !text) {
    return { ok: false, error: "Missing 'to' or 'text'" };
  }

  // Strip leading + if present
  const recipient = String(to).replace(/^\+/, "");

  const body = {
    messaging_product: "whatsapp",
    to: recipient,
    type: "text",
    text: { body: text },
  };

  try {
    const res = await fetch(`${WA_BASE}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error("[agent-send] Meta API error:", JSON.stringify(data));
      return { ok: false, error: data?.error?.message || `HTTP ${res.status}` };
    }
    const messageId = data?.messages?.[0]?.id || null;
    return { ok: true, messageId };
  } catch (err) {
    console.error("[agent-send] fetch error:", err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Records the agent's outbound message into the Blobs store AND Supabase
 * `wa_messages` so the portal Inbox shows the conversation flow.
 * Mirrors the inbound shape used by whatsapp-webhook.js.
 * 
 * Idempotent — if messageId already exists, skips.
 * Best-effort — errors are logged but never thrown.
 */
export async function recordOutboundInBlobs({
  to,
  text,
  messageId,
  clientName = "Liam (agent)",
}) {
  const finalMsgId = messageId || `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tsSeconds = Math.floor(Date.now() / 1000);

  // ── 1) Blobs (legacy, keep for backwards compat) ───────────────────
  try {
    const store = getStore({ name: "wa-messages", consistency: "strong" });
    const existing = (await store.get("messages", { type: "json" })) || [];

    const newMsg = {
      id: finalMsgId,
      from: to,                        // The "from" in inbox view = the other side
      clientName,
      text,
      timestamp: tsSeconds,
      type: "text",
      direction: "outbound",           // Marker for portal to render differently
      sentByAgent: true,
    };

    // Avoid duplicates by messageId
    if (!existing.find((m) => m.id === newMsg.id)) {
      const merged = [...existing, newMsg].slice(-500);
      await store.setJSON("messages", merged);
    }
  } catch (err) {
    console.error("[agent-send] Blobs save error:", err.message);
  }

  // ── 2) Supabase wa_messages (so portal inbox shows this thread) ───
  try {
    const sbUrl = process.env.SUPABASE_URL;
    const sbKey = process.env.SUPABASE_SERVICE_KEY;
    if (sbUrl && sbKey) {
      const row = {
        wa_msg_id:   finalMsgId,
        direction:   "outbound",
        from_number: PHONE_ID || "",
        to_number:   String(to).replace(/^\+/, ""),
        client_name: clientName,
        body:        text,
        msg_type:    "text",
        timestamp:   new Date(tsSeconds * 1000).toISOString(),
        read:        true,    // agent's own messages are inherently "read"
        replied:     false,
      };
      const r = await fetch(`${sbUrl}/rest/v1/wa_messages?on_conflict=wa_msg_id`, {
        method: "POST",
        headers: {
          apikey: sbKey,
          Authorization: `Bearer ${sbKey}`,
          "Content-Type": "application/json",
          Prefer: "resolution=ignore-duplicates,return=minimal",
        },
        body: JSON.stringify(row),
      });
      if (!r.ok) {
        const errText = await r.text().catch(() => "");
        console.error(`[agent-send] Supabase save failed: HTTP ${r.status} ${errText}`);
      }
    }
  } catch (err) {
    console.error("[agent-send] Supabase save error:", err?.message || err);
    // never throw — recording is convenience, not critical
  }
}

/**
 * Convenience: send + record in one call.
 * Returns the send result.
 */
export async function sendAndRecord({ to, text, clientName }) {
  const sendResult = await sendAgentText(to, text);
  if (sendResult.ok) {
    await recordOutboundInBlobs({
      to,
      text,
      messageId: sendResult.messageId,
      clientName,
    });
  }
  return sendResult;
}
