// inventory-alert.js — FR-Logistics Inventory Alert
// Runs daily at 9PM UTC (5PM EST)
// Template: order_received re-used as alert, or direct message
const PHONE_ID = Netlify.env.get("WHATSAPP_PHONE_ID");
const TOKEN = Netlify.env.get("WHATSAPP_TOKEN");
const ALERT_NUMBER = Netlify.env.get("ALERT_PHONE") || "13052403172";
const SKUVAULT_TOKEN = Netlify.env.get("SKUVAULT_TENANT_TOKEN");

async function getInventory() {
  const res = await fetch("https://app.skuvault.com/api/inventory/getInventory", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ TenantToken: SKUVAULT_TOKEN, UserToken: SKUVAULT_TOKEN }),
  });
  return res.json();
}

async function sendAlert(to, message) {
  const res = await fetch(`https://graph.facebook.com/v20.0/${PHONE_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: "daily_summary",
        language: { code: "en_US" },
        components: [{
          type: "body",
          parameters: [
            { type: "text", text: "FR-Logistics Ops" },
            { type: "text", text: "Inventory Alert" },
            { type: "text", text: message },
            { type: "text", text: "Check dashboard" },
          ],
        }],
      },
    }),
  });
  return res.json();
}

export default async (req) => {
  try {
    const inv = await getInventory();
    const items = inv.Items || [];
    const lowStock = items.filter(i => i.QuantityAvailable < 10 && i.QuantityAvailable >= 0);

    if (lowStock.length === 0) {
      console.log("No low stock items today");
      return;
    }

    const summary = `${lowStock.length} SKU(s) low stock`;
    const result = await sendAlert(ALERT_NUMBER, summary);
    console.log("Inventory alert sent:", JSON.stringify(result));
  } catch (err) {
    console.error("Inventory alert error:", err.message);
  }
};

export const config = {
  schedule: "0 21 * * *",
};
