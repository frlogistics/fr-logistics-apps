// daily-summary.js — FR-Logistics Daily WhatsApp Summary
// Runs daily at 11PM UTC (7PM EST)
// Reads fr_clients from Supabase and sends daily_summary template

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY");
const PHONE_ID = Netlify.env.get("WHATSAPP_PHONE_ID");
const TOKEN = Netlify.env.get("WHATSAPP_TOKEN");

async function getClients() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/fr_clients?wa_notifications=eq.true&wa_number=not.is.null&select=name,wa_number,daily_inbound,daily_outbound`,
    {
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );
  return res.json();
}

async function sendDailySummary(to, clientName, dateLabel, inbound, outbound) {
  const res = await fetch(`https://graph.facebook.com/v20.0/${PHONE_ID}/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Content-Type": "application/json"
    },
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
            { type: "text", text: String(inbound || 0) },
            { type: "text", text: String(outbound || 0) }
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
      return;
    }

    console.log(`Sending to ${clients.length} client(s)`);

   for (const client of clients) {
  // Solo enviar si hubo actividad real ese día
  if (!client.daily_inbound && !client.daily_outbound) {
    console.log(`Skipping ${client.name} — no activity today`);
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
        console.log(`Sent to ${client.name} (${client.wa_number}): ${JSON.stringify(result)}`);
      } catch (err) {
        console.error(`Error sending to ${client.name}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error("Daily summary error:", err.message);
  }
};

export const config = {
  schedule: "0 23 * * *"
};
