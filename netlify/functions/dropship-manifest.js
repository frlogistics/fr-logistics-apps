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
const RESEND_KEY    = Netlify.env.get("RESEND_API_KEY");
const SITE_URL      = "https://apps.fr-logistics.net";

// ─── Ops digest (internal copy to operations) ─────────────────────────────
// After sending the per-client manifests, we also notify Jose with:
//   - 1 WhatsApp consolidated message (quick mobile glance)
//   - 1 email with full HTML breakdown (archivable, searchable)
const OPS_WHATSAPP_NUMBER = "13052403172";          // Jose's mobile (no '+', no spaces)
const OPS_EMAIL_TO        = "josefuentes@fr-logistics.net";
const OPS_EMAIL_FROM      = "FR-Logistics <ops@fr-logistics.net>";
const OPS_EMAIL_FROM_FALLBACK = "onboarding@resend.dev";

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

// ─── WhatsApp send (DIRECT to Meta Graph API — bypasses whatsapp-notify) ─────
// We call Meta directly for two reasons:
//   1. Function-to-function calls in Netlify hit routing edge cases when the
//      target function uses a custom config.path
//   2. Skipping the intermediate hop is faster and removes a failure point
//
// Language handling: Meta requires the EXACT language code the template was
// approved with. Our daily_summary is currently only approved in en_US, so
// we automatically fall back to en_US if the requested language doesn't exist.
async function sendWhatsAppMeta({ to, templateName, templateLanguage = "en_US", templateParams = [], fallbackText = "" }) {
  const WA_TOKEN    = Netlify.env.get("WHATSAPP_TOKEN");
  const WA_PHONE_ID = Netlify.env.get("WHATSAPP_PHONE_ID");
  if (!WA_TOKEN)    throw new Error("WHATSAPP_TOKEN not configured");
  if (!WA_PHONE_ID) throw new Error("WHATSAPP_PHONE_ID not configured");

  // Normalize the phone: digits only. Meta wants 13052403172 (no '+', no spaces).
  const phone = String(to || "").replace(/\D/g, "");
  if (!phone) throw new Error("recipient phone is empty");
  if (phone.length < 10) throw new Error(`recipient phone too short: ${phone}`);

  const url = `https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`;

  const buildBody = (langCode) => ({
    messaging_product: "whatsapp",
    to: phone,
    type: "template",
    template: {
      name: templateName,
      language: { code: langCode },
      components: [{
        type: "body",
        parameters: templateParams.map(p => ({ type: "text", text: String(p ?? "") }))
      }]
    }
  });

  const tryLang = async (langCode) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildBody(langCode))
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, json: j, lang_used: langCode };
  };

  // First attempt: requested language
  let result = await tryLang(templateLanguage);

  // Fallback chain: if the requested lang isn't in Meta's translation list,
  // try the most-likely-approved variant. Specifically Meta error 132001
  // "Template name does not exist in the translation" means the template
  // exists but not in this language.
  const fallbackChain = [];
  if (templateLanguage !== "en_US") fallbackChain.push("en_US");
  if (templateLanguage !== "en")    fallbackChain.push("en");

  for (const fb of fallbackChain) {
    if (result.ok) break;
    const errCode = result.json?.error?.code;
    const errMsg  = result.json?.error?.message || "";
    const isLangMissing = errCode === 132001 || /does not exist in the translation/i.test(errMsg);
    if (!isLangMissing) break;  // some other error, don't retry
    console.warn(`[wa-meta] template ${templateName} not in ${result.lang_used}, retrying with ${fb}`);
    result = await tryLang(fb);
  }

  if (!result.ok) {
    const errMsg = result.json?.error?.message || JSON.stringify(result.json);
    throw new Error(`Meta ${result.status}: ${errMsg}`);
  }
  return { ok: true, message_id: result.json?.messages?.[0]?.id || null, lang_used: result.lang_used };
}

// Best-effort log to wa-messages (audit trail). Failures here are not fatal.
async function logWhatsAppOutbound({ to, clientName, templateName, fallbackText }) {
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
}

// Per-client manifest send.
// We try the client's preferred language first, with automatic fallback
// to en_US handled inside sendWhatsAppMeta if the template isn't translated.
async function sendWhatsAppTemplate({ to, clientName, dateLabel, inbound, outbound, lang = "en_US" }) {
  const templateName     = "daily_summary";
  // Map our client lang values to Meta's exact language codes.
  // daily_summary is currently only approved in en_US, but if we ever add
  // an "es" version, this will pick it up automatically.
  const langMap = { ES: "es", es: "es", EN: "en_US", en: "en_US", "en_US": "en_US" };
  const templateLanguage = langMap[lang] || "en_US";
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

  const r = await sendWhatsAppMeta({ to, templateName, templateLanguage, templateParams, fallbackText });
  await logWhatsAppOutbound({ to, clientName, templateName, fallbackText });
  return { ok: true, fallbackText, ...r };
}

// ─── Ops digest: send a consolidated WhatsApp to Jose ─────────────────────
// Uses the same daily_summary template (already approved). The "client name"
// slot becomes "Operations" so Jose sees an internal-style message.
// We aggregate received/shipped totals across ALL clients processed today.
async function sendOpsWhatsAppDigest({ dateLabel, totals, sentClients, errors }) {
  const inbound  = totals.received;
  const outbound = totals.shipped;
  // Use daily_summary template — same one used for clients, with "Operations" as recipient name
  const templateName     = "daily_summary";
  const templateLanguage = "en_US";  // template is approved in en_US
  const templateParams   = [
    "Operations",
    String(dateLabel || ""),
    String(inbound),
    String(outbound)
  ];
  // Fallback text gets richer detail since template is rigid
  let fallbackText =
    `Hi Operations, here is your daily summary from FR-Logistics Miami — ${dateLabel}: ` +
    `Inbound: ${inbound} package(s) received. Outbound: ${outbound} shipment(s) processed across ${sentClients} client(s).`;
  if (errors > 0) fallbackText += ` ${errors} send error(s) — check email digest for details.`;

  const r = await sendWhatsAppMeta({
    to: OPS_WHATSAPP_NUMBER,
    templateName,
    templateLanguage,
    templateParams,
    fallbackText
  });
  await logWhatsAppOutbound({
    to: OPS_WHATSAPP_NUMBER,
    clientName: "Operations (internal)",
    templateName,
    fallbackText
  });
  return { ok: true, ...r };
}

// ─── Ops digest: send the rich HTML email to Jose ─────────────────────────
async function sendOpsEmailDigest({ dateLabel, today, perClient, totals }) {
  if (!RESEND_KEY) { console.warn("[ops-digest] RESEND_API_KEY not configured, skipping email"); return { skipped: true }; }

  const sentRows  = perClient.filter(c => c.action === "sent");
  const skipRows  = perClient.filter(c => c.action && c.action.startsWith("skip:"));
  const errorRows = perClient.filter(c => c.action === "error");

  const subject = errorRows.length
    ? `📦 Daily Manifest — ${dateLabel} — ${errorRows.length} ERROR(S)`
    : `📦 Daily Manifest — ${dateLabel} — ${totals.shipped} shipped across ${sentRows.length} client(s)`;

  const sentTableRows = sentRows.length ? sentRows.map(c => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:600;">${escapeHtml(c.client_label || "—")}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#64748b;font-family:monospace;">${escapeHtml(c.wa_number || "—")}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;text-align:right;color:#1e40af;">${c.received}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;text-align:right;color:#16a34a;font-weight:700;">${c.shipped}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:11px;text-align:right;color:#64748b;">${c.marked_rows || 0}</td>
    </tr>
  `).join("") : `<tr><td colspan="5" style="padding:20px;text-align:center;color:#94a3b8;font-size:13px;">No manifests sent today</td></tr>`;

  const errorBlock = errorRows.length ? `
    <h3 style="margin:24px 0 8px 0;font-size:14px;color:#dc2626;">⚠️ Send errors</h3>
    <table style="width:100%;border-collapse:collapse;background:#fef2f2;border-radius:8px;overflow:hidden;">
      ${errorRows.map(c => `
        <tr>
          <td style="padding:8px 12px;font-size:12px;font-weight:600;width:30%;">${escapeHtml(c.client_label || c.client_id || "—")}</td>
          <td style="padding:8px 12px;font-size:12px;font-family:monospace;color:#991b1b;">${escapeHtml(c.error || "Unknown")}</td>
        </tr>
      `).join("")}
    </table>
  ` : "";

  const skipBlock = skipRows.length ? `
    <details style="margin-top:16px;">
      <summary style="cursor:pointer;font-size:12px;color:#64748b;padding:6px 0;">
        ${skipRows.length} client(s) skipped (no activity / no WA consent)
      </summary>
      <table style="width:100%;border-collapse:collapse;margin-top:8px;background:#f8fafc;border-radius:8px;overflow:hidden;font-size:12px;">
        ${skipRows.map(c => `
          <tr>
            <td style="padding:6px 10px;color:#64748b;width:50%;">${escapeHtml(c.client_label || c.client_id || "—")}</td>
            <td style="padding:6px 10px;color:#94a3b8;font-family:monospace;font-size:11px;">${escapeHtml(c.action.replace("skip:", ""))}</td>
            <td style="padding:6px 10px;text-align:right;color:#64748b;font-size:11px;">recv:${c.received} · ship:${c.shipped}</td>
          </tr>
        `).join("")}
      </table>
    </details>
  ` : "";

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:720px;margin:0 auto;padding:24px;background:#f4f6f9;">
      <div style="background:#fff;border-radius:14px;padding:28px;border:1px solid #e2e8f0;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
          <span style="font-size:24px;">📦</span>
          <h1 style="margin:0;font-size:20px;color:#1a202c;">Daily Manifest Sent</h1>
        </div>
        <p style="color:#64748b;font-size:13px;margin:0 0 20px 0;">${dateLabel} · day boundary in UTC (${today})</p>

        <div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;">
          <div style="flex:1;min-width:130px;background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:14px;">
            <div style="font-size:11px;color:#166534;text-transform:uppercase;letter-spacing:.06em;font-weight:600;">Shipped today</div>
            <div style="font-size:28px;color:#15803d;font-weight:800;line-height:1;margin-top:4px;">${totals.shipped}</div>
          </div>
          <div style="flex:1;min-width:130px;background:#dbeafe;border:1px solid #93c5fd;border-radius:10px;padding:14px;">
            <div style="font-size:11px;color:#1e40af;text-transform:uppercase;letter-spacing:.06em;font-weight:600;">Received today</div>
            <div style="font-size:28px;color:#1d4ed8;font-weight:800;line-height:1;margin-top:4px;">${totals.received}</div>
          </div>
          <div style="flex:1;min-width:130px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;">
            <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;font-weight:600;">Manifests sent</div>
            <div style="font-size:28px;color:#1a202c;font-weight:800;line-height:1;margin-top:4px;">${sentRows.length}</div>
          </div>
        </div>

        <h3 style="margin:0 0 8px 0;font-size:14px;color:#1a202c;">Per-client breakdown</h3>
        <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
          <thead>
            <tr style="background:#f8fafc;">
              <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #e2e8f0;">Client</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #e2e8f0;">WA</th>
              <th style="padding:10px 12px;text-align:right;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #e2e8f0;">Received</th>
              <th style="padding:10px 12px;text-align:right;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #e2e8f0;">Shipped</th>
              <th style="padding:10px 12px;text-align:right;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #e2e8f0;">Marked</th>
            </tr>
          </thead>
          <tbody>${sentTableRows}</tbody>
        </table>

        ${errorBlock}
        ${skipBlock}

        <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;">
          <a href="${SITE_URL}/portal.html#app=dropshipments.html"
             style="display:inline-block;background:#1fa463;color:#fff;text-decoration:none;padding:10px 20px;border-radius:9px;font-weight:600;font-size:14px;">
            Open Dropshipments →
          </a>
        </div>
        <p style="color:#94a3b8;font-size:11px;margin-top:20px;text-align:center;">
          Automated daily manifest digest from FR-Logistics Dropshipments<br>
          Sent ${new Date().toISOString()}
        </p>
      </div>
    </div>
  `;

  // Try branded sender first, fallback to Resend's default if domain not verified.
  async function tryResend(from) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [OPS_EMAIL_TO], subject, html })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Resend ${r.status}: ${j.message || JSON.stringify(j)}`);
    return j;
  }
  try {
    return { ok: true, ...(await tryResend(OPS_EMAIL_FROM)) };
  } catch (e) {
    console.warn("[ops-digest] branded sender failed, retrying default:", e.message);
    return { ok: true, fallback: true, ...(await tryResend(OPS_EMAIL_FROM_FALLBACK)) };
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
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

  // ─── Ops digests (Option D: WhatsApp + Email to Jose) ───────────────────
  // Aggregate totals across all clients in this run.
  const totals = {
    received: result.clients.reduce((sum, c) => sum + (c.received || 0), 0),
    shipped:  result.clients.reduce((sum, c) => sum + (c.shipped  || 0), 0)
  };
  result.totals = totals;
  result.ops_digest = { whatsapp: null, email: null };

  // Don't spam ops on dry runs.
  // Don't send if literally nothing happened (no clients processed at all),
  // unless force=1 was passed for testing purposes.
  const hasAnyActivity = result.total_sent > 0 || result.total_errors > 0 || force;

  if (!dryRun && hasAnyActivity) {
    // 1. WhatsApp consolidated to Jose
    try {
      await sendOpsWhatsAppDigest({
        dateLabel,
        totals,
        sentClients: result.total_sent,
        errors: result.total_errors
      });
      result.ops_digest.whatsapp = { ok: true, to: OPS_WHATSAPP_NUMBER };
    } catch (e) {
      console.error("[dropship-manifest] ops WA digest failed:", e.message);
      result.ops_digest.whatsapp = { ok: false, error: e.message };
    }

    // 2. Email digest to Jose with full HTML breakdown
    try {
      const emailRes = await sendOpsEmailDigest({
        dateLabel,
        today,
        perClient: result.clients,
        totals
      });
      result.ops_digest.email = { ok: true, to: OPS_EMAIL_TO, ...emailRes };
    } catch (e) {
      console.error("[dropship-manifest] ops email digest failed:", e.message);
      result.ops_digest.email = { ok: false, error: e.message };
    }
  } else if (dryRun) {
    result.ops_digest.note = "skipped:dry_run";
  } else {
    result.ops_digest.note = "skipped:no_activity";
  }

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
      ops_digest: {
        whatsapp_to: OPS_WHATSAPP_NUMBER,
        email_to:    OPS_EMAIL_TO,
        email_from:  OPS_EMAIL_FROM,
        resend_configured: !!RESEND_KEY
      },
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
