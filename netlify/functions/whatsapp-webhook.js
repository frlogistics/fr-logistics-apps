// netlify/functions/whatsapp-webhook.js
// Receives inbound WhatsApp messages from Meta Cloud API
//   - Stores in Netlify Blobs (wa-messages store)
//   - Sends email to warehouse@fr-logistics.net via Resend
//   - Dispatches Web Push to all active subscribers
//   - [NEW Sprint 1] Routes to Liam agent for automated responses
//
// ENV required:
//   WHATSAPP_WEBHOOK_SECRET — Meta verify token
//   RESEND_API_KEY          — Resend
//   VAPID_PUBLIC_KEY        — generated VAPID public
//   VAPID_PRIVATE_KEY       — generated VAPID private
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   WHATSAPP_TOKEN          — for agent outbound replies (Meta Cloud API)
//   WHATSAPP_PHONE_ID       — for agent outbound replies

import { getStore } from "@netlify/blobs";
import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";

// [NEW Sprint 1] Liam agent router
import { routeIncomingMessage } from "../functions-helpers/wa-agent-router.js";

const VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_SECRET || "frlogistics_wa_2026";
const RESEND_KEY   = process.env.RESEND_API_KEY;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIV   = process.env.VAPID_PRIVATE_KEY;

if (VAPID_PUBLIC && VAPID_PRIV) {
  webpush.setVapidDetails(
    "mailto:josefuentes@fr-logistics.net",
    VAPID_PUBLIC,
    VAPID_PRIV
  );
}

export default async function handler(req) {
  // ─────────────────────────── GET: Meta webhook verification
  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode      = url.searchParams.get("hub.mode");
    const token     = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return new Response(challenge, { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  // ─────────────────────────── POST: incoming events from Meta
  if (req.method === "POST") {
    let payload;
    try {
      payload = await req.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    const entry   = payload?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;
    const msgs    = value?.messages;
    const contacts = value?.contacts || [];

    // Status updates (delivery/read receipts) — ack and exit
    if (!msgs || msgs.length === 0) {
      return new Response("OK", { status: 200 });
    }

    const store = getStore({ name: "wa-messages", consistency: "strong" });

    // Build inbox records
    const newMessages = [];
    for (const msg of msgs) {
      const from = msg.from;
      const id   = msg.id;
      const ts   = Number(msg.timestamp);
      const text =
        msg.text?.body ||
        msg.button?.text ||
        msg.interactive?.button_reply?.title ||
        msg.interactive?.list_reply?.title ||
        `[${msg.type || "media"}]`;
      const contact = contacts.find((c) => c.wa_id === from);
      const clientName = contact?.profile?.name || from;

      newMessages.push({
        id,
        from,
        clientName,
        text,
        timestamp: ts,
        type: msg.type || "text",
      });
    }

    // 1) Persist to Blobs
    let actuallyNewMessages = [];
    try {
      const existing = (await store.get("messages", { type: "json" })) || [];
      const existingIds = new Set(existing.map((m) => m.id));
      const toAdd = newMessages.filter((m) => !existingIds.has(m.id));
      if (toAdd.length) {
        const merged = [...existing, ...toAdd].slice(-500);
        await store.setJSON("messages", merged);
      }
      actuallyNewMessages = toAdd;  // Only route truly new msgs to agent
    } catch (err) {
      console.error("[webhook] Blobs save error:", err);
      // If Blobs failed, still route to agent based on incoming msgs
      actuallyNewMessages = newMessages;
    }

    // 2) Fan-out: email + push + [NEW] agent (don't block the 200 to Meta)
    await notifyOutOfBand(newMessages, actuallyNewMessages).catch((e) =>
      console.error("[webhook] notify error:", e)
    );

    return new Response("OK", { status: 200 });
  }

  return new Response("Method Not Allowed", { status: 405 });
}

// ───────────────────────────────── Out-of-band notifications
async function notifyOutOfBand(messages, agentMessages) {
  if (!messages?.length) return;
  console.log('[webhook] notifyOutOfBand: ' + messages.length + ' messages, ' + (agentMessages?.length || 0) + ' for agent');
  await Promise.allSettled([
    sendEmail(messages).catch(e => console.error('[webhook] email error:', e?.message || e)),
    sendPush(messages).catch(e => console.error('[webhook] push error:', e?.message || e)),
    // [NEW Sprint 1] Route to Liam agent
    routeToAgent(agentMessages || messages).catch(e => console.error('[webhook] agent error:', e?.message || e)),
  ]);
}

// [NEW Sprint 1] Loop over new messages and route each to the agent.
// Errors per-message are swallowed so one bad message doesn't block others.
async function routeToAgent(messages) {
  if (!messages?.length) return;
  for (const msg of messages) {
    try {
      await routeIncomingMessage(msg);
    } catch (err) {
      console.error('[webhook] agent route error for msg ' + msg.id + ':', err?.message || err);
    }
  }
}

async function sendEmail(messages) {
  if (!RESEND_KEY) { console.log('[webhook] no RESEND_KEY, skipping email'); return; }
  const subject = '[WA Inbox] ' + messages.length + ' new from ' + messages[0].clientName;
  const html = '<h2>New WhatsApp messages</h2>' + messages.map(m => '<div style=\"margin:12px 0;padding:12px;border:1px solid #e5e7eb;border-radius:6px;font:14px Arial\"><strong>' + escapeHtml(m.clientName) + '</strong>&nbsp;+' + escapeHtml(m.from) + '<div style=\"margin-top:6px\">' + escapeHtml(m.text) + '</div></div>').join('') + '<p><a href=\"https://apps.fr-logistics.net/portal.html#wa-inbox\">Open inbox</a></p>';
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'FR-Logistics WA <noreply@fr-logistics.net>', to: ['warehouse@fr-logistics.net', 'josefuentes@fr-logistics.net'], subject, html }) });
  console.log('[webhook] Resend response: ' + r.status);
}

async function sendPush(messages) {
  if (!VAPID_PUBLIC || !VAPID_PRIV) { console.log('[webhook] no VAPID, skipping push'); return; }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const { data: subs, error } = await supabase.from('wa_push_subscriptions').select('endpoint,p256dh,auth').eq('active', true);
  if (error) { console.error('[webhook] supabase err:', error.message); return; }
  if (!subs?.length) { console.log('[webhook] no active subscriptions'); return; }
  console.log('[webhook] dispatching push to ' + subs.length + ' subscribers');
  const first = messages[0];
  const payload = JSON.stringify({ title: messages.length === 1 ? first.clientName : first.clientName + ' +' + (messages.length - 1) + ' more', body: first.text.slice(0, 140), tag: 'wa-inbox', url: 'https://apps.fr-logistics.net/portal.html#wa-inbox', icon: 'https://fr-logistics.net/wp-content/uploads/2024/03/favicon-196x196.png' });
  const dead = []; let ok = 0;
  await Promise.all(subs.map(async s => { try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600 }); ok++; } catch (err) { const code = err?.statusCode; if (code === 404 || code === 410) { dead.push(s.endpoint); } else { console.error('[webhook] push send err code=' + code + ' body=' + (err?.body || err?.message)); } } }));
  console.log('[webhook] push: ' + ok + '/' + subs.length + ' delivered, ' + dead.length + ' dead');
  if (dead.length) { await supabase.from('wa_push_subscriptions').update({ active: false }).in('endpoint', dead); }
}
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
