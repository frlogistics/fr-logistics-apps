const SUPA_URL = "https://rijbschnchjiuggrhfrx.supabase.co";
const SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJpamJzY2huY2hqaXVnZ3JoZnJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzMTQwOTQsImV4cCI6MjA4ODg5MDA5NH0.s3T4CStjWqOvz7qDpYtjt0yVJ0iyOMAKKwxkADSEs4s";
const RESEND_KEY = "re_aYwqDPhY_HyjPCpFEH1t8ZMaygzTgr1kF";
const VERIFY_TOKEN = "frlogistics_wa_2026";

// ─── Language Detection ───────────────────────────────────────────────────────
function detectLang(text) {
  const esWords = /\b(donde|está|orden|rastreo|seguimiento|inventario|stock|ayuda|urgente|hola|gracias|necesito|tengo|mi|tu|su)\b/i;
  return esWords.test(text) ? "es" : "en";
}

// ─── Message Classification ───────────────────────────────────────────────────
function classify(text) {
  const t = text.toLowerCase();
  if (/track|tracking|where.*order|order.*status|rastr|seguimiento|donde.*orden|estado.*orden/.test(t)) return "tracking";
  if (/stock|inventory|units|disponible|inventario|unidades|hay/.test(t)) return "inventory";
  if (/urgent|help|problem|issue|emergency|urgente|ayuda|problema|emergencia/.test(t)) return "escalate";
  if (/thank|thanks|gracias|ok|okay|perfect|perfecto|received|recibido/.test(t)) return "ignore";
  return "unknown";
}

// ─── ShipStation lookup by phone ─────────────────────────────────────────────
async function findOrdersByPhone(phone) {
  const key = process.env.SS_API_KEY;
  const secret = process.env.SS_API_SECRET;
  if (!key || !secret) return null;

  const auth = Buffer.from(`${key}:${secret}`).toString("base64");
  // Clean phone — remove + and country code
  const clean = phone.replace(/\D/g, "").replace(/^1/, "");

  const res = await fetch(`https://ssapi.shipstation.com/orders?customerPhone=${clean}&orderStatus=awaiting_shipment,shipped&pageSize=5`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.orders || [];
}

// ─── SkuVault inventory check ─────────────────────────────────────────────────
async function getLowStockCount() {
  const raw = process.env.SKUVAULT_TENANT_TOKEN || "";
  const [tenantToken, userToken] = raw.split("|");
  if (!tenantToken) return null;

  const res = await fetch("https://app.skuvault.com/api/products/getProducts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ TenantToken: tenantToken, UserToken: userToken, PageNumber: 0, PageSize: 1000 })
  });
  if (!res.ok) return null;
  const data = await res.json();
  const products = data.Products || [];
  const low = products.filter(p => (p.QuantityAvailable ?? 0) <= (p.ReorderPoint ?? 0) && (p.ReorderPoint ?? 0) > 0);
  return { total: products.length, low: low.length };
}

// ─── Send WhatsApp reply ──────────────────────────────────────────────────────
async function sendWA(to, text) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } })
  });
}

// ─── Send email notification ──────────────────────────────────────────────────
async function notifyEmail(from, name, message, type) {
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "FR-Logistics System <warehouse@fr-logistics.net>",
      to: ["warehouse@fr-logistics.net"],
      subject: "Check this Order",
      text: `New WhatsApp message requires attention.\n\nFrom: ${name || from} (${from})\nType: ${type}\nMessage: "${message}"\n\nReply via portal: https://apps.fr-logistics.net/portal.html`
    })
  });
}

// ─── Save message to Supabase ─────────────────────────────────────────────────
async function saveMessage(msg) {
  await fetch(`${SUPA_URL}/rest/v1/wa_messages`, {
    method: "POST",
    headers: {
      apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
      "Content-Type": "application/json", Prefer: "return=minimal"
    },
    body: JSON.stringify(msg)
  });
}

// ─── Main handler ─────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  // Webhook verification
  if (event.httpMethod === "GET") {
    const params = event.queryStringParameters || {};
    if (params["hub.verify_token"] === VERIFY_TOKEN) {
      return { statusCode: 200, body: params["hub.challenge"] };
    }
    return { statusCode: 403, body: "Forbidden" };
  }

  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  try {
    const body = JSON.parse(event.body || "{}");
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value?.messages?.length) return { statusCode: 200, body: "ok" };

    for (const msg of value.messages) {
      if (msg.type !== "text") continue;

      const from = msg.from;
      const text = msg.text?.body || "";
      const name = value.contacts?.[0]?.profile?.name || from;
      const lang = detectLang(text);
      const type = classify(text);
      const timestamp = new Date().toISOString();

      console.log(`[webhook] From: ${from} | Type: ${type} | Lang: ${lang} | Text: ${text}`);

      // Save to Supabase
      await saveMessage({
        id: msg.id,
        direction: "inbound",
        from,
        client_name: name,
        text,
        type,
        lang,
        timestamp,
        read: false
      }).catch(e => console.error("Save error:", e.message));

      // Handle by type
      if (type === "tracking") {
        const orders = await findOrdersByPhone(from).catch(() => null);

        let reply;
        if (orders && orders.length > 0) {
          const o = orders[0];
          const tracking = o.shipments?.[0]?.trackingNumber || "N/A";
          const carrier = o.shipments?.[0]?.carrierCode?.toUpperCase() || "N/A";
          const status = o.orderStatus || "N/A";

          if (lang === "es") {
            reply = `📦 Hola ${name}!\n\nEstado de tu orden: ${status}\nCarrier: ${carrier}\nTracking: ${tracking}\n\nPara más detalles contacta a warehouse@fr-logistics.net`;
          } else {
            reply = `📦 Hi ${name}!\n\nOrder status: ${status}\nCarrier: ${carrier}\nTracking: ${tracking}\n\nFor more details contact warehouse@fr-logistics.net`;
          }
        } else {
          if (lang === "es") {
            reply = `📦 Hola ${name}! No encontramos órdenes asociadas a tu número. Por favor contáctanos en warehouse@fr-logistics.net con tu número de orden.`;
          } else {
            reply = `📦 Hi ${name}! We couldn't find orders associated with your number. Please contact warehouse@fr-logistics.net with your order number.`;
          }
        }
        await sendWA(from, reply).catch(e => console.error("WA error:", e.message));

      } else if (type === "inventory") {
        const inv = await getLowStockCount().catch(() => null);
        let reply;
        if (lang === "es") {
          reply = `📊 Hola ${name}! Para consultas de inventario específicas, por favor contacta a warehouse@fr-logistics.net con el SKU o producto que necesitas verificar.`;
        } else {
          reply = `📊 Hi ${name}! For specific inventory inquiries, please contact warehouse@fr-logistics.net with the SKU or product you need to check.`;
        }
        await sendWA(from, reply).catch(e => console.error("WA error:", e.message));
        await notifyEmail(from, name, text, type).catch(e => console.error("Email error:", e.message));

      } else if (type === "escalate") {
        let reply;
        if (lang === "es") {
          reply = `⚡ Hola ${name}! Tu mensaje urgente fue recibido. Nuestro equipo te contactará en breve. También puedes llamarnos al +1 (786) 300-1443.`;
        } else {
          reply = `⚡ Hi ${name}! Your urgent message was received. Our team will contact you shortly. You can also call us at +1 (786) 300-1443.`;
        }
        await sendWA(from, reply).catch(e => console.error("WA error:", e.message));
        await notifyEmail(from, name, text, "URGENT").catch(e => console.error("Email error:", e.message));

      } else if (type === "ignore") {
        // Log only, no reply needed
        console.log(`[webhook] Ignoring courtesy message from ${from}`);

      } else {
        // Unknown — save to inbox and notify
        let reply;
        if (lang === "es") {
          reply = `👋 Hola ${name}! Gracias por contactar a FR-Logistics Miami. Tu mensaje fue recibido y te responderemos pronto. Para atención inmediata llama al +1 (786) 300-1443.`;
        } else {
          reply = `👋 Hi ${name}! Thanks for contacting FR-Logistics Miami. Your message was received and we'll get back to you soon. For immediate assistance call +1 (786) 300-1443.`;
        }
        await sendWA(from, reply).catch(e => console.error("WA error:", e.message));
        await notifyEmail(from, name, text, "General inquiry").catch(e => console.error("Email error:", e.message));
      }
    }

    return { statusCode: 200, body: "ok" };
  } catch(e) {
    console.error("[webhook] Fatal:", e.message);
    return { statusCode: 200, body: "ok" }; // Always return 200 to Meta
  }
};
