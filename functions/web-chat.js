// netlify/functions/web-chat.js
//
// CANAL 'web' — el gemelo de whatsapp-webhook.js para el chat del sitio.
//
// POST  { session_id, text, lang?, page? }  -> { ok, messages:[...] }
// GET   ?session_id=<id>&after=<iso>        -> { ok, messages:[...] }
//
// El GET existe porque la respuesta no siempre es sincronica: cuando un
// humano toma el hilo desde portal.html, el mensaje sale del inbox y el
// widget lo recoge sondeando. Misma tabla, mismo inbox, mismo LIAM.
//
// Direccion del canal: "web:<session_id>". parseAddress() en wa-agent-db.js
// es el unico lugar que interpreta ese formato.
//
// NO agrega variables de entorno: usa SUPABASE_URL, SUPABASE_SERVICE_KEY y
// (indirectamente, via wa-agent-llm.js) ANTHROPIC_API_KEY, las tres ya
// configuradas en el sitio. El techo de 4 KB de Lambda queda igual.

import { routeIncomingMessage } from "./_agent-helpers/wa-agent-router.js";
import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";
import {
  recordInboundMessage,
  getChannelMessages,
  getLastConversationAny,
  attachOrphanMessages,
  countRecentInbound,
  formatAddress,
} from "./_agent-helpers/wa-agent-db.js";

// ─────────────────────────────────────────────────────────────────────
// CORS — mismos origenes que las funciones portal-*
// ─────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  "https://fr-logistics.net",
  "https://www.fr-logistics.net",
  "https://apps.fr-logistics.net",
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(origin),
  });
}

// ─────────────────────────────────────────────────────────────────────
// LIMITES
//
// Este endpoint es publico y sin sesion: cualquiera puede llamarlo desde
// una consola. Los topes de abajo son lo que impide que un bucle gaste la
// cuota de la API de Anthropic o llene wa_messages.
// ─────────────────────────────────────────────────────────────────────
const MAX_TEXT_LEN = 2000;
const RATE_WINDOW_MS = 60 * 60 * 1000;   // 1 hora
const RATE_MAX_MESSAGES = 40;            // por sesion y hora
const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/;

export default async function handler(req) {
  const origin = req.headers.get("origin") || "";

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  try {
    if (req.method === "GET") return await handleGet(req, origin);
    if (req.method === "POST") return await handlePost(req, origin);
    return json({ ok: false, error: "method not allowed" }, 405, origin);
  } catch (err) {
    // Igual que el router: esta funcion nunca revienta hacia el visitante.
    console.error("[web-chat] uncaught:", err?.message || err);
    return json({ ok: false, error: "internal error" }, 500, origin);
  }
}

// ─────────────────────────────────────────────────────────────────────
// GET — sondeo del widget
// ─────────────────────────────────────────────────────────────────────
async function handleGet(req, origin) {
  const url = new URL(req.url);
  const sessionId = (url.searchParams.get("session_id") || "").trim();
  const after = (url.searchParams.get("after") || "").trim();

  if (!SESSION_RE.test(sessionId)) {
    return json({ ok: false, error: "invalid session_id" }, 400, origin);
  }
  if (after && !ISO_RE.test(after)) {
    return json({ ok: false, error: "invalid after" }, 400, origin);
  }

  const address = formatAddress("web", sessionId);
  const messages = await getChannelMessages(address, {
    after: after || null,
    direction: "outbound",
  });

  return json({ ok: true, messages }, 200, origin);
}

// ─────────────────────────────────────────────────────────────────────
// POST — mensaje del visitante
// ─────────────────────────────────────────────────────────────────────
async function handlePost(req, origin) {
  let payload;
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, 400, origin);
  }

  const sessionId = String(payload?.session_id || "").trim();
  const text = String(payload?.text || "").trim();
  const page = String(payload?.page || "").slice(0, 200);

  if (!SESSION_RE.test(sessionId)) {
    return json({ ok: false, error: "invalid session_id" }, 400, origin);
  }
  if (!text) {
    return json({ ok: false, error: "empty message" }, 400, origin);
  }
  if (text.length > MAX_TEXT_LEN) {
    return json({ ok: false, error: "message too long" }, 413, origin);
  }

  const address = formatAddress("web", sessionId);

  // Tope por sesion. Se responde 200 con un aviso en vez de 429 seco para
  // que el visitante lea algo util en el widget en lugar de un error.
  const recent = await countRecentInbound(address, RATE_WINDOW_MS);
  if (recent >= RATE_MAX_MESSAGES) {
    console.warn(`[web-chat] rate limit hit for ${address} (${recent} msgs/h)`);
    return json(
      {
        ok: true,
        messages: [
          {
            id: `rate-${Date.now()}`,
            direction: "in",
            body:
              "Hemos alcanzado el límite de mensajes de esta sesión. " +
              "Escríbenos a info@fr-logistics.net y seguimos por ahí. / " +
              "We've hit this session's message limit. Email info@fr-logistics.net and we'll continue there.",
            ts: new Date().toISOString(),
          },
        ],
      },
      200,
      origin
    );
  }

  // Marca de corte: todo lo saliente posterior a este instante es la
  // respuesta a ESTE mensaje. Se toma ANTES de enrutar.
  const since = new Date().toISOString();

  // 1. Persistir el entrante. Se hace primero para que, si el router falla,
  //    el mensaje del visitante igual quede en el inbox y un humano lo vea.
  const prior = await getLastConversationAny(address);
  const inbound = await recordInboundMessage({
    address,
    text,
    clientName: prior?.captured_name || "Web visitor",
    conversationId: prior?.id || null,
  });
  if (!inbound) {
    return json({ ok: false, error: "could not persist message" }, 500, origin);
  }
  if (page) console.log(`[web-chat] ${address} desde ${page}`);

  // 2. Enrutar por LIAM. El router decide, envia (escribiendo filas
  //    salientes por sendWebOutbound) y actualiza la conversacion.
  await routeIncomingMessage({
    from: address,
    text,
    clientName: prior?.captured_name || "Web visitor",
    id: inbound.wa_msg_id,
  });

  // 3. Colgar de la conversacion las filas que quedaron sueltas — el
  //    entrante se guardo antes de que el router creara la conversacion.
  const conv = await getLastConversationAny(address);
  if (conv?.id) await attachOrphanMessages(address, conv.id);

  // 4. Devolver lo que LIAM produjo en esta vuelta.
  const messages = await getChannelMessages(address, {
    after: since,
    direction: "outbound",
  });

  // 5. Avisar a Jose. Solo en los dos momentos que importan: cuando se abre
  //    una conversacion nueva, y cuando LIAM se queda callado (conversacion
  //    pausada o escalada) — que es justo cuando hace falta un humano.
  //    Sin esta condicion, cada turno de cada chat dispararia una push.
  const isNewSession = !prior;
  const agentSilent = messages.length === 0;
  if (isNewSession || agentSilent) {
    await notify({
      sessionId,
      text,
      name: conv?.captured_name || "Web visitor",
      reason: agentSilent ? "needs_human" : "new_session",
      page,
    }).catch((e) => console.error("[web-chat] notify failed:", e?.message || e));
  }

  return json({ ok: true, messages }, 200, origin);
}

// ─────────────────────────────────────────────────────────────────────
// NOTIFICACIONES
//
// whatsapp-webhook.js dispara Web Push + correo por cada entrante de
// WhatsApp. El canal web no pasa por ese webhook, asi que sin esto un
// visitante del sitio solo se veria si alguien mira el inbox a tiempo.
// Reusa VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / RESEND_API_KEY, las mismas
// que ya usa el webhook — no agrega ninguna variable de entorno.
// ─────────────────────────────────────────────────────────────────────

const INBOX_URL = "https://apps.fr-logistics.net/portal.html#wa-inbox";

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

async function notify({ sessionId, text, name, reason, page }) {
  const label = reason === "needs_human" ? "needs a human" : "new web chat";
  await Promise.all([
    sendPush({ name, text, label }),
    sendNotifyEmail({ sessionId, text, name, label, page }),
  ]);
}

async function sendPush({ name, text, label }) {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    console.log("[web-chat] no VAPID, skipping push");
    return;
  }
  webpush.setVapidDetails("mailto:info@fr-logistics.net", pub, priv);

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );
  const { data: subs, error } = await supabase
    .from("wa_push_subscriptions")
    .select("endpoint,p256dh,auth")
    .eq("active", true);

  if (error) {
    console.error("[web-chat] push subs error:", error.message);
    return;
  }
  if (!subs?.length) return;

  const payload = JSON.stringify({
    title: `🌐 ${name} — ${label}`,
    body: String(text).slice(0, 140),
    tag: "wa-inbox",
    url: INBOX_URL,
    icon: "https://fr-logistics.net/assets/Fr-Logistics_Icon.png",
  });

  const dead = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
          { TTL: 3600 }
        );
      } catch (err) {
        const code = err?.statusCode;
        if (code === 404 || code === 410) dead.push(s.endpoint);
        else console.error("[web-chat] push err code=" + code);
      }
    })
  );
  // Misma limpieza que el webhook: una suscripcion muerta se desactiva sola.
  if (dead.length) {
    await supabase
      .from("wa_push_subscriptions")
      .update({ active: false })
      .in("endpoint", dead);
  }
}

async function sendNotifyEmail({ sessionId, text, name, label, page }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;

  const html =
    `<h2>Web chat — ${escapeHtml(label)}</h2>` +
    `<div style="margin:12px 0;padding:12px;border:1px solid #e5e7eb;border-radius:6px;font:14px Arial">` +
    `<strong>${escapeHtml(name)}</strong><div style="margin-top:6px">${escapeHtml(text)}</div>` +
    `<div style="margin-top:8px;color:#64748b;font-size:12px">` +
    `Sesión: ${escapeHtml(sessionId)}${page ? ` · Página: ${escapeHtml(page)}` : ""}</div></div>` +
    `<p><a href="${INBOX_URL}">Abrir el inbox</a></p>`;

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "FR-Logistics Web <noreply@fr-logistics.net>",
        to: ["warehouse@fr-logistics.net", "josefuentes@fr-logistics.net"],
        subject: `[Web Chat] ${label} — ${name}`,
        html,
      }),
    });
    console.log("[web-chat] Resend response: " + r.status);
  } catch (e) {
    console.error("[web-chat] email error:", e?.message || e);
  }
}
