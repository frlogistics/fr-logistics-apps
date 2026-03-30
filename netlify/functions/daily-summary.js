// daily-summary.js — FR-Logistics Daily WhatsApp Summary
// Runs daily at 11PM UTC (7PM EST)
// Template: daily_summary (English, en_US)
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY");
const PHONE_ID = Netlify.env.get("WHATSAPP_PHONE_ID");
const TOKEN = Netlify.env.get("WHATSAPP_TOKEN");

async function sendDailySummary(to, clientName, dateLabel, inbound, outbound) {
  const payload = {
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
          { type: "text", text: String(outbound) },
        ],
      }],
    },
  };
  const res = await fetch(`https://graph.facebook.com/v20.0/${PHONE_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export default async (req) => {
  const now = new Date();
  const dateLabel = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York" });

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const { data: clients } = await supabase
      .from("fr_clients")
      .select("*")
      .eq("wa_notifications", true)
      .not("wa_phone", "is", null);

    if (!clients || clients.length === 0) {
      console.log("No clients with WA notifications enabled");
      return;
    }

    for (const client of clients) {
      try {
        const result = await sendDailySummary(
          client.wa_phone,
          client.name,
          dateLabel,
          client.daily_inbound || 0,
          client.daily_outbound || 0
        );
        console.log(`Sent daily summary to ${client.name}: ${JSON.stringify(result)}`);
      } catch (err) {
        console.error(`Error sending to ${client.name}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error("Daily summary error:", err.message);
  }
};

export const config = {
  schedule: "0 23 * * *",
};
