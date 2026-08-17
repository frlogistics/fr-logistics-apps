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
import { routeIncomingMessage } from "./_agent-helpers/wa-agent-router.js";

// No fallback. This repo is public, so a hardcoded default is a published
// password: anyone who reads the code could complete Meta's verification
// handshake if the env var ever went missing. With the fallback gone, a
// missing variable fails the handshake loudly instead of passing quietly.
const VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_SECRET || "";
const RESEND_KEY   = process.env.RESEND_API_KEY;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIV   = process.env.VAPID_PRIVATE_KEY;

// Numeros propios de FR-Logistics. Un mensaje entrante desde cualquiera de
// estos NO es un cliente: normalmente es el auto-reply de nuestra propia
// infraestructura (la app del 786 contestandole al daily summary).
//
// CAMBIO 2026-07-31: antes se descartaban por completo con `continue`, lo que
// hacia IMPOSIBLE probar el sistema desde un telefono propio — cada prueba
// desaparecia en silencio y devolvia un falso negativo. Ahora se PERSISTEN
// (se ven en el inbox, marcados is_internal) pero NO se enrutan al agente,
// que es lo unico que realmente causaba bucles.
const FR_OWN_NUMBERS = new Set(
  (process.env.FR_OWN_NUMBERS || "17863001443,13052403172,17867757335")
    .split(",")
    .map((n) => n.trim().replace(/[^0-9]/g, ""))
    .filter(Boolean)
);

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
    if (!VERIFY_TOKEN) {
      console.error("[whatsapp-webhook] WHATSAPP_WEBHOOK_SECRET is not set — refusing to verify");
      return new Response("Forbidden", { status: 403 });
    }
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return new Response(challenge, { status: 200 });
    }
    console.warn("[whatsapp-webhook] verification refused (mode/token mismatch)");
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

      // Guard: los numeros propios se guardan pero NO se enrutan al agente.
      // Asi se corta el loop 305 <-> 786 sin volver invisible el mensaje.
      const isInternal = FR_OWN_NUMBERS.has(String(from || "").replace(/[^0-9]/g, ""));
      if (isInternal) {
        console.log("[webhook] Numero propio (se guarda, no se enruta): " + from);
      }

      const id   = msg.id;
      const ts   = Number(msg.timestamp);

      // Multimedia: Meta manda un objeto por tipo con { id, mime_type, caption? }.
      // Antes solo se guardaba el marcador "[image]" y se perdian el archivo Y
      // el texto que el cliente escribia junto a la foto.
      const mediaObj =
        msg.image || msg.audio || msg.video ||
        msg.document || msg.sticker || msg.voice || null;
      const mediaId  = mediaObj?.id || null;
      const mimeType = mediaObj?.mime_type || null;
      const caption  = mediaObj?.caption || null;

      const text =
        msg.text?.body ||
        msg.button?.text ||
        msg.interactive?.button_reply?.title ||
        msg.interactive?.list_reply?.title ||
        caption ||                                  // el caption vale mas que el marcador
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
        mediaId,
        mimeType,
        caption,
        isInternal,
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

    // 1b) ALSO persist to Supabase wa_messages so the portal inbox can see them.
    // Without this, the portal only shows outbound messages and old Blobs data.
    // Each message is upsert'd by wa_msg_id (UNIQUE) so re-deliveries from Meta
    // don't create duplicates.
    try {
      const phoneId = value?.metadata?.phone_number_id || process.env.WHATSAPP_PHONE_ID || "";
      const rowsToInsert = newMessages.map(m => ({
        wa_msg_id:   m.id,
        direction:   "inbound",
        from_number: m.from,
        to_number:   phoneId,
        client_name: m.clientName,
        body:        m.text,
        msg_type:    m.type || "text",
        timestamp:   new Date(m.timestamp * 1000).toISOString(),
        read:        false,
        replied:     false,
        media_id:    m.mediaId  || null,
        mime_type:   m.mimeType || null,
        caption:     m.caption  || null,
        is_internal: !!m.isInternal,
      }));

      if (rowsToInsert.length) {
        const sbUrl = process.env.SUPABASE_URL;
        const sbKey = process.env.SUPABASE_SERVICE_KEY;
        if (sbUrl && sbKey) {
          const r = await fetch(`${sbUrl}/rest/v1/wa_messages?on_conflict=wa_msg_id`, {
            method: "POST",
            headers: {
              apikey: sbKey,
              Authorization: `Bearer ${sbKey}`,
              "Content-Type": "application/json",
              Prefer: "resolution=ignore-duplicates,return=minimal",
            },
            body: JSON.stringify(rowsToInsert),
          });
          if (!r.ok) {
            const errText = await r.text().catch(() => "");
            console.error(`[webhook] Supabase wa_messages insert failed: HTTP ${r.status} ${errText}`);
          } else {
            console.log(`[webhook] Saved ${rowsToInsert.length} inbound msg(s) to wa_messages`);
          }
        } else {
          console.error("[webhook] SUPABASE_URL or SUPABASE_SERVICE_KEY missing — cannot save to wa_messages");
        }
      }
    } catch (err) {
      console.error("[webhook] Supabase wa_messages save error:", err?.message || err);
      // Non-fatal — don't block the 200 to Meta
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
    routeToAgent((agentMessages || messages).filter(m => !m.isInternal))
      .catch(e => console.error('[webhook] agent error:', e?.message || e)),
    downloadMedia(messages).catch(e => console.error('[webhook] media error:', e?.message || e)),
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
  const payload = JSON.stringify({ title: messages.length === 1 ? first.clientName : first.clientName + ' +' + (messages.length - 1) + ' more', body: first.text.slice(0, 140), tag: 'wa-inbox', url: 'https://apps.fr-logistics.net/portal.html#wa-inbox', icon: 'https://fr-logistics.net/assets/Fr-Logistics_Icon.png' });
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

// ───────────────────────────────── Media download  [NEW 2026-07-31]
// Meta only hands us a media ID. To keep the actual file we must:
//   1) GET /{media-id}          -> a short-lived download URL
//   2) GET that URL             -> the bytes (same Bearer token required)
//   3) upload to Supabase Storage and record the path on the message row
//
// Meta retains media for a limited window and the URL expires within
// minutes, so this has to happen now — there is no going back for it later.
// Every image, audio and document received before this date is gone.
const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || "v22.0";
const MEDIA_BUCKET  = "wa-media";

const EXT_BY_MIME = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac",
  "video/mp4": "mp4", "video/3gpp": "3gp",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

function extFor(mime) {
  if (!mime) return "bin";
  const clean = String(mime).split(";")[0].trim().toLowerCase();
  return EXT_BY_MIME[clean] || clean.split("/")[1] || "bin";
}

async function downloadMedia(messages) {
  const withMedia = (messages || []).filter((m) => m.mediaId);
  if (!withMedia.length) return;

  const token = process.env.WHATSAPP_TOKEN;
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (!token || !sbUrl || !sbKey) {
    console.error("[webhook] media: missing WHATSAPP_TOKEN / SUPABASE creds, skipping");
    return;
  }

  console.log(`[webhook] media: downloading ${withMedia.length} file(s)`);

  for (const m of withMedia) {
    try {
      // 1) media id -> temporary URL
      const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${m.mediaId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!metaRes.ok) {
        console.error(`[webhook] media meta failed ${m.mediaId}: HTTP ${metaRes.status}`);
        continue;
      }
      const meta = await metaRes.json();
      if (!meta?.url) {
        console.error(`[webhook] media meta had no url for ${m.mediaId}`);
        continue;
      }

      // 2) fetch the bytes (Meta requires the token on this call too)
      const binRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
      if (!binRes.ok) {
        console.error(`[webhook] media bytes failed ${m.mediaId}: HTTP ${binRes.status}`);
        continue;
      }
      const bytes = Buffer.from(await binRes.arrayBuffer());
      const mime  = meta.mime_type || m.mimeType || "application/octet-stream";
      const path  = `${m.from}/${m.id}.${extFor(mime)}`;

      // 3) store it
      const upRes = await fetch(`${sbUrl}/storage/v1/object/${MEDIA_BUCKET}/${path}`, {
        method: "POST",
        headers: {
          apikey: sbKey,
          Authorization: `Bearer ${sbKey}`,
          "Content-Type": mime,
          "x-upsert": "true",
        },
        body: bytes,
      });
      if (!upRes.ok) {
        const t = await upRes.text().catch(() => "");
        console.error(`[webhook] media upload failed ${path}: HTTP ${upRes.status} ${t}`);
        continue;
      }

      // 4) record the path on the message row
      await fetch(`${sbUrl}/rest/v1/wa_messages?wa_msg_id=eq.${encodeURIComponent(m.id)}`, {
        method: "PATCH",
        headers: {
          apikey: sbKey,
          Authorization: `Bearer ${sbKey}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ media_path: path, mime_type: mime }),
      });

      console.log(`[webhook] media saved: ${path} (${bytes.length} bytes)`);
    } catch (err) {
      console.error(`[webhook] media error for ${m.mediaId}:`, err?.message || err);
    }
  }
}
