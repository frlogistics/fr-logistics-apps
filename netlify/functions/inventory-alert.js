// netlify/functions/inventory-alert.js
// Scheduled daily at 9PM UTC (5PM EST)
// Pulls inventory from SKUVault, sends SUMMARY alert via WhatsApp
// Summary: OK count | At Reorder Point count | Out of Stock count

const COMBINED_TOKEN  = Netlify.env.get("SKUVAULT_TENANT_TOKEN") || "";
const WA_TOKEN        = Netlify.env.get("WHATSAPP_TOKEN");
const PHONE_ID        = Netlify.env.get("WHATSAPP_PHONE_ID");
const ALERT_NUMBER    = Netlify.env.get("ALERT_PHONE") || "13052403172";

// SKUVault stores tokens as "UserToken|TenantToken" in one env var
const [USER_TOKEN, TENANT_TOKEN] = COMBINED_TOKEN.includes("|")
  ? COMBINED_TOKEN.split("|")
  : [COMBINED_TOKEN, COMBINED_TOKEN];

const SKUVAULT_URL = "https://app.skuvault.com/api/inventory/getInventory";
const WA_BASE      = `https://graph.facebook.com/v21.0/${PHONE_ID}/messages`;

const REORDER_POINT = 12;

export default async function handler(req) {
  const startTime = Date.now();
  console.log("[inventory-alert] Starting at", new Date().toISOString());

  try {
    // 1. Fetch inventory from SKUVault
    const skuRes = await fetch(SKUVAULT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        UserToken:   USER_TOKEN,
        TenantToken: TENANT_TOKEN,
        PageNumber:  0,
        PageSize:    10000
      })
    });

    if (!skuRes.ok) {
      const errText = await skuRes.text();
      console.error("[inventory-alert] SKUVault error:", skuRes.status, errText.substring(0, 300));
      throw new Error(`SKUVault API error ${skuRes.status}`);
    }

    const skuData = await skuRes.json();
    const items   = skuData.Items || [];
    console.log("[inventory-alert] Fetched", items.length, "SKUs");

    if (items.length === 0) {
      console.log("[inventory-alert] No items returned — skipping");
      return new Response("No items", { status: 200 });
    }

    // 2. Categorize inventory
    const outOfStock = [];
    const atReorder  = [];
    const okItems    = [];

    for (const item of items) {
      const qty = typeof item.QuantityAvailable === "number"
        ? item.QuantityAvailable
        : parseInt(item.QuantityAvailable || "0", 10);
      const sku = item.Sku || item.SKU || "UNKNOWN";

      if (qty <= 0) {
        outOfStock.push({ sku, qty });
      } else if (qty <= REORDER_POINT) {
        atReorder.push({ sku, qty });
      } else {
        okItems.push({ sku, qty });
      }
    }

    const total = items.length;
    const today = new Date().toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      month: "short", day: "numeric", year: "numeric"
    });

    console.log("[inventory-alert] Summary:", {
      total, ok: okItems.length,
      atReorder: atReorder.length, outOfStock: outOfStock.length
    });

    // Only alert if there are issues
    if (outOfStock.length === 0 && atReorder.length === 0) {
      console.log("[inventory-alert] All items OK — no alert needed");
      return new Response("All OK", { status: 200 });
    }

    // 3. Build summary message
    const lines = [
      `📦 *FR-Logistics Inventory Alert — ${today}*`,
      ``,
      `✅ OK (>${REORDER_POINT} units): *${okItems.length} SKUs*`,
      `⚠️ At Reorder Point (≤${REORDER_POINT}): *${atReorder.length} SKUs*`,
      `🚨 Out of Stock: *${outOfStock.length} SKUs*`,
      ``,
      `Total SKUs tracked: ${total}`
    ];

    if (outOfStock.length > 0) {
      lines.push(``);
      lines.push(`*Out of Stock:*`);
      outOfStock.slice(0, 5).forEach(i => lines.push(`• ${i.sku}`));
      if (outOfStock.length > 5) lines.push(`  ...and ${outOfStock.length - 5} more`);
    }

    if (atReorder.length > 0) {
      lines.push(``);
      lines.push(`*Needs Reorder:*`);
      atReorder.slice(0, 5).forEach(i => lines.push(`• ${i.sku} (${i.qty} left)`));
      if (atReorder.length > 5) lines.push(`  ...and ${atReorder.length - 5} more`);
    }

    lines.push(``);
    lines.push(`_See dashboard-inventory.html for full detail_`);

    const messageBody = lines.join("\n");

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
        text: { body: messageBody }
      })
    });

    const waResult = await waRes.json();
    const elapsed  = Date.now() - startTime;

    if (waRes.ok) {
      console.log("[inventory-alert] WA sent in", elapsed, "ms | id:", waResult.messages?.[0]?.id);
    } else {
      console.error("[inventory-alert] WA failed:", JSON.stringify(waResult).substring(0, 300));
    }

    return new Response(JSON.stringify({
      ok:         waRes.ok,
      total,
      ok_count:   okItems.length,
      reorder:    atReorder.length,
      outOfStock: outOfStock.length,
      elapsed_ms: elapsed
    }), { status: 200, headers: { "Content-Type": "application/json" } });

  } catch (err) {
    console.error("[inventory-alert] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

export const config = {
  schedule: "0 21 * * *"
};
