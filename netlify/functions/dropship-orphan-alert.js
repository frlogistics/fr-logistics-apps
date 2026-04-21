// netlify/functions/dropship-orphan-alert.js
// Dropshipments · Orphan alert scheduled function
//
// Scans dropshipments for orphans that have been sitting for longer than their
// client's orphan_grace_hours, and haven't been alerted yet (orphan_alerted_at IS NULL).
// Sends a single consolidated email to josefuentes@fr-logistics.net via Resend.
//
// Schedule: runs every 2 hours (see netlify.toml, offset from gmail-sync).
//
// Can also be invoked manually:
//   POST /.netlify/functions/dropship-orphan-alert              → send alerts
//   POST /.netlify/functions/dropship-orphan-alert?dry_run=1    → preview without sending/updating
//   GET  /.netlify/functions/dropship-orphan-alert?action=info  → health/config

const SUPABASE_URL  = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY  = Netlify.env.get("SUPABASE_SERVICE_KEY");
const RESEND_KEY    = Netlify.env.get("RESEND_API_KEY");

const ALERT_TO       = "josefuentes@fr-logistics.net";
const ALERT_FROM     = "FR-Logistics <alerts@fr-logistics.net>"; // must be a verified domain in Resend
const ALERT_FROM_FALLBACK = "onboarding@resend.dev";              // Resend's default sender if domain not yet verified

// ─── Supabase helpers ────────────────────────────────────────────────────────
const SB = () => ({ "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" });
async function sbSelect(t, q = "") { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}${q}`, { headers: SB() }); if (!r.ok) throw new Error(`sbSelect ${t}: ${await r.text()}`); return r.json(); }
async function sbPatch(t, f, d) { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}?${f}`, { method: "PATCH", headers: { ...SB(), "Prefer": "return=representation" }, body: JSON.stringify(d) }); if (!r.ok) throw new Error(`sbPatch ${t}: ${await r.text()}`); return r.json(); }

// ─── Resend helper ───────────────────────────────────────────────────────────
async function sendEmail({ to, subject, html, from = ALERT_FROM }) {
  if (!RESEND_KEY) throw new Error("RESEND_API_KEY not configured");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: Array.isArray(to) ? to : [to], subject, html })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // If the branded "from" fails (domain not verified yet), retry with Resend's default.
    if (from !== ALERT_FROM_FALLBACK) {
      console.warn(`Resend send with ${from} failed; retrying with ${ALERT_FROM_FALLBACK}`);
      return sendEmail({ to, subject, html, from: ALERT_FROM_FALLBACK });
    }
    throw new Error(`Resend: ${r.status} ${j.message || JSON.stringify(j)}`);
  }
  return j;
}

// ─── Orphan query + email body ───────────────────────────────────────────────
// Returns orphan rows that have been sitting beyond each client's grace window,
// joined with client + config info.
async function findAlertableOrphans() {
  const SELECT = "id,client_id,tracking_number,order_id,content,qty_boxes,notes,physical_received_at,received_by,orphan_alerted_at,client:fr_clients(id,name,company,store_name)";
  // Fetch all unalerted orphans (usually small — single-digit counts).
  const rows = await sbSelect("dropshipments", `?status=eq.orphan&orphan_alerted_at=is.null&select=${SELECT}&order=physical_received_at.asc.nullslast`);

  // Load configs so we can apply per-client orphan_grace_hours.
  const configs = await sbSelect("dropship_client_configs", "?select=client_id,client_code,display_name,orphan_grace_hours");
  const cfgMap = {};
  for (const c of configs) cfgMap[c.client_id] = c;

  const now = Date.now();
  const alertable = [];
  for (const r of rows) {
    const cfg = cfgMap[r.client_id];
    if (!cfg) continue;
    const grace = (cfg.orphan_grace_hours || 6) * 3600 * 1000;
    const recAt = r.physical_received_at ? new Date(r.physical_received_at).getTime() : null;
    if (!recAt) continue;
    const ageMs = now - recAt;
    if (ageMs >= grace) {
      alertable.push({ ...r, _config: cfg, _age_hours: Math.round(ageMs / 3600000) });
    }
  }
  return alertable;
}

function buildEmailHtml(orphans) {
  const n = orphans.length;
  const subject = n === 1 ? `🎯 Orphan pending — 1 package awaiting email` : `🎯 ${n} orphans pending — packages awaiting emails`;
  const rowsHtml = orphans.map(o => {
    const client = o._config?.display_name || o.client?.company || "—";
    const recAt = o.physical_received_at
      ? new Date(o.physical_received_at).toLocaleString("en-US", { day:"2-digit", month:"short", hour:"2-digit", minute:"2-digit", hour12:false })
      : "—";
    const notes = o.notes ? `<div style="color:#64748b;font-size:12px;margin-top:3px;">${escapeHtml(o.notes)}</div>` : "";
    return `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-family:monospace;font-size:13px;vertical-align:top;">${escapeHtml(o.tracking_number)}${notes}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;vertical-align:top;">${escapeHtml(client)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#64748b;vertical-align:top;">${recAt}<br><strong style="color:#be185d;">${o._age_hours}h ago</strong></td>
        <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#64748b;vertical-align:top;">${escapeHtml(o.received_by || "—")}</td>
      </tr>
    `;
  }).join("");

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:680px;margin:0 auto;padding:24px;background:#f4f6f9;">
      <div style="background:#fff;border-radius:14px;padding:28px;border:1px solid #e2e8f0;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
          <span style="font-size:24px;">🎯</span>
          <h1 style="margin:0;font-size:20px;color:#1a202c;">Orphan packages pending</h1>
        </div>
        <p style="color:#64748b;font-size:14px;margin:0 0 20px 0;line-height:1.5;">
          ${n === 1
            ? "<strong>1 package</strong> was received physically but has not yet been matched to a client email."
            : `<strong>${n} packages</strong> were received physically but have not yet been matched to client emails.`
          }
          Investigate or contact the client to confirm the shipment details.
        </p>
        <table style="width:100%;border-collapse:collapse;background:#fff;">
          <thead>
            <tr style="background:#f8fafc;">
              <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #e2e8f0;">Tracking</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #e2e8f0;">Client</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #e2e8f0;">Received</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #e2e8f0;">By</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;">
          <a href="https://apps.fr-logistics.net/portal.html#app=dropshipments.html"
             style="display:inline-block;background:#1fa463;color:#fff;text-decoration:none;padding:10px 20px;border-radius:9px;font-weight:600;font-size:14px;">
            Open Dropshipments →
          </a>
        </div>
        <p style="color:#94a3b8;font-size:11px;margin-top:20px;text-align:center;">
          You won't be alerted about these orphans again unless they're reset. <br>
          Automated alert from FR-Logistics Dropshipments · ${new Date().toISOString()}
        </p>
      </div>
    </div>
  `;
  return { subject, html };
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

// ─── Core run ────────────────────────────────────────────────────────────────
async function run({ dryRun = false } = {}) {
  const started = new Date().toISOString();
  const orphans = await findAlertableOrphans();

  if (orphans.length === 0) {
    return { ok: true, started, finished: new Date().toISOString(), alertable_count: 0, message: "No orphans past grace window." };
  }

  const { subject, html } = buildEmailHtml(orphans);

  if (dryRun) {
    return {
      ok: true, dry_run: true, started, finished: new Date().toISOString(),
      alertable_count: orphans.length,
      would_email: ALERT_TO,
      subject,
      orphans: orphans.map(o => ({ id: o.id, tracking: o.tracking_number, age_hours: o._age_hours }))
    };
  }

  // Send the email
  let emailResult;
  try {
    emailResult = await sendEmail({ to: ALERT_TO, subject, html });
  } catch (e) {
    console.error("[dropship-orphan-alert] email send failed:", e.message);
    return { ok: false, error: e.message, attempted_count: orphans.length };
  }

  // Mark all alerted (only if email was sent successfully)
  const now = new Date().toISOString();
  const ids = orphans.map(o => o.id);
  // Use PostgREST's `in.(…)` filter for a single PATCH.
  await sbPatch("dropshipments", `id=in.(${ids.join(",")})`, { orphan_alerted_at: now });

  return {
    ok: true, started, finished: new Date().toISOString(),
    alertable_count: orphans.length,
    email_id: emailResult.id || null,
    marked_alerted: ids.length
  };
}

// ─── HTTP handler ────────────────────────────────────────────────────────────
const CORS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,Authorization" };
const jRes = (d, s = 200) => new Response(JSON.stringify(d, null, 2), { status: s, headers: CORS });

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "1";

  const ua = req.headers.get("user-agent") || "";
  const isScheduled =
    req.headers.get("x-nf-event") === "schedule" ||
    ua.toLowerCase().includes("netlify-scheduled");

  // Info endpoint
  if (req.method === "GET" && url.searchParams.get("action") === "info") {
    return jRes({
      module: "dropship-orphan-alert",
      alert_to: ALERT_TO,
      alert_from: ALERT_FROM,
      provider: "Resend",
      resend_configured: !!RESEND_KEY,
      mode: "manual + scheduled (every 2h, offset :15)",
      usage: {
        run:     "POST /.netlify/functions/dropship-orphan-alert",
        dry_run: "POST /.netlify/functions/dropship-orphan-alert?dry_run=1",
        info:    "GET  /.netlify/functions/dropship-orphan-alert?action=info"
      }
    });
  }

  const shouldRun = req.method === "POST" || isScheduled;
  if (!shouldRun) {
    return jRes({ error: "Method not allowed. POST to run." }, 405);
  }

  try {
    const result = await run({ dryRun });
    if (isScheduled) console.log("[dropship-orphan-alert] scheduled:", JSON.stringify(result));
    return jRes({ scheduled: isScheduled, ...result });
  } catch (e) {
    console.error("[dropship-orphan-alert] fatal:", e);
    return jRes({ ok: false, error: e.message, stack: e.stack }, 500);
  }
}


