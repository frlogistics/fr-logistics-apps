// netlify/functions/dropship-pack-stock-alert.js
// Dropshipments · Packaging stock alert (scheduled).
//
// Decision of Jose (18-nov-2026): reorder alerts go by E-MAIL; when it is very
// urgent, ALSO by WhatsApp.
//
// Two levels, read from the view v_ds_packaging_stock (see
// db/migrations/20261118b_ds_packaging_inventory.sql):
//
//   LOW     existencia <= mínimo (and a mínimo > 0 was set)      → e-mail
//   URGENT  existencia <= 0, or it covers 2 days or less at the  → e-mail + WhatsApp
//           pace of the last 30 days
//
// Only packagings whose stock was loaded ("tracked") can alert. A packaging
// nobody has counted yet never does.
//
// No repeats: each level alerts ONCE per episode. The moment is stored in
// ds_packaging_types.low_alerted_at / urgent_alerted_at and cleared when the
// stock recovers (a purchase or a count), so the next shortage alerts again.
// The flag is only set after the message actually went out — a failed send is
// retried on the next run.
//
// Schedule: hourly during the working day (see netlify.toml). Scheduled
// functions cannot be called by URL, so there is no manual endpoint.
//
// WhatsApp: business-initiated messages must use an approved Meta template.
// This reuses `inventory_alert` (same one inventory-alert.js sends), with the
// packagings named in the first parameter; falls back to `daily_summary` if
// Meta answers that the template is not available.
//
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY, WHATSAPP_TOKEN,
// WHATSAPP_PHONE_ID, optional ALERT_PHONE — all already set. No new variables.

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY");
const RESEND_KEY   = Netlify.env.get("RESEND_API_KEY");
const WA_TOKEN     = Netlify.env.get("WHATSAPP_TOKEN");
const PHONE_ID     = Netlify.env.get("WHATSAPP_PHONE_ID");
const ALERT_NUMBER = Netlify.env.get("ALERT_PHONE") || "17867757335";

const ALERT_TO            = "josefuentes@fr-logistics.net";
const ALERT_FROM          = "FR-Logistics <alerts@fr-logistics.net>";
const ALERT_FROM_FALLBACK = "onboarding@resend.dev";
const APP_URL             = "https://apps.fr-logistics.net/portal.html#app=dropshipments.html";
const URGENT_DAYS         = 2;

const SB = () => ({ "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" });
async function sbSelect(t, q = "") { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}${q}`, { headers: SB() }); if (!r.ok) throw new Error(`sbSelect ${t}: ${await r.text()}`); return r.json(); }
async function sbPatch(t, f, d) { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}?${f}`, { method: "PATCH", headers: { ...SB(), "Prefer": "return=representation" }, body: JSON.stringify(d) }); if (!r.ok) throw new Error(`sbPatch ${t}: ${await r.text()}`); return r.json(); }

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ─── Classification (pure — unit tested) ─────────────────────────────────────
// Returns { level: "ok" | "low" | "urgent", days } for one row of the view.
export function classify(s) {
  if (!s || !s.tracked) return { level: "ok", days: null };
  const daily = (Number(s.used_30d) || 0) / 30;
  const days = daily > 0 ? Math.max(0, s.on_hand) / daily : null;
  if (s.on_hand <= 0) return { level: "urgent", days: 0 };
  if (days !== null && days <= URGENT_DAYS) return { level: "urgent", days };
  if (s.min_stock > 0 && s.on_hand <= s.min_stock) return { level: "low", days };
  return { level: "ok", days };
}

// What to do this run, given the stock rows and the alert flags.
export function plan(stock, flags) {
  const out = { emailRows: [], urgentNew: [], setLow: [], setUrgent: [], clearLow: [], clearUrgent: [], counts: { ok: 0, low: 0, urgent: 0, total: 0 } };
  for (const s of stock) {
    if (!s.tracked) continue;
    const f = flags[s.code] || {};
    const c = classify(s);
    out.counts.total++; out.counts[c.level]++;
    const row = { ...s, level: c.level, days: c.days };
    const isLowOrWorse = c.level !== "ok";
    if (isLowOrWorse && !f.low_alerted_at) { out.emailRows.push(row); out.setLow.push(s.code); }
    if (c.level === "urgent" && !f.urgent_alerted_at) {
      out.urgentNew.push(row); out.setUrgent.push(s.code);
      // An item that was already "low" and now turns urgent is e-mailed again.
      if (!out.emailRows.includes(row) && !out.emailRows.some(r => r.code === s.code)) out.emailRows.push(row);
    }
    if (!isLowOrWorse && f.low_alerted_at) out.clearLow.push(s.code);
    if (c.level !== "urgent" && f.urgent_alerted_at) out.clearUrgent.push(s.code);
  }
  return out;
}

// ─── E-mail ──────────────────────────────────────────────────────────────────
async function sendEmail({ to, subject, html, from = ALERT_FROM }) {
  if (!RESEND_KEY) throw new Error("RESEND_API_KEY not configured");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, html })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (from !== ALERT_FROM_FALLBACK) return sendEmail({ to, subject, html, from: ALERT_FROM_FALLBACK });
    throw new Error(`Resend: ${r.status} ${j.message || JSON.stringify(j)}`);
  }
  return j;
}

const dimsOf = (s) => s.inner_l == null ? ""
  : s.kind === "poly" ? `${Number(s.inner_w)}×${Number(s.inner_l)}"`
  : `${Number(s.inner_l)}×${Number(s.inner_w)}×${Number(s.inner_h)}"`;
const daysTxt = (d) => d === null ? "sin consumo reciente" : d <= 0 ? "agotado" : `${d < 1 ? "menos de 1" : Math.floor(d)} día${Math.floor(d) === 1 ? "" : "s"}`;

export function buildEmail(rows) {
  const urgent = rows.filter(r => r.level === "urgent");
  const names = rows.map(r => r.label).join(", ");
  const subject = urgent.length
    ? `URGENTE · Empaques por agotarse: ${urgent.map(r => r.label).join(", ")}`
    : `Reponer empaques: ${names}`;
  const tr = rows.map(r => `
    <tr>
      <td style="padding:9px 12px;border-bottom:1px solid #e5e7eb;font-weight:600;">${esc(r.label)}<br><span style="font-weight:400;color:#6b7280;font-size:12px;">${esc(dimsOf(r))}</span></td>
      <td style="padding:9px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-size:16px;font-weight:700;color:${r.level === "urgent" ? "#dc2626" : "#b45309"};">${r.on_hand}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${r.min_stock}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${r.used_30d}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${esc(daysTxt(r.days))}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #e5e7eb;font-weight:700;color:${r.level === "urgent" ? "#dc2626" : "#b45309"};">${r.level === "urgent" ? "URGENTE" : "Reponer"}</td>
    </tr>`).join("");
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#111827;">
    <div style="background:#0A2540;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0;">
      <div style="font-size:12px;letter-spacing:.08em;opacity:.8;">FR-LOGISTICS · DROPSHIPMENTS</div>
      <div style="font-size:19px;font-weight:700;margin-top:4px;">${urgent.length ? "Empaques por agotarse" : "Empaques por reponer"}</div>
    </div>
    <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:18px 20px;">
      <p style="margin:0 0 12px 0;font-size:14px;line-height:1.5;">
        ${urgent.length ? "Hay empaques agotados o que alcanzan para dos días o menos." : "La existencia de estos empaques llegó al mínimo que definiste."}
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead><tr style="background:#f8fafc;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:.05em;">
          <th style="padding:8px 12px;text-align:left;">Empaque</th><th style="padding:8px 12px;text-align:right;">Existencia</th>
          <th style="padding:8px 12px;text-align:right;">Mínimo</th><th style="padding:8px 12px;text-align:right;">Usadas 30 d</th>
          <th style="padding:8px 12px;text-align:right;">Alcanza</th><th style="padding:8px 12px;text-align:left;">Estado</th>
        </tr></thead>
        <tbody>${tr}</tbody>
      </table>
      <p style="margin:16px 0 0 0;font-size:13px;">
        <a href="${APP_URL}" style="color:#0f766e;font-weight:600;">Abrir Dropshipments → Empaques</a>
        para registrar la compra o un conteo físico.
      </p>
      <p style="margin:12px 0 0 0;font-size:11px;color:#6b7280;line-height:1.5;">
        Este aviso sale una sola vez por cada empaque y se reactiva cuando la existencia vuelve a subir.
        La existencia solo descuenta lo despachado por Dropshipments.
      </p>
    </div>
  </div>`;
  return { subject, html };
}

// ─── WhatsApp (approved Meta templates) ──────────────────────────────────────
async function waTemplate(name, params) {
  if (!WA_TOKEN || !PHONE_ID) throw new Error("WhatsApp not configured");
  const res = await fetch(`https://graph.facebook.com/v21.0/${PHONE_ID}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", to: ALERT_NUMBER, type: "template",
      template: { name, language: { code: name === "daily_summary" ? "en_US" : "en" },
        components: [{ type: "body", parameters: params.map(t => ({ type: "text", text: String(t).slice(0, 60) })) }] }
    })
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(j.error?.message || JSON.stringify(j).slice(0, 200)); e.code = j.error?.code; throw e; }
  return { template: name, msgId: j.messages?.[0]?.id || null };
}

async function sendUrgentWhatsApp(urgentRows, counts) {
  const today = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" });
  const who = `URGENTE Empaques: ${urgentRows.map(r => r.label).join(", ")}`;
  const out = urgentRows.filter(r => r.on_hand <= 0).length;
  try {
    // inventory_alert: (name, date, OK, low stock, out of stock, total)
    return await waTemplate("inventory_alert", [who, today, counts.ok, counts.low + counts.urgent - out, out, counts.total]);
  } catch (e) {
    if (e.code !== 132001 && e.code !== 132000) throw e;
    // daily_summary: (name, date, inbound, outbound) — used as a plain carrier.
    return await waTemplate("daily_summary", [who, today, `${urgentRows.length} por agotarse`, `${out} agotado(s)`]);
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────────
async function run() {
  const [stock, types] = await Promise.all([
    sbSelect("v_ds_packaging_stock", "?select=*&order=sort_order.asc"),
    sbSelect("ds_packaging_types", "?select=code,low_alerted_at,urgent_alerted_at")
  ]);
  const flags = Object.fromEntries(types.map(t => [t.code, t]));
  const p = plan(stock, flags);
  const now = new Date().toISOString();
  const result = { counts: p.counts, emailed: [], whatsapp: null, cleared: { low: p.clearLow, urgent: p.clearUrgent }, errors: [] };

  const inList = (codes) => `code=in.(${codes.map(encodeURIComponent).join(",")})`;
  if (p.clearLow.length)    await sbPatch("ds_packaging_types", inList(p.clearLow),    { low_alerted_at: null });
  if (p.clearUrgent.length) await sbPatch("ds_packaging_types", inList(p.clearUrgent), { urgent_alerted_at: null });

  if (p.emailRows.length) {
    try {
      const { subject, html } = buildEmail(p.emailRows);
      await sendEmail({ to: ALERT_TO, subject, html });
      result.emailed = p.emailRows.map(r => r.code);
      if (p.setLow.length) await sbPatch("ds_packaging_types", inList(p.setLow), { low_alerted_at: now });
    } catch (e) {
      result.errors.push(`email: ${e.message}`);
    }
  }

  if (p.urgentNew.length) {
    try {
      result.whatsapp = await sendUrgentWhatsApp(p.urgentNew, p.counts);
      await sbPatch("ds_packaging_types", inList(p.setUrgent), { urgent_alerted_at: now });
    } catch (e) {
      // Not marked: the WhatsApp is retried on the next run.
      result.errors.push(`whatsapp: ${e.message}`);
    }
  }
  return result;
}

// ── Reloj de Miami (cambio de horario automático) — 25-nov-2026 ────
// Netlify programa en UTC y no sabe del horario de verano. netlify.toml
// dispara esta función en las DOS horas UTC posibles (EDT y EST) y esta
// compuerta deja pasar solo la corrida que cae en la hora de Miami deseada.
// Una corrida manual (sin next_run en el body) no pasa por la compuerta.
const MIAMI_TZ = "America/New_York";
const MIAMI_DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function miamiClock(d = new Date()) {
  const p = {};
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: MIAMI_TZ, hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit"
  });
  for (const x of fmt.formatToParts(d)) p[x.type] = x.value;
  return { hour: Number(p.hour) % 24, minute: Number(p.minute), weekday: MIAMI_DOW[p.weekday] };
}
async function isScheduledCall(req) {
  try { const b = await req.clone().json(); return !!(b && b.next_run); } catch { return false; }
}

export default async function handler(req) {
  if (await isScheduledCall(req)) {
    const t = miamiClock();
    if (!([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18].includes(t.hour) && [1, 2, 3, 4, 5, 6].includes(t.weekday))) {
      console.log(`[dropship-pack-stock-alert] ${t.hour}:${String(t.minute).padStart(2, "0")} Miami (día ${t.weekday}) — fuera de 7:40 AM–6:40 PM lun–sáb, se omite`);
      return new Response(JSON.stringify({ skipped: true, reason: "outside_miami_window", miami_hour: t.hour, miami_weekday: t.weekday }), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    }
  }
  try {
    const r = await run();
    console.log(`[pack-stock-alert] tracked=${r.counts.total} low=${r.counts.low} urgent=${r.counts.urgent} · emailed=[${r.emailed.join(",")}] · whatsapp=${r.whatsapp ? r.whatsapp.template : "no"}${r.errors.length ? " · ERRORS: " + r.errors.join(" | ") : ""}`);
    return new Response(JSON.stringify({ ok: !r.errors.length, ...r }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("[pack-stock-alert] fatal:", e.message);
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
