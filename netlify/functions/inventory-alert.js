// netlify/functions/inventory-alert.js
// Scheduled daily at 9PM UTC (5PM EST)
// Calls the inventory function (which reads SKUVault) and sends a WhatsApp summary

const WA_TOKEN     = Netlify.env.get("WHATSAPP_TOKEN");
const PHONE_ID     = Netlify.env.get("WHATSAPP_PHONE_ID");
const ALERT_NUMBER = Netlify.env.get("ALERT_PHONE") || "13052403172";
const SITE_URL     = Netlify.env.get("URL") || "https://apps.fr-logistics.net";
const WA_BASE      = `https://graph.facebook.com/v21.0/${PHONE_ID}/messages`;

export default async function handler(req) {
  console.log("[inventory-alert] Starting at", new Date().toISOString());

  try {
    // 1. Get inventory data from the inventory function (already calls SKUVault)
    const invRes = await fetch(`${SITE_URL}/.netlify/functions/inventory`);
    if (!invRes.ok) throw new Error(`inventory function error: ${invRes.status}`);
    const inv = await invRes.json();

    const { kpis, skus = [] } = inv;
    const total      = kpis.totalSKUs   || skus.length;
    const outOfStock = kpis.outOfStock  || 0;
    const lowStock   = kpis.reorderAlerts || kpis.lowStock || 0;
    const okCount    = total - outOfStock - lowStock;

    console.log("[inventory-alert] KPIs:", { total, outOfStock, lowStock, okCount });

    // Only alert if there are issues
    if (outOfStock === 0 && lowStock === 0) {
      console.log("[inventory-alert] All items OK — no alert sent");
      return new Response(JSON.stringify({ ok: true, message: "All stock OK, no alert needed" }), { status: 200 });
    }

    // 2. Get top out-of-stock SKU names for context
    const outSkus = skus.filter(s => (s.available ?? s.onHand ?? 0) <= 0);
    const lowSkus = skus.filter(s => {
      const qty = s.available ?? s.onHand ?? 0;
      return qty > 0 && qty <= 12;
    });

    // 3. Build summary message
    const today = new Date().toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      month: "short", day: "numeric", year: "numeric"
    });

    const lines = [
      `📦 *FR-Logistics Inventory Alert*`,
      `${today} · 5:00 PM EST`,
      ``,
      `✅ OK: *${okCount} SKUs*`,
      `⚠️ Needs Reorder: *${lowStock} SKUs*`,
      `🚨 Out of Stock: *${outOfStock} SKUs*`,
      ``,
      `Total tracked: ${total} SKUs · ${(kpis.totalUnits || 0).toLocaleString()} units`
    ];

    if (outSkus.length > 0) {
      lines.push(``);
      lines.push(`*Out of Stock:*`);
      outSkus.slice(0, 5).forEach(s => lines.push(`• ${s.sku}`));
      if (outOfStock > 5) lines.push(`  ...and ${outOfStock - 5} more`);
    }

    if (lowSkus.length > 0) {
      lines.push(``);
      lines.push(`*Needs Reorder (≤12 units):*`);
      lowSkus.slice(0, 5).forEach(s => lines.push(`• ${s.sku} (${s.available ?? s.onHand} left)`));
      if (lowStock > lowSkus.length) lines.push(`  ...and ${lowStock - lowSkus.length} more`);
    }

    lines.push(``);
    lines.push(`_Full detail: apps.fr-logistics.net/dashboard-inventory.html_`);

    const body = lines.join("\n");

    // 4. Send via WhatsApp
    const waRes = await fetch(WA_BASE, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to:   ALERT_NUMBER,
        type: "text",
        text: { body }
      })
    });

    const waResult = await waRes.json();

    if (waRes.ok) {
      console.log("[inventory-alert] WA sent OK | id:", waResult.messages?.[0]?.id);
    } else {
      console.error("[inventory-alert] WA error:", JSON.stringify(waResult).substring(0, 300));
    }

    return new Response(JSON.stringify({
      ok: waRes.ok,
      kpis: { total, outOfStock, lowStock, okCount },
      waMsgId: waResult.messages?.[0]?.id,
      waError: waResult.error?.message
    }), { status: 200, headers: { "Content-Type": "application/json" } });

  } catch (err) {
    console.error("[inventory-alert] Fatal:", err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

export const config = {
  schedule: "0 21 * * *"   // 9PM UTC = 5PM EST daily
};
