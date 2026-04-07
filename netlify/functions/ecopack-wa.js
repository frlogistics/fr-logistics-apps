// netlify/functions/ecopack-wa.js
// EcoPack+ WhatsApp notifications
// Opcion A: Only sends WA on FIRST inbound of the day per client
//           Message shows TOTAL pending packages (all-time, not just today)

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY");
const WA_TOKEN     = Netlify.env.get("WHATSAPP_TOKEN");
const PHONE_ID     = Netlify.env.get("WHATSAPP_PHONE_ID");
const WA_BASE      = `https://graph.facebook.com/v21.0/${PHONE_ID}/messages`;

const SB = () => ({
  "apikey": SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json"
});

async function getClient(displayName) {
  const encoded = encodeURIComponent(displayName);
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/fr_clients?or=(name.ilike.${encoded},store_name.ilike.${encoded})&limit=1`,
    { headers: SB() }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

async function countTodayInbounds(clientName) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const iso = todayStart.toISOString();
  const encoded = encodeURIComponent(clientName);
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/shipments_general?client=ilike.${encoded}&direction=eq.Inbound&received_at=gte.${iso}&select=id`,
    { headers: SB() }
  );
  if (!res.ok) return 0;
  return (await res.json()).length;
}

async function countTotalPending(clientName) {
  const encoded = encodeURIComponent(clientName);
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/shipments_general?client=ilike.${encoded}&direction=eq.Inbound&select=id`,
    { headers: SB() }
  );
  if (!res.ok) return 1;
  return (await res.json()).length;
}

async function sendTemplate(to, templateName, params) {
  const phone = to.replace(/\D/g, "");
  const res = await fetch(WA_BASE, {
    method: "POST",
    headers: { "Authorization": `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phone,
      type: "template",
      template: {
        name: templateName,
        language: { code: "en" },
        components: [{ type: "body", parameters: params.map(p => ({ type: "text", text: String(p) })) }]
      }
    })
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error?.message || "WA send failed");
  return j.messages?.[0]?.id;
}

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
};
const jRes = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: CORS });

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url    = new URL(req.url);
  const action = url.searchParams.get("action");

  if (req.method === "POST" && action === "notify") {
    let body;
    try { body = await req.json(); } catch { return jRes({ error: "Invalid JSON" }, 400); }

    const { clientDisplayName } = body;
    if (!clientDisplayName) return jRes({ error: "clientDisplayName required" }, 400);

    // STEP 1: Look up client in fr_clients
    const client = await getClient(clientDisplayName);
    if (!client) {
      console.log(`[ecopack-wa] Client not found: ${clientDisplayName}`);
      return jRes({ ok: false, reason: "client_not_found" });
    }

    const waNumber = client.wa_number;
    const services = client.services || [];
    const hasEco   = services.includes("EcoPack+");

    if (!hasEco) return jRes({ ok: false, reason: "not_ecopack_client" });
    if (!waNumber) return jRes({ ok: false, reason: "no_wa_number" });

    // STEP 2: Check if this is the FIRST inbound of today (Opcion A)
    const countToday = await countTodayInbounds(client.name || clientDisplayName);
    if (countToday > 1) {
      console.log(`[ecopack-wa] Already notified ${clientDisplayName} today (${countToday} pkgs). Skipping.`);
      return jRes({ ok: true, skipped: true, reason: "already_notified_today", count_today: countToday });
    }

    // STEP 3: Count TOTAL pending packages (what client will pick up)
    const totalPending = await countTotalPending(client.name || clientDisplayName);
    const firstName    = (client.name || clientDisplayName).split(" ")[0];

    // STEP 4: Send correct template based on total count
    let templateName, params;
    if (totalPending <= 1) {
      templateName = "ecopack_package_received";
      params       = [firstName];
    } else {
      templateName = "ecopack_multi_package";
      params       = [firstName, String(totalPending)];
    }

    const msgId = await sendTemplate(waNumber, templateName, params);
    console.log(`[ecopack-wa] Sent to ${clientDisplayName} | ${templateName} | total:${totalPending} | id:${msgId}`);

    return jRes({ ok: true, template: templateName, total_pending: totalPending, first_of_day: true, msgId });
  }

  return jRes({ error: "Unknown action or method" }, 400);
}

export const config = { path: "/.netlify/functions/ecopack-wa" };
