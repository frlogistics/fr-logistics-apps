// netlify/functions/daily-summary.js
// Scheduled daily at 11PM UTC (7PM EST)
// Reads TODAY's movements from shipments_general
// Groups by client → sends daily_summary WA to each client with activity
// Always sends a copy to FR-Logistics monitoring number (+17863001443)

const SUPABASE_URL  = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY  = Netlify.env.get("SUPABASE_SERVICE_KEY");
const PHONE_ID      = Netlify.env.get("WHATSAPP_PHONE_ID");
const WA_TOKEN      = Netlify.env.get("WHATSAPP_TOKEN");
const FR_MONITOR    = "17863001443";  // Always CC'd — FR-Logistics ops number
const WA_BASE       = `https://graph.facebook.com/v21.0/${PHONE_ID}/messages`;

const SB_HEADERS = () => ({
  "apikey":        SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type":  "application/json"
});

// ── Helpers ───────────────────────────────────────────────────────

async function getTodayMovements() {
  // Get today's date range in EST (UTC-5 / UTC-4 DST)
  const now = new Date();
  const estOffset = -5 * 60; // minutes, simplified (close enough for daily cron)
  const estNow = new Date(now.getTime() + estOffset * 60000);
  const yyyy = estNow.getUTCFullYear();
  const mm   = String(estNow.getUTCMonth() + 1).padStart(2, "0");
  const dd   = String(estNow.getUTCDate()).padStart(2, "0");
  const todayStart = `${yyyy}-${mm}-${dd}T00:00:00.000Z`;
  const todayEnd   = `${yyyy}-${mm}-${dd}T23:59:59.999Z`;

  console.log(`[daily-summary] Querying movements for ${yyyy}-${mm}-${dd} EST`);

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/shipments_general` +
    `?select=client,direction,received_at` +
    `&received_at=gte.${todayStart}` +
    `&received_at=lte.${todayEnd}` +
    `&limit=1000`,
    { headers: SB_HEADERS() }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase shipments_general error: ${err.substring(0,200)}`);
  }
  return res.json();
}

async function getClients() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/fr_clients` +
    `?select=id,name,company,store_name,wa_number,wa_notifications,email` +
    `&active=eq.true`,
    { headers: SB_HEADERS() }
  );
  if (!res.ok) throw new Error("Supabase fr_clients error");
  return res.json();
}

function matchClient(movementClientName, clients) {
  const q = movementClientName.toLowerCase().trim();
  return clients.find(c =>
    (c.name        && c.name.toLowerCase().trim()       === q) ||
    (c.company     && c.company.toLowerCase().trim()    === q) ||
    (c.store_name  && c.store_name.toLowerCase().trim() === q)
  );
}

async function sendWA(to, clientName, dateLabel, inbound, outbound) {
  const toClean = to.replace(/[^0-9]/g, "");
  const res = await fetch(WA_BASE, {
    method: "POST",
    headers: { "Authorization": `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toClean,
      type: "template",
      template: {
        name: "daily_summary",
        language: { code: "en_US" },
        components: [{
          type: "body",
          parameters: [
            { type: "text", text: clientName },
            { type: "text", text: dateLabel },
            { type: "text", text: String(inbound) },
            { type: "text", text: String(outbound) }
          ]
        }]
      }
    })
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error?.message || JSON.stringify(result).substring(0,200));
  return result.messages?.[0]?.id;
}

// ── Main handler ──────────────────────────────────────────────────

export default async function handler(req) {
  console.log("[daily-summary] Starting at", new Date().toISOString());

  try {
    // 1. Get today's movements from shipments_general
    const movements = await getTodayMovements();
    console.log(`[daily-summary] Total movements today: ${movements.length}`);

    if (movements.length === 0) {
      console.log("[daily-summary] No movements today — no alerts sent");
      return new Response(JSON.stringify({ sent: 0, skipped: 0, message: "No movements today" }), { status: 200 });
    }

    // 2. Group by client name
    const byClient = {};
    for (const m of movements) {
      const name = (m.client || "").trim();
      if (!name) continue;
      if (!byClient[name]) byClient[name] = { inbound: 0, outbound: 0 };
      if (m.direction === "Inbound")  byClient[name].inbound++;
      if (m.direction === "Outbound") byClient[name].outbound++;
    }

    const clientNames = Object.keys(byClient);
    console.log(`[daily-summary] Clients with activity: ${clientNames.join(", ")}`);

    // 3. Load client registry from fr_clients
    const clients = await getClients();

    // 4. Date label for template
    const dateLabel = new Date().toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric",
      timeZone: "America/New_York"
    });

    // 5. Send to each client + CC to FR-Logistics monitor
    let sent = 0, skipped = 0, errors = 0;

    // Build FR-Logistics internal summary (for CC message)
    const allInbound  = movements.filter(m => m.direction === "Inbound").length;
    const allOutbound = movements.filter(m => m.direction === "Outbound").length;

    for (const [clientName, counts] of Object.entries(byClient)) {
      const reg = matchClient(clientName, clients);

      if (!reg) {
        console.log(`[daily-summary] No match in fr_clients for: "${clientName}" — skipped`);
        skipped++;
        continue;
      }

      const displayName = reg.name || clientName;
      const waNum       = (reg.wa_number || "").replace(/[^0-9]/g, "");
      const hasWA       = waNum.length >= 10 && reg.wa_notifications;

      if (!hasWA) {
        console.log(`[daily-summary] No WA or notifications off for ${displayName} — skipped`);
        skipped++;
        continue;
      }

      try {
        const msgId = await sendWA(waNum, displayName, dateLabel, counts.inbound, counts.outbound);
        console.log(`[daily-summary] ✅ Sent to ${displayName} (${waNum}) | in:${counts.inbound} out:${counts.outbound} | id:${msgId}`);
        sent++;
      } catch (err) {
        console.error(`[daily-summary] ❌ Error sending to ${displayName}: ${err.message}`);
        errors++;
      }
    }

    // 6. Always send CC to FR-Logistics monitoring number
    try {
      const ccMsg = await sendWA(
        FR_MONITOR,
        "FR-Logistics Ops",
        dateLabel + " | " + clientNames.length + " clients",
        allInbound,
        allOutbound
      );
      console.log(`[daily-summary] ✅ CC sent to FR-Logistics monitor (+${FR_MONITOR}) | id:${ccMsg}`);
    } catch (err) {
      console.error(`[daily-summary] ❌ CC to monitor failed: ${err.message}`);
    }

    const summary = { sent, skipped, errors, clients: clientNames.length, totalIn: allInbound, totalOut: allOutbound };
    console.log("[daily-summary] Done:", JSON.stringify(summary));

    return new Response(JSON.stringify(summary), {
      status: 200, headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    console.error("[daily-summary] Fatal:", err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

export const config = {
  schedule: "0 23 * * *"   // 11PM UTC = 7PM EST daily
};
