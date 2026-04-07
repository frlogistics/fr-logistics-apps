// netlify/functions/inventory-alert.js
// Scheduled daily at 9PM UTC (5PM EST)
// Gets KPIs from inventory function → sends via inventory_alert WA template

const WA_TOKEN     = Netlify.env.get("WHATSAPP_TOKEN");
const PHONE_ID     = Netlify.env.get("WHATSAPP_PHONE_ID");
const ALERT_NUMBER = Netlify.env.get("ALERT_PHONE") || "17863001443";
const SITE_URL     = Netlify.env.get("URL") || "https://apps.fr-logistics.net";
const WA_BASE      = `https://graph.facebook.com/v21.0/${PHONE_ID}/messages`;

// Template: inventory_alert (UTILITY, en, APPROVED)
// Body: "Hi {{1}}, here is your FR-Logistics inventory alert for {{2}}:
//        OK (above reorder point): {{3}} SKUs
//        Needs Reorder: {{4}} SKUs
//        Out of Stock: {{5}} SKUs
//        Total tracked: {{6}} SKUs. Full detail: apps.fr-logistics.net/dashboard-inventory.html"

export default async function handler(req) {
  console.log("[inventory-alert] Starting at", new Date().toISOString());

  try {
    // 1. Get inventory KPIs from the inventory function (calls SKUVault)
    const invRes = await fetch(`${SITE_URL}/.netlify/functions/inventory`);
    if (!invRes.ok) throw new Error(`inventory fn error: ${invRes.status}`);
    const inv = await invRes.json();

    const { kpis, skus = [] } = inv;
    const total      = kpis.totalSKUs     || skus.length;
    const outOfStock = kpis.outOfStock    || 0;
    const lowStock   = kpis.reorderAlerts || kpis.lowStock || 0;
    const okCount    = total - outOfStock - lowStock;
    const totalUnits = kpis.totalUnits    || 0;

    console.log("[inventory-alert] KPIs:", { total, outOfStock, lowStock, okCount });

    // Skip if everything is fine
    if (outOfStock === 0 && lowStock === 0) {
      console.log("[inventory-alert] All OK — no alert needed");
      return new Response(JSON.stringify({ ok: true, message: "All stock OK" }), { status: 200 });
    }

    const today = new Date().toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      month: "short", day: "numeric", year: "numeric"
    });

    // 2. Send via inventory_alert template
    const waRes = await fetch(WA_BASE, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WA_TOKEN}`,
        "Content-Type":  "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to:   ALERT_NUMBER,
        type: "template",
        template: {
          name:     "inventory_alert",
          language: { code: "en" },
          components: [{
            type: "body",
            parameters: [
              { type: "text", text: "FR-Logistics Team" },
              { type: "text", text: today },
              { type: "text", text: String(okCount) },
              { type: "text", text: String(lowStock) },
              { type: "text", text: String(outOfStock) },
              { type: "text", text: String(total) }
            ]
          }]
        }
      })
    });

    const waResult = await waRes.json();

    if (waRes.ok) {
      console.log("[inventory-alert] Sent OK | msgId:", waResult.messages?.[0]?.id);
    } else {
      console.error("[inventory-alert] WA error:", JSON.stringify(waResult).substring(0, 400));
    }

    return new Response(JSON.stringify({
      ok:         waRes.ok,
      kpis:       { total, outOfStock, lowStock, okCount, totalUnits },
      waMsgId:    waResult.messages?.[0]?.id,
      waError:    waResult.error?.message
    }), { status: 200, headers: { "Content-Type": "application/json" } });

  } catch (err) {
    console.error("[inventory-alert] Fatal:", err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

export const config = {
  schedule: "0 21 * * *"   // 9PM UTC = 5PM EST daily
};
