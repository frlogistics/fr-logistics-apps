// netlify/functions/inventory-alert.js
// Scheduled: diario 5:00 PM hora de Miami todo el año (netlify.toml + compuerta miamiClock).
// Gets KPIs from inventory function → sends via inventory_alert WA template
// Falls back to daily_summary if inventory_alert is still pending approval

const WA_TOKEN     = Netlify.env.get("WHATSAPP_TOKEN");
const PHONE_ID     = Netlify.env.get("WHATSAPP_PHONE_ID");
const ALERT_NUMBER = Netlify.env.get("ALERT_PHONE") || "17867757335";
const SITE_URL     = Netlify.env.get("URL") || "https://apps.fr-logistics.net";
const SERVICE_KEY  = Netlify.env.get("SUPABASE_SERVICE_KEY") || "";
const WA_BASE      = `https://graph.facebook.com/v21.0/${PHONE_ID}/messages`;

// ── WA send helpers ───────────────────────────────────────────────

async function sendInventoryAlert(okCount, lowStock, outOfStock, total, today) {
  // Try the proper inventory_alert template first (6 params, clean format)
  const res = await fetch(WA_BASE, {
    method: "POST",
    headers: { "Authorization": `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: ALERT_NUMBER,
      type: "template",
      template: {
        name: "inventory_alert",
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
  const result = await res.json();

  // If inventory_alert not yet approved, fall back to daily_summary
  if (!res.ok && result.error?.code === 132001) {
    console.log("[inventory-alert] inventory_alert not yet approved — using daily_summary fallback");
    return sendFallback(okCount, lowStock, outOfStock, today);
  }

  if (!res.ok) throw new Error(result.error?.message || JSON.stringify(result).substring(0, 200));
  return { template: "inventory_alert", msgId: result.messages?.[0]?.id };
}

async function sendFallback(okCount, lowStock, outOfStock, today) {
  // Fallback: daily_summary template (4 params)
  // Repurposes fields clearly: {{3}}=reorder count, {{4}}=outOfStock count
  const res = await fetch(WA_BASE, {
    method: "POST",
    headers: { "Authorization": `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: ALERT_NUMBER,
      type: "template",
      template: {
        name: "daily_summary",
        language: { code: "en_US" },
        components: [{
          type: "body",
          parameters: [
            { type: "text", text: "FR-Logistics Team" },
            { type: "text", text: today + " Inventory Alert" },
            { type: "text", text: String(lowStock) + " SKUs need reorder" },
            { type: "text", text: String(outOfStock) + " SKUs out of stock (OK: " + String(okCount) + ")" }
          ]
        }]
      }
    })
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error?.message || JSON.stringify(result).substring(0, 200));
  return { template: "daily_summary_fallback", msgId: result.messages?.[0]?.id };
}

// ── Main handler ──────────────────────────────────────────────────

// ── Reloj de Miami (cambio de horario automático) — 25-nov-2026 ────
// Netlify programa en UTC y no sabe del horario de verano. netlify.toml
// dispara esta función en las DOS horas UTC posibles (EDT y EST) y esta
// compuerta deja pasar solo la corrida que cae en la hora de Miami deseada.
// Una corrida manual (sin next_run en el body) no pasa por la compuerta.
const MIAMI_TZ = "America/New_York";
const MIAMI_DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function miamiClock(d = new Date()) {
  const p = {};
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: MIAMI_TZ, hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit"
  });
  for (const x of fmt.formatToParts(d)) p[x.type] = x.value;
  return { hour: Number(p.hour) % 24, minute: Number(p.minute), weekday: MIAMI_DOW[p.weekday] };
}
async function isScheduledCall(req) {
  try { const b = await req.clone().json(); return !!(b && b.next_run); } catch { return false; }
}

export default async function handler(req) {
  if (await isScheduledCall(req)) {
    const t = miamiClock();
    if (!(t.hour === 17)) {
      console.log(`[inventory-alert] ${t.hour}:${String(t.minute).padStart(2, "0")} Miami (día ${t.weekday}) — fuera de las 5 PM, se omite`);
      return new Response(JSON.stringify({ skipped: true, reason: "outside_miami_window", miami_hour: t.hour, miami_weekday: t.weekday }), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    }
  }
  console.log("[inventory-alert] Starting at", new Date().toISOString());

  try {
    // 1. Get inventory KPIs from the inventory function (calls SKUVault)
    // Internal call: auth-gate.js lets it through with the service key.
    const invRes = await fetch(`${SITE_URL}/.netlify/functions/inventory`, {
      headers: { "Authorization": `Bearer ${SERVICE_KEY}` },
    });
    if (!invRes.ok) throw new Error(`inventory fn error: ${invRes.status}`);
    const inv = await invRes.json();

    const { kpis, skus = [] } = inv;
    const total      = kpis.totalSKUs     || skus.length;
    const outOfStock = kpis.outOfStock    || 0;
    const lowStock   = kpis.reorderAlerts || kpis.lowStock || 0;
    const okCount    = total - outOfStock - lowStock;
    const totalUnits = kpis.totalUnits    || 0;

    console.log("[inventory-alert] KPIs:", { total, outOfStock, lowStock, okCount, totalUnits });

    // Skip if everything is fine
    if (outOfStock === 0 && lowStock === 0) {
      console.log("[inventory-alert] All stock OK — no alert needed");
      return new Response(JSON.stringify({ ok: true, message: "All stock OK, no alert sent" }), { status: 200 });
    }

    const today = new Date().toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      month: "short", day: "numeric", year: "numeric"
    });

    // 2. Send alert (with automatic fallback)
    const waResult = await sendInventoryAlert(okCount, lowStock, outOfStock, total, today);
    console.log("[inventory-alert] Sent via", waResult.template, "| msgId:", waResult.msgId);

    return new Response(JSON.stringify({
      ok:         true,
      template:   waResult.template,
      kpis:       { total, outOfStock, lowStock, okCount, totalUnits },
      waMsgId:    waResult.msgId
    }), { status: 200, headers: { "Content-Type": "application/json" } });

  } catch (err) {
    console.error("[inventory-alert] Fatal:", err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

