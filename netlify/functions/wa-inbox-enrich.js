// netlify/functions/wa-inbox-enrich.js
// Enriches the WhatsApp Inbox with lead context from wa_leads, and powers
// deep search across messages + leads.
//
// GET ?enrich=phones
//     -> { "<normalizedPhone>": { name, email, service, status, lead_id, country }, ... }
//        The Inbox calls this once on load to map each thread (by phone) to its
//        lead record — so a chat that shows "Liam" can display the real lead
//        name, email, and pipeline status, and become searchable by email.
//
// GET ?search=<query>
//     -> [ { phone, name, email, service, status, lead_id, source:"lead"|"message",
//            last_text, last_at } ... ]
//        Deep search across wa_leads (name/email/phone) AND wa_messages
//        (client_name/body/phone). Used when the term isn't in the loaded threads.
//
// wa_leads + wa_messages are under RLS -> SUPABASE_SERVICE_KEY (server-side only).

const SUPA_URL = "https://rijbschnchjiuggrhfrx.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

// Strip everything but digits so +593 96 703-3695 == 593967033695.
const norm = p => (p || "").replace(/\D/g, "");

async function sb(path) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

const realEmail = e => !!e && !e.startsWith("pending+");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "GET")
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
  if (!SERVICE_KEY)
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "SUPABASE_SERVICE_KEY not configured" }) };

  const qs = event.queryStringParameters || {};

  try {
    // ── Enrich map: phone -> lead context ────────────────────────────────
    if (qs.enrich === "phones") {
      // Pull recent-ish leads (any status) so even won/lost chats resolve.
      const leads = await sb(
        `wa_leads?select=id,name,email,phone,service,service_detail,status,country,monthly_volume&order=created_at.desc&limit=500`
      );
      const map = {};
      for (const l of leads) {
        const key = norm(l.phone);
        if (!key) continue;
        // First (most recent) lead for a phone wins; don't overwrite.
        if (map[key]) continue;
        map[key] = {
          lead_id: l.id,
          name: l.name || "",
          email: realEmail(l.email) ? l.email : "",
          service: l.service || "",
          service_detail: l.service_detail || "",
          status: l.status || "",
          country: l.country || "",
          monthly_volume: l.monthly_volume || "",
        };
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify(map) };
    }

    // ── Deep search across leads + messages ──────────────────────────────
    if (qs.search != null) {
      const q = qs.search.trim();
      if (q.length < 2) return { statusCode: 200, headers: CORS, body: JSON.stringify([]) };

      const enc = encodeURIComponent(`%${q}%`);
      const digits = norm(q);
      const results = [];
      const seen = new Set();

      // 1) Leads matching name / email / phone
      const leadFilter =
        digits.length >= 3
          ? `or=(name.ilike.${enc},email.ilike.${enc},phone.ilike.%${digits}%)`
          : `or=(name.ilike.${enc},email.ilike.${enc})`;
      const leads = await sb(
        `wa_leads?select=id,name,email,phone,service,status,created_at&${leadFilter}&order=created_at.desc&limit=25`
      );
      for (const l of leads) {
        const key = norm(l.phone);
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
          source: "lead",
          phone: l.phone || "",
          norm_phone: key,
          name: l.name || "",
          email: realEmail(l.email) ? l.email : "",
          service: l.service || "",
          status: l.status || "",
          last_at: l.created_at,
        });
      }

      // 2) Messages matching client_name / body / phone (catches chats with no lead)
      const msgFilter =
        digits.length >= 3
          ? `or=(client_name.ilike.${enc},body.ilike.${enc},from_number.ilike.%${digits}%,to_number.ilike.%${digits}%)`
          : `or=(client_name.ilike.${enc},body.ilike.${enc})`;
      const msgs = await sb(
        `wa_messages?select=from_number,to_number,direction,client_name,body,timestamp&${msgFilter}&order=timestamp.desc&limit=40`
      );
      for (const m of msgs) {
        const phone = m.direction === "inbound" ? m.from_number : m.to_number;
        const key = norm(phone);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        results.push({
          source: "message",
          phone,
          norm_phone: key,
          name: m.client_name || phone,
          email: "",
          service: "",
          status: "",
          last_text: (m.body || "").slice(0, 60),
          last_at: m.timestamp,
        });
      }

      results.sort((a, b) => new Date(b.last_at || 0) - new Date(a.last_at || 0));
      return { statusCode: 200, headers: CORS, body: JSON.stringify(results) };
    }

    return { statusCode: 400, headers: CORS,
      body: JSON.stringify({ error: "Specify ?enrich=phones or ?search=<query>" }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
