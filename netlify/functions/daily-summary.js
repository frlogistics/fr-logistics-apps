const https = require("https");
const SUPA_URL = "https://rijbschnchjiuggrhfrx.supabase.co";
const SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJpamJzY2huY2hqaXVnZ3JoZnJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzMTQwOTQsImV4cCI6MjA4ODg5MDA5NH0.s3T4CStjWqOvz7qDpYtjt0yVJ0iyOMAKKwxkADSEs4s";
const SITE_ID = "9762f903-d555-4532-a78f-9f9784684adc";

function fmtDate(d) {
  return new Date(d).toLocaleDateString("en-US", { month:"short", day:"2-digit", year:"numeric" });
}

async function getTodayRecords() {
  const today = new Date();
  today.setHours(0,0,0,0);
  const todayISO = today.toISOString();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const res = await fetch(
    `${SUPA_URL}/rest/v1/shipments_general?received_at=gte.${todayISO}&received_at=lt.${tomorrow.toISOString()}&order=received_at.desc`,
    { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } }
  );
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  return res.json();
}

async function getClients(token) {
  try {
    const r = await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/wa-clients/clients`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!r.ok) return [];
    return r.json();
  } catch { return []; }
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

// Send email via Gmail API using basic auth SMTP encoded as base64
function sendGmail(to, subject, body) {
  return new Promise((resolve, reject) => {
    const user     = process.env.GMAIL_USER;
    const from     = process.env.GMAIL_FROM || user;
    const password = process.env.GMAIL_APP_PASSWORD;
    if (!user || !password) { resolve({ skipped: true }); return; }

    // Build RFC 2822 message
    const msg = [
      `From: FR-Logistics Miami <${from}>`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      body
    ].join("\r\n");

    const encoded = Buffer.from(msg).toString("base64url");
    const auth    = Buffer.from(`${user}:${password}`).toString("base64");

    const data = JSON.stringify({ raw: encoded });
    const req  = https.request({
      hostname: "gmail.googleapis.com",
      path: "/gmail/v1/users/me/messages/send",
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data)
      }
    }, res => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ sent: true });
        else reject(new Error(`Gmail ${res.statusCode}: ${body}`));
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

exports.handler = async function() {
  const netlifyToken = process.env.NETLIFY_API_TOKEN;
  const dateStr = fmtDate(new Date());
  console.log(`[daily-summary] ${dateStr}`);

  try {
    const records = await getTodayRecords();
    if (!records.length) { console.log("[daily-summary] No records today"); return; }

    const clients = await getClients(netlifyToken);

    // Group by client
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
          console.log(`[daily-summary] WA → ${clientName}`);
        } catch (e) { console.error(`[daily-summary] WA error ${clientName}:`, e.message); }

      } else if (reg?.email) {
        const subject = `FR-Logistics Daily Summary — ${dateStr}`;
        const emailBody = `Hi ${displayName},\n\nHere is your daily summary from FR-Logistics Miami — ${dateStr}:\n\nInbound: ${counts.inbound} package(s) received\nOutbound: ${counts.outbound} shipment(s) processed\n\nFor full details please contact us at info@fr-logistics.net.\n\nThank you for trusting FR-Logistics.\n\nFR-Logistics Miami Team\nDoral, FL 33172`;
        try {
          await sendGmail(reg.email, subject, emailBody);
          console.log(`[daily-summary] Email → ${clientName} (${reg.email})`);
        } catch (e) { console.error(`[daily-summary] Email error ${clientName}:`, e.message); }

      } else {
        console.log(`[daily-summary] No contact for ${clientName}`);
      }
    }
  } catch (e) { console.error("[daily-summary] Fatal:", e.message); }
};

exports.config = { schedule: "0 23 * * *" };
