// wa-messages.js — FR-Logistics WhatsApp sender (+1 305-240-3172)
const PHONE_ID = Netlify.env.get("WHATSAPP_PHONE_ID");
const TOKEN = Netlify.env.get("WHATSAPP_TOKEN");

async function sendWA(payload) {
  const res = await fetch(`https://graph.facebook.com/v20.0/${PHONE_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  try {
    const { type, to, data } = await req.json();
    let params = [], templateName = "";
    switch (type) {
      case "order_received":
        templateName = "order_received";
        params = [data.clientName, data.orderNumber];
        break;
      case "tracking_update":
        templateName = "tracking_update";
        params = [data.clientName, data.orderNumber, data.trackingNumber, data.carrier];
        break;
      case "payment_link":
        templateName = "payment_link";
        params = [data.clientName, data.amount, data.link];
        break;
      case "daily_summary":
        templateName = "daily_summary";
        params = [data.clientName, data.dateLabel, String(data.inbound), String(data.outbound)];
        break;
      default:
        return new Response(JSON.stringify({ error: "Unknown type: " + type }), { status: 400 });
    }
    const result = await sendWA({
      messaging_product: "whatsapp", to, type: "template",
      template: {
        name: templateName, language: { code: "en_US" },
        components: [{ type: "body", parameters: params.map(text => ({ type: "text", text })) }],
      },
    });
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
