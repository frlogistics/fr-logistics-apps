// netlify/functions/ecopack.js
// EcoPack+ backend — pickup scheduling, slot availability, WA notifications
// GET  ?action=slots&date=YYYY-MM-DD  → available time slots
// GET  ?action=pickups                → all pickups (portal use)
// POST action=book                   → create pickup + send WA ecopack_pickup_scheduled
// POST action=complete               → mark pickup completed
// POST action=cancel                 → cancel pickup
// POST action=notify                 → send package arrival WA (ecopack_package_received / ecopack_multi_package)

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY");
const WA_TOKEN     = Netlify.env.get("WHATSAPP_TOKEN");
const PHONE_ID     = Netlify.env.get("WHATSAPP_PHONE_ID");
const WA_BASE      = `https://graph.facebook.com/v21.0/${PHONE_ID}/messages`;

// ── Business hours config ─────────────────────────────────────────
// Mon-Fri: 9AM-5PM | Sat: 9AM-1PM | Sun: closed
// Slots: 15 min each, last slot ends by close
const HOURS = {
  1: { open: 9, close: 17 },   // Monday
  2: { open: 9, close: 17 },   // Tuesday
  3: { open: 9, close: 17 },   // Wednesday
  4: { open: 9, close: 17 },   // Thursday
  5: { open: 9, close: 17 },   // Friday
  6: { open: 9, close: 13 },   // Saturday
  0: null                       // Sunday — closed
};
const SLOT_MINUTES = 15;
const MAX_PER_SLOT = 2; // max concurrent pickups per slot

// ── Supabase helpers ──────────────────────────────────────────────
const SB = () => ({
  "apikey": SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json"
});

async function sbSelect(table, query = "") {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, { headers: SB() });
  if (!res.ok) { const e = await res.text(); throw new Error(`DB read error [${table}]: ${e.substring(0,200)}`); }
  return res.json();
}

async function sbInsert(table, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...SB(), "Prefer": "return=representation" },
    body: JSON.stringify(data)
  });
  if (!res.ok) { const e = await res.text(); throw new Error(`DB insert error: ${e.substring(0,300)}`); }
  return res.json();
}

async function sbPatch(table, filter, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: { ...SB(), "Prefer": "return=minimal" },
    body: JSON.stringify(data)
  });
  return res.ok;
}

// ── Slot generator ────────────────────────────────────────────────
function generateSlots(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const dow = date.getDay();
  const hours = HOURS[dow];
  if (!hours) return [];

  const slots = [];
  for (let h = hours.open; h < hours.close; h++) {
    for (let min = 0; min < 60; min += SLOT_MINUTES) {
      // Don't generate slot if it would start at or after close
      if (h === hours.close - 1 && min + SLOT_MINUTES > 60) continue;
      const label = `${h % 12 === 0 ? 12 : h % 12}:${String(min).padStart(2,"0")} ${h < 12 ? "AM" : "PM"}`;
      const value = `${String(h).padStart(2,"0")}:${String(min).padStart(2,"0")}`;
      slots.push({ value, label });
    }
  }
  return slots;
}

function formatTime12(time24) {
  const [h, m] = time24.split(":").map(Number);
  const ampm = h < 12 ? "AM" : "PM";
  const h12  = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2,"0")} ${ampm}`;
}

function formatDateFull(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric"
  });
}

// ── WhatsApp senders ──────────────────────────────────────────────
async function sendPickupConfirmation(toNumber, clientName, dateStr, timeStr, packageCount) {
  const to = toNumber.replace(/\D/g, "");
  const res = await fetch(WA_BASE, {
    method: "POST",
    headers: { "Authorization": `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: "ecopack_pickup_scheduled",
        language: { code: "en" },
        components: [{
          type: "body",
          parameters: [
            { type: "text", text: clientName },
            { type: "text", text: formatDateFull(dateStr) },
            { type: "text", text: formatTime12(timeStr) },
            { type: "text", text: String(packageCount) }
          ]
        }]
      }
    })
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error?.message || "WA send failed");
  return result.messages?.[0]?.id;
}

async function sendPackageAlert(toNumber, clientName, packageCount) {
  const to = toNumber.replace(/\D/g, "");
  const templateName = packageCount > 1 ? "ecopack_multi_package" : "ecopack_package_received";
  const parameters = packageCount > 1
    ? [{ type: "text", text: clientName }, { type: "text", text: String(packageCount) }]
    : [{ type: "text", text: clientName }];

  const res = await fetch(WA_BASE, {
    method: "POST",
    headers: { "Authorization": `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: "en" },
        components: [{ type: "body", parameters }]
      }
    })
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error?.message || "WA send failed");
  return { template: templateName, msgId: result.messages?.[0]?.id };
}

// ── CORS headers ──────────────────────────────────────────────────
const CORS = {
  "Content-Type":                "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

// ── Main handler ──────────────────────────────────────────────────
export default async function handler(req) {
  // OPTIONS preflight
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url    = new URL(req.url);
  const action = url.searchParams.get("action");

  // ── GET: available slots for a date ────────────────────────────
  if (req.method === "GET" && action === "slots") {
    const date = url.searchParams.get("date");
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return json({ error: "date param required (YYYY-MM-DD)" }, 400);
    }

    // Get slots that are already booked on this date
    const booked = await sbSelect(
      "ecopack_pickups",
      `?pickup_date=eq.${date}&status=not.in.(cancelled)&select=pickup_time`
    );

    // Count bookings per slot
    const bookedCounts = {};
    for (const b of booked) {
      bookedCounts[b.pickup_time] = (bookedCounts[b.pickup_time] || 0) + 1;
    }

    // Generate all possible slots and mark availability
    const allSlots = generateSlots(date);
    const availableSlots = allSlots.map(s => ({
      ...s,
      available: (bookedCounts[s.value] || 0) < MAX_PER_SLOT
    }));

    // Check if this date is a valid business day
    const [y, m, d] = date.split("-").map(Number);
    const dow = new Date(y, m - 1, d).getDay();
    const isOpen = !!HOURS[dow];

    return json({ date, isOpen, slots: availableSlots });
  }

  // ── GET: list all pickups (for portal) ─────────────────────────
  if (req.method === "GET" && action === "pickups") {
    const status = url.searchParams.get("status") || "";
    const query  = status
      ? `?status=eq.${status}&order=pickup_date.asc,pickup_time.asc`
      : `?order=pickup_date.asc,pickup_time.asc&limit=200`;
    const pickups = await sbSelect("ecopack_pickups", query);
    return json(pickups);
  }

  // ── POST: actions ───────────────────────────────────────────────
  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

    // BOOK a pickup
    if (body.action === "book") {
      const { client_name, wa_number, email, pickup_date, pickup_time, package_count, notes } = body;
      if (!client_name || !pickup_date || !pickup_time) {
        return json({ error: "client_name, pickup_date, pickup_time required" }, 400);
      }

      // Validate date is a business day
      const [y, m, d] = pickup_date.split("-").map(Number);
      const dow = new Date(y, m - 1, d).getDay();
      if (!HOURS[dow]) return json({ error: "Selected date is not a business day" }, 400);

      // Check slot availability
      const booked = await sbSelect(
        "ecopack_pickups",
        `?pickup_date=eq.${pickup_date}&pickup_time=eq.${pickup_time}&status=not.in.(cancelled)&select=id`
      );
      if (booked.length >= MAX_PER_SLOT) {
        return json({ error: "This slot is fully booked. Please select another time." }, 409);
      }

      // Insert pickup record
      const [newPickup] = await sbInsert("ecopack_pickups", {
        client_name,
        wa_number:    (wa_number || "").replace(/\D/g, ""),
        email:        email || "",
        pickup_date,
        pickup_time,
        package_count: parseInt(package_count) || 1,
        status:       "scheduled",
        notes:        notes || ""
      });

      console.log(`[ecopack] Pickup booked: ${client_name} | ${pickup_date} ${pickup_time}`);

      // Send WA confirmation if phone provided
      let waMsgId = null;
      if (wa_number) {
        try {
          waMsgId = await sendPickupConfirmation(wa_number, client_name, pickup_date, pickup_time, package_count || 1);
          console.log(`[ecopack] WA confirmation sent | id: ${waMsgId}`);
        } catch (e) {
          console.error(`[ecopack] WA error: ${e.message}`);
        }
      }

      return json({ ok: true, pickup: newPickup, waMsgId });
    }

    // COMPLETE a pickup
    if (body.action === "complete" && body.id) {
      await sbPatch("ecopack_pickups", `id=eq.${body.id}`, {
        status: "completed",
        completed_at: new Date().toISOString()
      });
      return json({ ok: true });
    }

    // CANCEL a pickup
    if (body.action === "cancel" && body.id) {
      await sbPatch("ecopack_pickups", `id=eq.${body.id}`, { status: "cancelled" });
      return json({ ok: true });
    }

    // NOTIFY client of package arrival (called from Inbound_Outbound.html)
    if (body.action === "notify") {
      const { wa_number, client_name, package_count } = body;
      if (!wa_number || !client_name) return json({ error: "wa_number and client_name required" }, 400);
      const result = await sendPackageAlert(wa_number, client_name, package_count || 1);
      return json({ ok: true, ...result });
    }

    return json({ error: "Unknown action" }, 400);
  }

  return json({ error: "Method not allowed" }, 405);
}

export const config = {
  path: "/.netlify/functions/ecopack"
};
