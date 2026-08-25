// netlify/functions/daily-summary.js
// Scheduled daily at 23:00 UTC (7PM EDT / 6PM EST).
//
// Reads TODAY's movements from shipments_general (Miami calendar day),
// groups them BY client_id, and for each client with activity sends:
//   1. WhatsApp  — the `daily_summary` Meta template (unchanged, 4 params).
//                  Gated by fr_clients.wa_notifications.
//   2. Email     — HTML detail with the day's tracking numbers and a link to
//                  the Client Portal. Gated by fr_clients.email_notifications.
// Plus a WhatsApp CC to the FR-Logistics monitoring number.
//
// WHY client_id AND NOT THE `client` TEXT COLUMN (changed 2026-08-25):
// shipments_general.client is free text written from
// dropship_client_configs.client_name_billing and from the warehouse apps, so
// the SAME client shows up under several spellings — Milano Brands appears as
// both "Milano Brands LLC" (20 rows) and "Daizzy Gear" (83 rows), which made
// the old name-matching loop send her TWO separate WhatsApp messages on any
// day both spellings were written. shipments_general.client_id is populated on
// 742 of 742 rows with zero nulls, so grouping on it is exact, needs no
// normalization and cannot leak one client's numbers into another's message.
// The old text matcher is kept ONLY as a fallback for rows that somehow
// arrive without a client_id.

const SUPABASE_URL  = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY  = Netlify.env.get("SUPABASE_SERVICE_KEY");
const PHONE_ID      = Netlify.env.get("WHATSAPP_PHONE_ID");
const WA_TOKEN      = Netlify.env.get("WHATSAPP_TOKEN");
const RESEND_KEY    = Netlify.env.get("RESEND_API_KEY");
const FR_MONITOR    = Netlify.env.get("FR_MONITOR_WA") || "17867757335";  // CC interno — FR-Logistics ops
const WA_BASE       = `https://graph.facebook.com/v21.0/${PHONE_ID}/messages`;

const PORTAL_URL    = "https://fr-logistics.net/app";
const FROM_EMAIL    = "FR-Logistics <notifications@fr-logistics.net>";
const REPLY_TO      = "warehouse@fr-logistics.net";
const SUPPORT_EMAIL = "warehouse@fr-logistics.net";

const SB_HEADERS = () => ({
  "apikey":        SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type":  "application/json"
});

// ── Miami calendar day ────────────────────────────────────────────
//
// The previous version added a flat -5h to `now`, then queried
// received_at between 00:00Z and 23:59Z of the resulting date. Because the
// cron fires at 23:00 UTC, that window actually ran from 8PM the previous day
// to 7PM today: movements captured between 7PM and 8PM fell into tomorrow's
// report and yesterday's late-evening rows were counted twice over. This
// resolves the real America/New_York offset (DST included) so the window is
// the Miami day, start to end.
function miamiOffsetMinutes(d) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).formatToParts(d).map(p => [p.type, p.value])
  );
  const asUTC = Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    +parts.hour % 24, +parts.minute, +parts.second
  );
  return (asUTC - d.getTime()) / 60000;
}

function miamiDayWindow(now = new Date()) {
  const off = miamiOffsetMinutes(now);
  const local = new Date(now.getTime() + off * 60000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const startUTC = new Date(Date.UTC(y, m, d, 0, 0, 0) - off * 60000);
  const endUTC   = new Date(Date.UTC(y, m, d, 23, 59, 59, 999) - off * 60000);
  return {
    startISO: startUTC.toISOString(),
    endISO:   endUTC.toISOString(),
    dateStr:  `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`
  };
}

// ── Data ──────────────────────────────────────────────────────────

async function getTodayMovements(win) {
  // Some rows carry no received_at (created straight from an app); fall back
  // to created_at for those, same pattern portal-inbound.js uses.
  const orFilter =
    `or=(and(received_at.gte.${win.startISO},received_at.lte.${win.endISO}),` +
    `and(received_at.is.null,created_at.gte.${win.startISO},created_at.lte.${win.endISO}))`;

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/shipments_general` +
    `?select=id,client,client_id,direction,type,carrier,tracking,notes,received_at,created_at` +
    `&${orFilter}&order=received_at.asc&limit=1000`,
    { headers: SB_HEADERS() }
  );
  if (!res.ok) {
    throw new Error(`Supabase shipments_general error: ${(await res.text()).substring(0, 200)}`);
  }
  return res.json();
}

async function getClients() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/fr_clients` +
    `?select=id,name,company,store_name,wa_number,wa_notifications,email,email_notifications,ship_notify_emails,portal_user,lang` +
    `&active=eq.true`,
    { headers: SB_HEADERS() }
  );
  if (!res.ok) throw new Error("Supabase fr_clients error");
  return res.json();
}

// ── Legacy text matcher — fallback only ───────────────────────────
// Kept for rows without client_id. Refuses to guess when a name resolves to
// more than one client: fr_clients holds real duplicates ("FR-Logistics" twice,
// "Pacific Horizon Investments LLC" twice) and sending one client's numbers to
// another is worse than sending nothing.
function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
function waDigits(c) {
  return String(c.wa_number || "").replace(/[^0-9]/g, "").length;
}
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
function pickOne(candidates, label, how) {
  if (candidates.length === 1) return candidates[0];
  const reachable = candidates.filter(c => c.wa_notifications && waDigits(c) >= 10);
  if (reachable.length === 1) {
    console.log(`[daily-summary] "${label}" matched ${candidates.length} rows (${how}) → picked ${reachable[0].name}`);
    return reachable[0];
  }
  console.warn(`[daily-summary] AMBIGUOUS "${label}" (${how}) — refusing to guess, nothing sent`);
  return null;
}
function matchClientByName(movementClientName, clients, index) {
  const q = String(movementClientName || "").toLowerCase().trim();
  if (!q) return null;
  const exact = clients.filter(c =>
    (c.name       && c.name.toLowerCase().trim()       === q) ||
    (c.company    && c.company.toLowerCase().trim()    === q) ||
    (c.store_name && c.store_name.toLowerCase().trim() === q)
  );
  if (exact.length) return pickOne(exact, movementClientName, "exact");
  const bucket = index.get(norm(movementClientName));
  if (!bucket || !bucket.length) return null;
  return pickOne(bucket, movementClientName, "normalized");
}

// ── Tracking display (mirrors portal-inbound.js) ───────────────────
// fr-mobile.html stores the full GS1-128 barcode in `tracking` when that is
// what the scanner read, and that string does not resolve on usps.com. Same
// normalization as the portal so the email and the Inbound tab agree.
function normalizeTracking(raw) {
  const t = String(raw || "").replace(/[\s()\u001d\u001e-]/g, "");
  if (!t) return { tracking: "", carrier: "" };
  const routed = t.match(/^420\d{5}(9[2-5]\d{20})$/);
  if (routed) return { tracking: routed[1], carrier: "USPS" };
  if (/^9[2-5]\d{20}$/.test(t))       return { tracking: t, carrier: "USPS" };
  if (/^1Z[0-9A-Z]{16}$/i.test(t))    return { tracking: t.toUpperCase(), carrier: "UPS" };
  if (/^TBA\d+$/i.test(t))            return { tracking: t.toUpperCase(), carrier: "Amazon" };
  // FedEx 34-digit barcode: the human tracking number is always the last 12.
  // portal-inbound.js only anchors the "96" prefix, but the ADRIANO Cosmeticos
  // labels scanned on 2026-08-25 start with "26" and were being published raw
  // — a 34-digit string that resolves on no carrier site.
  if (/^\d{34}$/.test(t))             return { tracking: t.slice(-12), carrier: "FedEx" };
  return { tracking: t, carrier: "" };
}
function trackingUrl(tracking, carrier) {
  if (!tracking) return "";
  const c = (carrier || "").toUpperCase();
  if (c === "UPS")    return "https://www.ups.com/track?tracknum=" + encodeURIComponent(tracking);
  if (c === "USPS")   return "https://tools.usps.com/go/TrackConfirmAction?tLabels=" + encodeURIComponent(tracking);
  if (c === "AMAZON") return "https://track.amazon.com/tracking/" + encodeURIComponent(tracking);
  if (c === "FEDEX")  return "https://www.fedex.com/fedextrack/?trknbr=" + encodeURIComponent(tracking);
  return "";
}
const INTERNAL_NOTE_RE = /^\s*scanned via fr mobile\b.*$/i;
function cleanNote(notes) {
  const n = String(notes || "").trim();
  return (!n || INTERNAL_NOTE_RE.test(n)) ? "" : n;
}

// ── WhatsApp ──────────────────────────────────────────────────────

async function sendWA(to, clientName, dateLabel, inbound, outbound) {
  const toClean = String(to).replace(/[^0-9]/g, "");
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
  if (!res.ok) throw new Error(result.error?.message || JSON.stringify(result).substring(0, 200));
  return result.messages?.[0]?.id;
}

// ── Email ─────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// fr_clients.email is the contact address; ship_notify_emails is the array
// meant for extra copies (empty for every client today, but supported so it
// works the day someone fills it in).
function emailRecipients(client) {
  const raw = [client.email, ...(Array.isArray(client.ship_notify_emails) ? client.ship_notify_emails : [])];
  const seen = new Set();
  const out = [];
  for (const e of raw) {
    const addr = String(e || "").trim();
    if (!addr || !EMAIL_RE.test(addr)) continue;
    const k = addr.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(addr);
  }
  return out;
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function timeLabel(row) {
  const ts = row.received_at || row.created_at;
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", timeZone: "America/New_York"
  });
}

const T = {
  ES: {
    subject:  (d, i, o) => `Resumen del día — ${d} · ${i} entrada(s), ${o} salida(s)`,
    hi:       n => `Hola ${n},`,
    intro:    "Este es el movimiento de tu inventario registrado hoy en nuestro almacén de Doral.",
    inbound:  "Recibidos",
    outbound: "Despachados",
    detail:   "Detalle del día",
    thTime:   "Hora", thDir: "Movimiento", thType: "Tipo", thTrack: "Tracking", thNote: "Referencia",
    dirIn:    "Entrada", dirOut: "Salida",
    portalH:  "Ver el detalle completo",
    portalP:  "En el portal tienes el historial de recepciones con sus fotos, el inventario en vivo y el reporte de detalle por SKU en Excel.",
    portalB:  "Entrar al portal",
    loginAs:  u => `Tu usuario de acceso es <strong>${esc(u)}</strong>.`,
    noPortal: "¿Quieres acceso al portal para ver tu inventario en vivo y el historial con fotos? Escríbenos y te lo activamos.",
    footNote: "El conteo es por bulto recibido o despachado, no por unidad. Un bulto consolidado con varias órdenes cuenta como una entrada.",
    cutoff:   "Corte de despacho: 2:00 PM ET, lunes a viernes.",
    contact:  "¿Algo no cuadra? Responde a este correo o escríbenos a"
  },
  EN: {
    subject:  (d, i, o) => `Daily summary — ${d} · ${i} inbound, ${o} outbound`,
    hi:       n => `Hi ${n},`,
    intro:    "Here is the inventory movement recorded today at our Doral warehouse.",
    inbound:  "Received",
    outbound: "Shipped",
    detail:   "Today's detail",
    thTime:   "Time", thDir: "Movement", thType: "Type", thTrack: "Tracking", thNote: "Reference",
    dirIn:    "Inbound", dirOut: "Outbound",
    portalH:  "See the full detail",
    portalP:  "The portal has your receiving history with photos, live inventory, and the item-level detail report in Excel.",
    portalB:  "Open the portal",
    loginAs:  u => `Your login is <strong>${esc(u)}</strong>.`,
    noPortal: "Want portal access to see live inventory and your receiving history with photos? Reply and we'll set it up.",
    footNote: "Counts are per package received or shipped, not per unit. A consolidated box holding several orders counts as one inbound.",
    cutoff:   "Dispatch cut-off: 2:00 PM ET, Monday to Friday.",
    contact:  "Something looks off? Reply to this email or write to"
  }
};

function buildEmailHtml(client, rows, counts, dateLabel, t) {
  const detailRows = rows.map(r => {
    const { tracking, carrier } = normalizeTracking(r.tracking);
    const url  = trackingUrl(tracking, carrier || r.carrier);
    const note = cleanNote(r.notes);
    const isIn = r.direction === "Inbound";
    const trackCell = tracking
      ? (url
          ? `<a href="${esc(url)}" style="color:#1C7293;text-decoration:none">${esc(tracking)}</a>`
          : esc(tracking))
      : "—";
    return `<tr>
      <td style="padding:9px 10px;border-bottom:1px solid #E2E8F0;font-size:13px;color:#64748B;white-space:nowrap">${esc(timeLabel(r))}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #E2E8F0;font-size:13px">
        <span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:${isIn ? "#ECFDF5" : "#EFF6FF"};color:${isIn ? "#065F46" : "#1E40AF"}">${isIn ? esc(t.dirIn) : esc(t.dirOut)}</span>
      </td>
      <td style="padding:9px 10px;border-bottom:1px solid #E2E8F0;font-size:13px;color:#334155">${esc(r.type || "—")}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #E2E8F0;font-size:13px;font-family:Consolas,monospace">${trackCell}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #E2E8F0;font-size:13px;color:#334155">${esc(note || "—")}</td>
    </tr>`;
  }).join("");

  const portalBlock = client.portal_user
    ? `<div style="margin:26px 0;padding:18px 20px;background:#F1F5F9;border-left:4px solid #F4A261;border-radius:6px">
         <div style="font-size:15px;font-weight:700;color:#0B2545;margin-bottom:6px">${esc(t.portalH)}</div>
         <div style="font-size:13px;color:#475569;line-height:1.6;margin-bottom:14px">${esc(t.portalP)}</div>
         <a href="${PORTAL_URL}" style="display:inline-block;padding:11px 22px;background:#0B2545;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600">${esc(t.portalB)}</a>
         <div style="font-size:12px;color:#64748B;margin-top:12px">${t.loginAs(client.portal_user)}</div>
       </div>`
    : `<div style="margin:26px 0;padding:16px 20px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:6px;font-size:13px;color:#475569;line-height:1.6">${esc(t.noPortal)}</div>`;

  return `<!doctype html><html><body style="margin:0;padding:0;background:#F1F5F9">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1F5F9;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;background:#fff;border-radius:10px;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">

  <tr><td style="background:#0B2545;padding:22px 28px">
    <div style="color:#fff;font-size:19px;font-weight:700;letter-spacing:.3px">FR-Logistics Miami</div>
    <div style="color:#8FB3C7;font-size:13px;margin-top:3px">${esc(dateLabel)}</div>
  </td></tr>

  <tr><td style="padding:26px 28px 6px">
    <div style="font-size:15px;color:#0B2545;font-weight:600">${esc(t.hi(client.name || client.company || ""))}</div>
    <div style="font-size:14px;color:#475569;line-height:1.6;margin-top:8px">${esc(t.intro)}</div>
  </td></tr>

  <tr><td style="padding:18px 28px 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td width="50%" style="padding-right:7px">
          <div style="background:#F1F5F9;border-top:3px solid #1C7293;border-radius:6px;padding:16px 18px">
            <div style="font-size:30px;font-weight:700;color:#0B2545;line-height:1">${counts.inbound}</div>
            <div style="font-size:12px;color:#64748B;text-transform:uppercase;letter-spacing:.6px;margin-top:5px">${esc(t.inbound)}</div>
          </div>
        </td>
        <td width="50%" style="padding-left:7px">
          <div style="background:#F1F5F9;border-top:3px solid #F4A261;border-radius:6px;padding:16px 18px">
            <div style="font-size:30px;font-weight:700;color:#0B2545;line-height:1">${counts.outbound}</div>
            <div style="font-size:12px;color:#64748B;text-transform:uppercase;letter-spacing:.6px;margin-top:5px">${esc(t.outbound)}</div>
          </div>
        </td>
      </tr>
    </table>
  </td></tr>

  <tr><td style="padding:26px 28px 0">
    <div style="font-size:15px;font-weight:700;color:#0B2545;margin-bottom:10px">${esc(t.detail)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      <tr style="background:#0B2545">
        <th align="left" style="padding:9px 10px;font-size:11px;color:#8FB3C7;text-transform:uppercase;letter-spacing:.5px">${esc(t.thTime)}</th>
        <th align="left" style="padding:9px 10px;font-size:11px;color:#8FB3C7;text-transform:uppercase;letter-spacing:.5px">${esc(t.thDir)}</th>
        <th align="left" style="padding:9px 10px;font-size:11px;color:#8FB3C7;text-transform:uppercase;letter-spacing:.5px">${esc(t.thType)}</th>
        <th align="left" style="padding:9px 10px;font-size:11px;color:#8FB3C7;text-transform:uppercase;letter-spacing:.5px">${esc(t.thTrack)}</th>
        <th align="left" style="padding:9px 10px;font-size:11px;color:#8FB3C7;text-transform:uppercase;letter-spacing:.5px">${esc(t.thNote)}</th>
      </tr>
      ${detailRows}
    </table>
  </td></tr>

  <tr><td style="padding:0 28px">${portalBlock}</td></tr>

  <tr><td style="padding:0 28px 24px">
    <div style="font-size:12px;color:#64748B;line-height:1.7;border-top:1px solid #E2E8F0;padding-top:14px">
      ${esc(t.footNote)}<br>${esc(t.cutoff)}<br>
      ${esc(t.contact)} <a href="mailto:${SUPPORT_EMAIL}" style="color:#1C7293;text-decoration:none">${SUPPORT_EMAIL}</a>
    </div>
  </td></tr>

  <tr><td style="background:#F8FAFC;padding:14px 28px;text-align:center;font-size:11px;color:#94A3B8;border-top:1px solid #E2E8F0">
    FR Logistics Miami Inc · 10893 NW 17th Street, Unit 121, Miami, FL 33172 · fr-logistics.net
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

function buildEmailText(client, rows, counts, dateLabel, t) {
  const lines = rows.map(r => {
    const { tracking, carrier } = normalizeTracking(r.tracking);
    const note = cleanNote(r.notes);
    return `  ${timeLabel(r).padEnd(9)} ${(r.direction === "Inbound" ? t.dirIn : t.dirOut).padEnd(10)} ${(r.type || "-").padEnd(22)} ${tracking || "-"}${note ? "  — " + note : ""}`;
  });
  return [
    `FR-Logistics Miami — ${dateLabel}`,
    "",
    t.hi(client.name || client.company || ""),
    t.intro,
    "",
    `${t.inbound}: ${counts.inbound}`,
    `${t.outbound}: ${counts.outbound}`,
    "",
    `${t.detail}:`,
    ...lines,
    "",
    client.portal_user ? `${t.portalB}: ${PORTAL_URL}  (${client.portal_user})` : t.noPortal,
    "",
    t.footNote,
    t.cutoff,
    `${t.contact} ${SUPPORT_EMAIL}`
  ].join("\n");
}

async function sendEmail(client, rows, counts, dateLabel) {
  const to = emailRecipients(client);
  if (!to.length) return { skipped: "no valid address" };

  const t = T[(client.lang || "EN").toUpperCase() === "ES" ? "ES" : "EN"];
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from:     FROM_EMAIL,
      to,                                   // array — never a comma-joined string
      reply_to: REPLY_TO,
      subject:  t.subject(dateLabel, counts.inbound, counts.outbound),
      html:     buildEmailHtml(client, rows, counts, dateLabel, t),
      text:     buildEmailText(client, rows, counts, dateLabel, t)
    })
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.message || j.error?.message || `Resend HTTP ${res.status}`);
  return { id: j.id, to };
}

// ── Main ──────────────────────────────────────────────────────────

export async function runDailySummary({ dryRun = false, only = null } = {}) {
  const win = miamiDayWindow();
  console.log(`[daily-summary] Miami day ${win.dateStr} → ${win.startISO} .. ${win.endISO}${dryRun ? " (DRY RUN)" : ""}`);

  const movements = await getTodayMovements(win);
  console.log(`[daily-summary] Movements today: ${movements.length}`);
  if (!movements.length) {
    return { date: win.dateStr, movements: 0, wa_sent: 0, email_sent: 0, message: "No movements today" };
  }

  const clients = await getClients();
  const index   = buildClientIndex(clients);
  const byId    = new Map(clients.map(c => [c.id, c]));

  // Group by client_id; fall back to the name matcher only when absent.
  const groups = new Map();   // clientId → { client, rows, inbound, outbound }
  const unmatched = [];
  for (const m of movements) {
    let client = m.client_id ? byId.get(m.client_id) : null;
    if (!client) client = matchClientByName(m.client, clients, index);
    if (!client) { unmatched.push(m.client || m.client_id || "(blank)"); continue; }

    if (!groups.has(client.id)) groups.set(client.id, { client, rows: [], inbound: 0, outbound: 0 });
    const g = groups.get(client.id);
    g.rows.push(m);
    if (m.direction === "Inbound")  g.inbound++;
    if (m.direction === "Outbound") g.outbound++;
  }
  if (unmatched.length) {
    console.warn(`[daily-summary] ${unmatched.length} movement(s) with no client in fr_clients: ${[...new Set(unmatched)].join(", ")}`);
  }

  // The Meta template is en_US, so the WhatsApp date label stays English.
  // The email is ours, so it follows the client's language.
  const dateLabel = new Date().toLocaleDateString(
    "en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York" }
  );
  const dateLabelES = new Date().toLocaleDateString(
    "es-ES", { weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York" }
  );

  let waSent = 0, waSkipped = 0, waErrors = 0;
  let emailSent = 0, emailSkipped = 0, emailErrors = 0;
  const detail = [];

  for (const g of groups.values()) {
    const c = g.client;
    if (only && c.id !== only && norm(c.company) !== norm(only) && norm(c.name) !== norm(only)) continue;

    const label = c.company || c.name || "Client";
    const line  = { client: label, inbound: g.inbound, outbound: g.outbound, wa: null, email: null };

    // ── WhatsApp (Meta template, unchanged) ──
    const waNum = String(c.wa_number || "").replace(/[^0-9]/g, "");
    if (c.wa_notifications && waNum.length >= 10) {
      if (dryRun) { line.wa = `would send → +${waNum}`; }
      else {
        try {
          const id = await sendWA(waNum, c.name || label, dateLabel, g.inbound, g.outbound);
          line.wa = `sent ${id}`; waSent++;
          console.log(`[daily-summary] WA ✅ ${label} (+${waNum}) in:${g.inbound} out:${g.outbound}`);
        } catch (err) {
          line.wa = `error: ${err.message}`; waErrors++;
          console.error(`[daily-summary] WA ❌ ${label}: ${err.message}`);
        }
      }
    } else {
      line.wa = "skipped (notifications off or no number)"; waSkipped++;
    }

    // ── Email (new) ──
    const addrs = emailRecipients(c);
    if (c.email_notifications !== false && addrs.length && RESEND_KEY) {
      if (dryRun) { line.email = `would send → ${addrs.join(", ")}${c.portal_user ? " (with portal link)" : " (no portal link)"}`; }
      else {
        try {
          const isES = String(c.lang || "EN").toUpperCase() === "ES";
          const r = await sendEmail(c, g.rows, { inbound: g.inbound, outbound: g.outbound }, isES ? dateLabelES : dateLabel);
          line.email = r.skipped ? `skipped (${r.skipped})` : `sent ${r.id} → ${r.to.join(", ")}`;
          if (r.skipped) emailSkipped++; else emailSent++;
          console.log(`[daily-summary] Email ✅ ${label} → ${addrs.join(", ")}`);
        } catch (err) {
          line.email = `error: ${err.message}`; emailErrors++;
          console.error(`[daily-summary] Email ❌ ${label}: ${err.message}`);
        }
      }
    } else {
      line.email = "skipped (email notifications off or no address)"; emailSkipped++;
    }

    detail.push(line);
  }

  // ── CC to the FR-Logistics monitoring number ──
  const allIn  = movements.filter(m => m.direction === "Inbound").length;
  const allOut = movements.filter(m => m.direction === "Outbound").length;
  if (!dryRun && !only) {
    try {
      const ccMsg = await sendWA(FR_MONITOR, "FR-Logistics Ops", `${dateLabel} | ${groups.size} clients`, allIn, allOut);
      console.log(`[daily-summary] CC ✅ +${FR_MONITOR} | id:${ccMsg}`);
    } catch (err) {
      console.error(`[daily-summary] CC ❌ ${err.message}`);
    }
  }

  const summary = {
    date: win.dateStr, dry_run: dryRun,
    movements: movements.length, clients: groups.size,
    wa: { sent: waSent, skipped: waSkipped, errors: waErrors },
    email: { sent: emailSent, skipped: emailSkipped, errors: emailErrors },
    totals: { inbound: allIn, outbound: allOut },
    unmatched: [...new Set(unmatched)],
    detail
  };
  console.log("[daily-summary] Done:", JSON.stringify({ ...summary, detail: undefined }));
  return summary;
}

export default async function handler(req) {
  try {
    const summary = await runDailySummary();
    return new Response(JSON.stringify(summary), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error("[daily-summary] Fatal:", err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

export const config = {
  schedule: "0 23 * * *"   // 23:00 UTC = 7PM EDT / 6PM EST daily
};
