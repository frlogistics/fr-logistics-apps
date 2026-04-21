// netlify/functions/dropship-manifest.js
// Dropshipments · Daily client manifest via WhatsApp
//
// Purpose
// ───────
// At 7 PM Miami (11 PM UTC) each day, send a WhatsApp daily_summary to each
// active dropshipment client with counts of today's activity:
//   {{1}} client name
//   {{2}} human-readable date ("Tuesday, April 21")
//   {{3}} received today count (physical_received_at::date = today UTC)
//   {{4}} shipped today count (shipped_at::date = today UTC)
//
// Behavior
// ───────
// - Scheduled: fires once per day at 11 PM UTC via netlify.toml
// - Manual: POST with optional ?dry_run=1 or ?client_id={uuid} overrides
// - Only sends to clients that have:
//     * a dropship config (dropship_client_configs)
//     * a wa_number on fr_clients
//     * wa_notifications = true OR wa_consent = 'Yes' on fr_clients
// - Only sends if the client had ≥1 shipped row today (unless
//   force=1 is passed in manual mode, for dry-run previewing)
// - After a successful send, marks the manifest-included shipped rows with
//   manifest_sent_at so we never double-report the same day
// - Logs the outbound message to wa-messages (add_outbound) for audit trail
//
// Endpoints
// ───────
//   GET  ?action=info                          → health & config
//   POST                                       → run (scheduled or manual)
//   POST ?dry_run=1                            → preview, no sends, no DB writes
//   POST ?client_id={uuid}                     → run for a single client
//   POST ?force=1                              → send even if no shipped today
//                                               (useful for testing)

const SUPABASE_URL  = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY  = Netlify.env.get("SUPABASE_SERVICE_KEY");
const WA_SECRET     = Netlify.env.get("WHATSAPP_WEBHOOK_SECRET") || "frlogistics_wa_2026";
const SITE_URL      = "https://apps.fr-logistics.net";

// ─── Supabase helpers ────────────────────────────────────────────────────────
const SB = () => ({ "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" });
async function sbSelect(t, q = "") { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}${q}`, { headers: SB() }); if (!r.ok) throw new Error(`sbSelect ${t}: ${await r.text()}`); return r.json(); }
async function sbPatch(t, f, d) { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}?${f}`, { method: "PATCH", headers: { ...SB(), "Prefer": "return=representation" }, body: JSON.stringify(d) }); if (!r.ok) throw new Error(`sbPatch ${t}: ${await r.text()}`); return r.json(); }

// ─── Date helpers ─────────────────────────────────────────────────────────────
// Everything is UTC-based. A "day" boundary is UTC midnight → next UTC midnight.
function todayUtcDate() {
  const d = new Date();
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
function prettyDate(d = new Date()) {
  // e.g. "Tuesday, April 21"
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

// ─── Eligibility filter ───────────────────────────────────────────────────────
// A client is eligible if they have a wa_number AND either
// wa_notifications=true OR wa_consent ∈ {"Yes", "Opted In"}.
function clientEligible(c) {
  if (!c) return false;
  if (!c.wa_number) return false;
  const consentYes = c.wa_consent === "Yes" || c.wa_consent === "Opted In";
  return !!(c.wa_notifications || consentYes);
}
function clientLabel(c) {
  return c.store_name || c.company || c.name || "Client";
}

// ─── WhatsApp send (via our existing whatsapp-notify endpoint) ────────────────
async function sendWhatsAppTemplate({ to, clientName, dateLabel, inbound, outbound, lang = "en" }) {
  const templateName     = "daily_summary";
  const templateLanguage = lang === "ES" || lang === "es" ? "es" : "en";
  const templateParams   = [
    String(clientName || ""),
    String(dateLabel  || ""),
    String(inbound    || "0"),
    String(outbound   || "0")
  ];
  const fallbackText =
    `Hi ${clientName}, here is your daily summary from FR-Logistics Miami — ${dateLabel}: ` +
    `Inbound: ${inbound} package(s) received. Outbound: ${outbound} shipment(s) processed. ` +
    `For full details contact us at info@fr-logistics.net.`;

  const r = await fetch(`${SITE_URL}/.netlify/functions/whatsapp-notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-fr-secret": WA_SECRET },
    body: JSON.stringify({
      to,
      type: "template",
      templateName,
      templateLanguage,
      templateParams,
      fallbackText
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`wa-notify ${r.status}: ${j.error || JSON.stringify(j)}`);

  // Log to wa-messages (best-effort, non-fatal if it fails)
  try {
    await fetch(`${SITE_URL}/.netlify/functions/wa-messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action:     "add_outbound",
        to,
        clientName,
        template:   templateName,
        text:       fallbackText
      })
    });
  } catch (e) {
    console.warn("[dropship-manifest] wa-messages log failed:", e.message);
  }

  return { ok: true, fallbackText, ...j };
}

// ─── Core: build per-client summary for today (UTC) ──────────────────────────
async function buildClientSummaries({ onlyClientId = null } = {}) {
  const today = todayUtcDate();

  // All rows that touched "today" in either pipeline step.
  // We fetch BOTH received_today and shipped_today buckets with 2 cheap queries.
  const [receivedToday, shippedToday, configs] = await Promise.all([
    sbSelect("dropshipments",
      `?physical_received_at=gte.${today}T00:00:00Z&physical_received_at=lt.${today}T23:59:59.999Z&select=id,client_id,status,physical_received_at`
    ),
    sbSelect("dropshipments",
      `?status=eq.shipped&shipped_at=gte.${today}T00:00:00Z&shipped_at=lt.${today}T23:59:59.999Z&select=id,client_id,shipped_at,manifest_sent_at`
    ),
    sbSelect("dropship_client_configs",
      "?active=eq.true&select=client_id,client_code,display_name,rate_per_package"
    )
  ]);

  const cfgMap = {};
  for (const c of configs) cfgMap[c.client_id] = c;

  // Fetch fr_clients info for only the clients we actually need.
  const clientIds = Array.from(new Set([
    ...receivedToday.map(r => r.client_id),
    ...shippedToday.map(r => r.client_id),
    ...configs.map(c => c.client_id)
  ].filter(Boolean)));

  if (clientIds.length === 0) {
    return { today, summaries: [] };
  }

  const clients = clientIds.length
    ? await sbSelect("fr_clients", `?id=in.(${clientIds.join(",")})&select=id,name,company,store_name,wa_number,wa_consent,wa_notifications,lang`)
    : [];
  const clientMap = {};
  for (const c of clients) clientMap[c.id] = c;

  // Aggregate counts per client.
  const bucket = {}; // clientId → { received, shipped, shipped_ids_not_yet_reported }
  const ensure = (cid) => (bucket[cid] = bucket[cid] || { received: 0, shipped: 0, shipped_ids: [] });

  for (const r of receivedToday) {
    if (!r.client_id) continue;
    ensure(r.client_id).received += 1;
  }
  for (const s of shippedToday) {
    if (!s.client_id) continue;
    const b = ensure(s.client_id);
    b.shipped += 1;
    // Only mark rows that haven't been reported yet (for the PATCH later)
    if (!s.manifest_sent_at) b.shipped_ids.push(s.id);
  }

  // Compose final summaries (one per eligible client).
  const summaries = [];
  for (const cid of Object.keys(bucket)) {
    if (onlyClientId && cid !== onlyClientId) continue;
    const cfg    = cfgMap[cid];
    const client = clientMap[cid];
    const counts = bucket[cid];
    summaries.push({
      client_id:     cid,
      config:        cfg || null,
      client:        client || null,
      eligible:      clientEligible(client),
      received:      counts.received,
      shipped:       counts.shipped,
      shipped_ids:   counts.shipped_ids
    });
  }

  // If onlyClientId was passed but no activity, still return one entry so
  // manual invocations don't come back empty.
  if (onlyClientId && !summaries.find(s => s.client_id === onlyClientId)) {
    const cfg    = cfgMap[onlyClientId];
    const client = clientMap[onlyClientId];
    if (cfg || client) {
      summaries.push({
        client_id: onlyClientId,
        config: cfg || null,
        client: client || null,
        eligible: clientEligible(client),
        received: 0,
        shipped: 0,
        shipped_ids: []
      });
    }
  }

  return { today, summaries };
}

// ─── Core run ────────────────────────────────────────────────────────────────
async function run({ dryRun = false, onlyClientId = null, force = false } = {}) {
  const started = new Date().toISOString();
  const dateLabel = prettyDate();
  const { today, summaries } = await buildClientSummaries({ onlyClientId });

  const result = {
    started,
    today_utc: today,
    date_label: dateLabel,
    dry_run: dryRun,
    scope: onlyClientId ? `client_id=${onlyClientId}` : "all active clients",
    clients: []
  };

  for (const s of summaries) {
    const entry = {
      client_id:     s.client_id,
      client_label:  s.client ? clientLabel(s.client) : null,
      received:      s.received,
      shipped:       s.shipped,
      eligible:      s.eligible,
      wa_number:     s.client?.wa_number || null,
      action:        null,
      error:         null,
      marked_rows:   0
    };

    if (!s.client) { entry.action = "skip:no_fr_client_record"; result.clients.push(entry); continue; }
    if (!s.eligible) { entry.action = "skip:no_wa_consent_or_number"; result.clients.push(entry); continue; }
    if (s.shipped === 0 && s.received === 0 && !force) { entry.action = "skip:no_activity_today"; result.clients.push(entry); continue; }

    const payload = {
      to:          s.client.wa_number,
      clientName:  clientLabel(s.client),
      dateLabel,
      inbound:     s.received,
      outbound:    s.shipped,
      lang:        s.client.lang
    };

    if (dryRun) {
      entry.action = "dry_run:would_send";
      entry.payload_preview = payload;
      result.clients.push(entry);
      continue;
    }

    try {
      await sendWhatsAppTemplate(payload);
      entry.action = "sent";

      // Mark shipped rows as manifest-included (only those not already marked).
      if (s.shipped_ids.length) {
        const now = new Date().toISOString();
        await sbPatch("dropshipments",
          `id=in.(${s.shipped_ids.join(",")})`,
          { manifest_sent_at: now }
        );
        entry.marked_rows = s.shipped_ids.length;
      }
    } catch (e) {
      console.error(`[dropship-manifest] send failed for ${s.client_id}:`, e.message);
      entry.action = "error";
      entry.error = e.message;
    }

    result.clients.push(entry);
  }

  result.finished = new Date().toISOString();
  result.total_clients = result.clients.length;
  result.total_sent    = result.clients.filter(c => c.action === "sent").length;
  result.total_errors  = result.clients.filter(c => c.action === "error").length;
  return result;
}

// ─── HTTP handler ────────────────────────────────────────────────────────────
const CORS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,Authorization" };
const jRes = (d, s = 200) => new Response(JSON.stringify(d, null, 2), { status: s, headers: CORS });

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const dryRun       = url.searchParams.get("dry_run") === "1";
  const force        = url.searchParams.get("force") === "1";
  const onlyClientId = url.searchParams.get("client_id") || null;

  const ua = req.headers.get("user-agent") || "";
  const isScheduled =
    req.headers.get("x-nf-event") === "schedule" ||
    ua.toLowerCase().includes("netlify-scheduled");

  // Info endpoint
  if (req.method === "GET" && url.searchParams.get("action") === "info") {
    return jRes({
      module: "dropship-manifest",
      template_used: "daily_summary",
      mode: "manual + scheduled (daily at 11 PM UTC / 7 PM Miami)",
      schedule: "0 23 * * *",
      usage: {
        run:         "POST /.netlify/functions/dropship-manifest",
        dry_run:     "POST /.netlify/functions/dropship-manifest?dry_run=1",
        single:      "POST /.netlify/functions/dropship-manifest?client_id={uuid}",
        force_empty: "POST /.netlify/functions/dropship-manifest?client_id={uuid}&force=1"
      }
    });
  }

  const shouldRun = req.method === "POST" || isScheduled;
  if (!shouldRun) return jRes({ error: "Method not allowed. POST to run." }, 405);

  try {
    const result = await run({ dryRun, onlyClientId, force });
    if (isScheduled) {
      console.log(`[dropship-manifest] scheduled: ${result.total_sent} sent, ${result.total_errors} errors across ${result.total_clients} clients`);
    }
    return jRes({ ok: true, scheduled: isScheduled, ...result });
  } catch (e) {
    console.error("[dropship-manifest] fatal:", e);
    return jRes({ ok: false, error: e.message, stack: e.stack }, 500);
  }
}
