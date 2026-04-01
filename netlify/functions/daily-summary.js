// daily-summary.js — FR-Logistics Daily WhatsApp Summary
// Runs daily at 11PM UTC (7PM EST)
// Skips clients with no activity. Resets counters after sending.

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY");
const PHONE_ID     = Netlify.env.get("WHATSAPP_PHONE_ID");
const TOKEN        = Netlify.env.get("WHATSAPP_TOKEN");

const sbHeaders = {
  "apikey":        SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type":  "application/json"
};

async function getClients() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/fr_clients?wa_notifications=eq.true&wa_number=not.is.null&select=id,name,wa_number,daily_inbound,daily_outbound`,
    { headers: sbHeaders }
  );
  return res.json();
}

async function resetCounters(id) {
  await fetch(`${SUPABASE_URL}/rest/v1/fr_clients?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...sbHeaders, "Prefer": "return=minimal" },
    body: JSON.stringify({ daily_inbound: 0, daily_outbound: 0 })
  });
}

async function sendDailySummary(to, clientName, dateLabel, inbound, outbound) {
  const res = await fetch(`https://graph.facebook.com/v20.0/${PHONE_ID}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
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
            { type: "text", text: clientName },
            { type: "text", text: dateLabel },
            { type: "text", text: String(inbound) },
            { type: "text", text: String(outbound) }
          ]
        }]
      }
    })
  });
  return res.json();
}

export default async (req) => {
  const now = new Date();
  const dateLabel = now.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
    timeZone: "America/New_York"
  });

  console.log(`Running daily summary for ${dateLabel}`);

  try {
    const clients = await getClients();

    if (!clients || clients.length === 0) {
      console.log("No clients with WA notifications enabled");
      return new Response("No clients", { status: 200 });
    }

    let sent = 0, skipped = 0, errors = 0;

    for (const client of clients) {
      // Skip if no activity today
      if (!client.daily_inbound && !client.daily_outbound) {
        console.log(`Skipping ${client.name} — no activity today`);
        skipped++;
        continue;
      }

      try {
        const result = await sendDailySummary(
          client.wa_number,
          client.name,
          dateLabel,
          client.daily_inbound || 0,
          client.daily_outbound || 0
        );
        console.log(`Sent to ${client.name}: ${JSON.stringify(result)}`);
        sent++;
      } catch (err) {
        console.error(`Error sending to ${client.name}: ${err.message}`);
        errors++;
      }

      // Reset counters regardless of send result
      await resetCounters(client.id);
      console.log(`Counters reset for ${client.name}`);
    }

    console.log(`Done — Sent: ${sent}, Skipped: ${skipped}, Errors: ${errors}`);
    return new Response(JSON.stringify({ sent, skipped, errors }), { status: 200 });

  } catch (err) {
    console.error("Daily summary error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const config = {
  schedule: "0 23 * * *"
};
