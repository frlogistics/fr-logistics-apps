// netlify/functions/daily-summary.js
// Scheduled daily at 11PM UTC (7PM EST)
// Reads TODAY's movements from shipments_general
// Groups by client → sends daily_summary WA to each client with activity
// Always sends a copy to FR-Logistics monitoring number (+17867757335)

const SUPABASE_URL  = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY  = Netlify.env.get("SUPABASE_SERVICE_KEY");
const PHONE_ID      = Netlify.env.get("WHATSAPP_PHONE_ID");
const WA_TOKEN      = Netlify.env.get("WHATSAPP_TOKEN");
const FR_MONITOR    = Netlify.env.get("FR_MONITOR_WA") || "17867757335";  // CC interno — FR-Logistics ops
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

// ── Client matching ───────────────────────────────────────────────
//
// `shipments_general.client` is written from dropship_client_configs
// .client_name_billing, which does NOT always equal the fr_clients fields
// character for character. Real case found 2026-08-03: LN Store had
// "LN Store, LLC" (with comma) in shipments_general while fr_clients holds
// company "LN Store LLC" (no comma) and store_name "LN -Store". Exact
// comparison never matched, so that client silently never received a single
// daily report despite 91 inbound and 94 outbound movements on record.
//
// Fix: try exact first (unchanged behaviour, zero risk), then fall back to a
// punctuation-insensitive comparison.
//
// SAFETY: a loose match must never send one client's numbers to another
// client. If a normalized key resolves to more than one distinct fr_clients
// row, we refuse to guess — no message is sent and the ambiguity is logged.
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")   // punctuation, &, hyphens → space
    .replace(/\s+/g, " ")
    .trim();
}

function waDigits(c) {
  return String(c.wa_number || "").replace(/[^0-9]/g, "").length;
}

// Build { normalizedKey → [client, ...] } across name / company / store_name.
function buildClientIndex(clients) {
  const idx = new Map();
  for (const c of clients) {
    for (const field of ["name", "company", "store_name"]) {
      const key = norm(c[field]);
      if (!key) continue;
      if (!idx.has(key)) idx.set(key, []);
      const bucket = idx.get(key);
      if (!bucket.some(x => x.id === c.id)) bucket.push(c);
    }
  }
  return idx;
}

// Resolve a set of candidates down to one, or to nobody.
// Duplicates are real in fr_clients: "FR-Logistics" exists twice (Jose and
// Joe) and "Pacific Horizon Investments LLC" twice (Jose V. and Shamy). The
// original code used .find(), which silently returned whichever row happened
// to come first — including rows with notifications off. Tie-break on who is
// actually reachable; if that still leaves more than one, send nothing.
function pickOne(candidates, label, how) {
  if (candidates.length === 1) return candidates[0];

  const reachable = candidates.filter(c => c.wa_notifications && waDigits(c) >= 10);
  if (reachable.length === 1) {
    console.log(`[daily-summary] "${label}" matched ${candidates.length} rows (${how}) → picked ${reachable[0].name} (only one with notifications on)`);
    return reachable[0];
  }

  console.warn(
    `[daily-summary] AMBIGUOUS "${label}" (${how}) → ` +
    candidates.map(c => `${c.name} / ${c.company} (${c.id})`).join(" | ") +
    " — refusing to guess, nothing sent"
  );
  return null;
}

function matchClient(movementClientName, clients, index) {
  const q = movementClientName.toLowerCase().trim();

  // 1. Exact match — original behaviour, but collecting ALL hits instead of
  //    taking the first blindly.
  const exact = clients.filter(c =>
    (c.name        && c.name.toLowerCase().trim()       === q) ||
    (c.company     && c.company.toLowerCase().trim()    === q) ||
    (c.store_name  && c.store_name.toLowerCase().trim() === q)
  );
  if (exact.length) return pickOne(exact, movementClientName, "exact");

  // 2. Punctuation-insensitive fallback. Real case: shipments_general holds
  //    "LN Store, LLC" (with comma) while fr_clients has company
  //    "LN Store LLC" (no comma) and store_name "LN -Store", so exact
  //    comparison never matched and that client never got a single report.
  const bucket = index.get(norm(movementClientName));
  if (!bucket || bucket.length === 0) return null;
  const hit = pickOne(bucket, movementClientName, "normalized");
  if (hit) console.log(`[daily-summary] normalized match: "${movementClientName}" → ${hit.company || hit.name}`);
  return hit;
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
    const clientIndex = buildClientIndex(clients);

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
      const reg = matchClient(clientName, clients, clientIndex);

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
