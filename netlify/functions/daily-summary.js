const SUPA_URL = "https://rijbschnchjiuggrhfrx.supabase.co";
const SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJpamJzY2huY2hqaXVnZ3JoZnJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzMTQwOTQsImV4cCI6MjA4ODg5MDA5NH0.s3T4CStjWqOvz7qDpYtjt0yVJ0iyOMAKKwxkADSEs4s";

function fmtDate(d) {
  return new Date(d).toLocaleDateString("en-US", { month:"short", day:"2-digit", year:"numeric" });
}

async function getTodayRecords() {
  const today = new Date();
  today.setHours(0,0,0,0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const res = await fetch(
    `${SUPA_URL}/rest/v1/shipments_general?received_at=gte.${today.toISOString()}&received_at=lt.${tomorrow.toISOString()}&order=received_at.desc`,
    { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } }
  );
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  return res.json();
}

async function getClients() {
  const res = await fetch(
    `${SUPA_URL}/rest/v1/wa_clients?order=name.asc&limit=200`,
    { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data || []).map(c => ({
    id: c.id, name: c.name, company: c.company, email: c.email,
    waNumber: c.wa_number, storeId: c.store_id, storeName: c.store_name,
    active: c.active
  }));
}

async function sendWhatsApp(to, params) {
  const token   = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const res = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", to, type: "template",
      template: {
        name: "daily_summary", language: { code: "en" },
        components: [{ type: "body", parameters: params.map(p => ({ type: "text", text: p })) }]
      }
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function sendEmail(to, name, dateStr, inbound, outbound) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY not set");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: "FR-Logistics Miami <info@fr-logistics.net>",
      to: [to],
      subject: `FR-Logistics Daily Summary — ${dateStr}`,
      text: `Hi ${name},\n\nHere is your daily summary from FR-Logistics Miami — ${dateStr}:\n\nInbound: ${inbound} package(s) received\nOutbound: ${outbound} shipment(s) processed\n\nFor full details contact us at info@fr-logistics.net.\n\nThank you for trusting FR-Logistics.\n\nFR-Logistics Miami Team\nDoral, FL 33172`
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

exports.handler = async function(event) {
  const dateStr = fmtDate(new Date());
  console.log(`[daily-summary] Running for ${dateStr}`);

  try {
    const records = await getTodayRecords();
    console.log(`[daily-summary] ${records.length} records today`);
    if (!records.length) return { statusCode: 200, body: "No records today" };

    const clients = await getClients();
    console.log(`[daily-summary] ${clients.length} clients registered`);

    // Group by client name
    const byClient = {};
    for (const r of records) {
      const name = (r.client || "").trim();
      if (!name) continue;
      if (!byClient[name]) byClient[name] = { inbound: 0, outbound: 0 };
      if (r.direction === "Inbound") byClient[name].inbound++;
      else byClient[name].outbound++;
    }

    for (const [clientName, counts] of Object.entries(byClient)) {
      if (!counts.inbound && !counts.outbound) continue;

      const reg = clients.find(c => c.active && [c.storeName, c.name, c.company]
        .some(v => v && v.toLowerCase() === clientName.toLowerCase()));

      const displayName = reg?.name || clientName;

      if (reg?.waNumber) {
        try {
          await sendWhatsApp(reg.waNumber, [displayName, dateStr, String(counts.inbound), String(counts.outbound)]);
          console.log(`[daily-summary] WA sent → ${clientName}`);
        } catch(e){
          console.error(`[daily-summary] WA error ${clientName}:`, e.message);
          // Fallback to email if WA fails
          if (reg?.email) {
            try {
              await sendEmail(reg.email, displayName, dateStr, counts.inbound, counts.outbound);
              console.log(`[daily-summary] Email fallback sent → ${clientName} (${reg.email})`);
            } catch(e2){ console.error(`[daily-summary] Email fallback error ${clientName}:`, e2.message); }
          }
        }

      } else if (reg?.email) {
        try {
          await sendEmail(reg.email, displayName, dateStr, counts.inbound, counts.outbound);
          console.log(`[daily-summary] Email sent → ${clientName} (${reg.email})`);
        } catch(e){ console.error(`[daily-summary] Email error ${clientName}:`, e.message); }

      } else {
        console.log(`[daily-summary] No contact for ${clientName}`);
      }
    }

    return { statusCode: 200, body: "Done" };
  } catch(e) {
    console.error("[daily-summary] Fatal:", e.message);
    return { statusCode: 500, body: e.message };
  }
};
