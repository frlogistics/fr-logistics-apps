// netlify/functions/wa-messages.js
// GET  — returns inbox messages from Supabase wa_messages table
// POST — sends WA template or free-text reply, records outbound

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WA_TOKEN     = process.env.WHATSAPP_TOKEN;
const PHONE_ID     = process.env.WHATSAPP_PHONE_ID;
const GRAPH_VER    = process.env.WHATSAPP_GRAPH_VERSION || "v22.0";
const WA_BASE      = `https://graph.facebook.com/${GRAPH_VER}/${PHONE_ID}`;

// ── Normalizacion de telefono  [NEW 2026-07-31] ───────────────────
// Antes se hacia `body.to.replace(/\D/g,"")`, que quita simbolos pero NO
// arregla el codigo de pais. Por eso el mismo contacto quedaba guardado como
// "7867757331" (sin el 1) y como "17867757331", y el inbox lo mostraba como
// dos conversaciones distintas. Caso peor: "117866331807", con el 1 duplicado,
// al que se le enviaron 6 mensajes.
function normalizePhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.length === 12 && d.startsWith("11")) d = d.slice(1);          // 1 duplicado
  if (d.length === 10 && /^[2-9]/.test(d))  d = "1" + d;              // falta el 1
  return d;
}

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

// ── EcoPack+ templates use "es", all others use "en_US" ──────────
const ECOPACK_TEMPLATES = [
  "ecopack_package_received",
  "ecopack_multi_package",
  "ecopack_pickup_scheduled"
];

function getLangCode(type) {
  /* NEW */
  return ECOPACK_TEMPLATES.includes(type) ? "en" : "en_US";
}

// ── Template component builder ────────────────────────────────────
function buildComponents(type, data) {
  const s = v => String(v && v !== "" ? v : "-");
  const templates = {
    order_received: [{ type: "body", parameters: [
      { type: "text", text: s(data.clientName) },
      { type: "text", text: s(data.orderNumber) }
    ]}],
    tracking_update: [{ type: "body", parameters: [
      { type: "text", text: s(data.clientName) },
      { type: "text", text: s(data.orderNumber) },
      { type: "text", text: s(data.trackingNumber) },
      { type: "text", text: s(data.carrier) }
    ]}],
    payment_link: [{ type: "body", parameters: [
      { type: "text", text: s(data.clientName) },
      { type: "text", text: s(data.amount) },
      { type: "text", text: s(data.link) }
    ]}],
    daily_summary: [{ type: "body", parameters: [
      { type: "text", text: s(data.clientName) },
      { type: "text", text: s(data.dateLabel || new Date().toLocaleDateString("en-US")) },
      { type: "text", text: s(data.inbound || "0") },
      { type: "text", text: s(data.outbound || "0") }
    ]}],
    ecopack_package_received: [{ type: "body", parameters: [
      { type: "text", text: s(data.clientName) }
    ]}],
    ecopack_multi_package: [{ type: "body", parameters: [
      { type: "text", text: s(data.clientName) },
      { type: "text", text: s(data.packageCount || data.package_count || "1") }
    ]}],
    ecopack_pickup_scheduled: [{ type: "body", parameters: [
      { type: "text", text: s(data.clientName) },
      { type: "text", text: s(data.date) },
      { type: "text", text: s(data.time) },
      { type: "text", text: s(data.packageCount || data.package_count || "1") }
    ]}]
  };
  return templates[type] || null;
}

function buildPreviewText(type, data) {
  const map = {
    order_received:           `Hi ${data.clientName}, we received your shipment at FR-Logistics Miami. Order #${data.orderNumber}.`,
    tracking_update:          `Hi ${data.clientName}, your order #${data.orderNumber} has been processed. Tracking: ${data.trackingNumber} with ${data.carrier}.`,
    payment_link:             `Hi ${data.clientName}, your FR-Logistics invoice for $${data.amount} is ready. Pay here: ${data.link}.`,
    daily_summary:            `Hi ${data.clientName}, daily summary ${data.dateLabel} — Inbound: ${data.inbound}. Outbound: ${data.outbound}.`,
    ecopack_package_received: `Hola ${data.clientName}, recibimos un paquete para ti en FR-Logistics. Responde PICKUP para agendar o HOURS para ver disponibilidad.`,
    ecopack_multi_package:    `Hola ${data.clientName}, tienes ${data.packageCount || data.package_count || "1"} paquetes esperando en FR-Logistics. Responde PICKUP para consolidar y agendar.`,
    ecopack_pickup_scheduled: `Hola ${data.clientName}, tu pickup EcoPack+ está agendado para ${data.date} a las ${data.time}. Tienes ${data.packageCount || data.package_count || "1"} paquetes listos.`
  };
  return map[type] || "";
}

export default async function handler(req, context) {
  const method = req.method;
  const url    = new URL(req.url);

  // ── GET ?action=media&path=... — redirige a una URL firmada  [NEW] ──
  // El bucket wa-media es PRIVADO (son fotos de clientes: etiquetas, cajas
  // dañadas, documentos). En vez de abrirlo al mundo, esta rama firma la
  // ruta por 1 hora y redirige, para que el <img> del portal funcione solo.
  if (method === "GET" && url.searchParams.get("action") === "media") {
    const path = url.searchParams.get("path") || "";
    if (!path) return new Response("Missing path", { status: 400 });
    try {
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/wa-media/${path}`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ expiresIn: 3600 })
      });
      if (!r.ok) {
        console.error("[wa-messages] sign failed:", r.status, await r.text().catch(() => ""));
        return new Response("Not found", { status: 404 });
      }
      const { signedURL } = await r.json();
      return new Response(null, {
        status: 302,
        headers: { Location: `${SUPABASE_URL}/storage/v1${signedURL}`, "Cache-Control": "private, max-age=3000" }
      });
    } catch (err) {
      console.error("[wa-messages] media error:", err);
      return new Response("Error", { status: 500 });
    }
  }

  // ── GET — return messages ────────────────────────────────────────
  if (method === "GET") {
    try {
      const limit = url.searchParams.get("limit") || "100";
      const phone = normalizePhone(url.searchParams.get("phone") || "");

      let params = `?select=*&order=timestamp.desc&limit=${limit}`;
      if (phone) params += `&or=(from_number.eq.${phone},to_number.eq.${phone})`;

      const messages = await sbSelect("wa_messages", params);

      const mapped = messages.map(m => ({
        id:         m.id,
        wa_msg_id:  m.wa_msg_id,
        direction:  m.direction,
        from:       m.from_number,
        to:         m.to_number,
        clientName: m.client_name,
        text:       m.body,
        type:       m.msg_type,
        timestamp:  Math.floor(new Date(m.timestamp).getTime() / 1000),
        read:       m.read,
        replied:    m.replied,
        // [NEW 2026-07-31] multimedia + marca de numero interno
        mediaPath:  m.media_path  || null,
        mimeType:   m.mime_type   || null,
        caption:    m.caption     || null,
        isInternal: !!m.is_internal
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

  // ── POST ─────────────────────────────────────────────────────────
  if (method === "POST") {
    let body;
    try { body = await req.json(); } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
    }

    // mark_read
    if (body.action === "mark_read" && body.id) {
      await sbPatch("wa_messages", `id=eq.${body.id}`, { read: true });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    }

    // free-text reply
    if (body.action === "reply" && body.to && body.text) {
      const to = normalizePhone(body.to);
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
        if (body.replyToId) {
          await sbPatch("wa_messages", `id=eq.${body.replyToId}`, { replied: true });
        }
      }

      return new Response(JSON.stringify(result), {
        status: waRes.ok ? 200 : 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    // send template
    if (body.type && body.to && body.data) {
      const to         = normalizePhone(body.to);
      const components = buildComponents(body.type, body.data);

      if (!components) {
        return new Response(JSON.stringify({ error: "Unknown template: " + body.type }), { status: 400 });
      }

      const waPayload = {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name:       body.type,
          language:   { code: getLangCode(body.type) },
          components
        }
      };

      console.log("Sending WA template:", JSON.stringify(waPayload));

      const waRes  = await fetch(`${WA_BASE}/messages`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(waPayload)
      });
      const result = await waRes.json();

      console.log("WA response:", JSON.stringify(result));

      if (waRes.ok) {
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
