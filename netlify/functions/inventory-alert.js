// netlify/functions/inventory-alert.js
// Scheduled daily at 9PM UTC (5PM EST)
// Calls inventory function → sends inventory summary via WhatsApp template

const WA_TOKEN     = Netlify.env.get("WHATSAPP_TOKEN");
const PHONE_ID     = Netlify.env.get("WHATSAPP_PHONE_ID");
const ALERT_NUMBER = Netlify.env.get("ALERT_PHONE") || "13052403172";
const SITE_URL     = Netlify.env.get("URL") || "https://apps.fr-logistics.net";
const WA_BASE      = `https://graph.facebook.com/v21.0/${PHONE_ID}/messages`;

export default async function handler(req) {
  console.log("[inventory-alert] Starting at", new Date().toISOString());

  try {
    // 1. Get inventory KPIs from the working inventory function
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
      console.log("[inventory-alert] All OK — no alert");
      return new Response(JSON.stringify({ ok: true, message: "All stock OK" }), { status: 200 });
    }

    const today = new Date().toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      month: "short", day: "numeric", year: "numeric"
    });

    // 2. Send via daily_summary template (already approved by Meta)
    // Template vars: {{1}}=clientName, {{2}}=dateLabel, {{3}}=inbound, {{4}}=outbound
    // We repurpose: {{1}}=team, {{2}}=date+SKU summary, {{3}}=reorder SKUs, {{4}}=out-of-stock SKUs
    const waPayload = {
      messaging_product: "whatsapp",
      to:   ALERT_NUMBER,
      type: "template",
      template: {
        name: "daily_summary",
        language: { code: "en_US" },
        components: [{
          type: "body",
          parameters: [
            { type: "text", text: "FR-Logistics Inventory" },
            { type: "text", text: `${today} | ${total} SKUs · ${totalUnits.toLocaleString()} units | ✅ OK: ${okCount}` },
            { type: "text", text: `${lowStock} SKUs need reorder (≤12 units)` },
            { type: "text", text: `${outOfStock} SKUs out of stock` }
          ]
        }]
      }
    };

    const waRes = await fetch(WA_BASE, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(waPayload)
    });

    const waResult = await waRes.json();

    if (waRes.ok) {
      console.log("[inventory-alert] ✅ Alert sent | msgId:", waResult.messages?.[0]?.id);
    } else {
      console.error("[inventory-alert] ❌ WA error:", JSON.stringify(waResult).substring(0, 400));
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
  schedule: "0 21 * * *"
};
