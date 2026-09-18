// netlify/functions/wa-followups.js
//
// AUTOMATED FOLLOW-UPS (2026-09-18). Scheduled daily (see netlify.toml).
//
// Two jobs, both via Meta-approved templates (the 24h window is closed by
// definition when a follow-up is needed):
//
//  1. quote_reminder — a quote with status 'sent' expires in REMIND_DAYS_BEFORE
//     days. One reminder per quote, ever.
//  2. lead_nudge — a real lead (dq_flag='real', open status) went quiet:
//     nobody has written in either direction for NUDGE_AFTER_DAYS. Nudge #1
//     at ≥3 days, nudge #2 at ≥7 days since the lead was created and ≥3 days
//     after nudge #1. Never more than two.
//
// Hard stops, always: opted-out numbers (wa_optouts), existing clients
// (client_id set), leads with a Discovery Call in the future, and anything
// already logged in wa_followups for the same (number, kind, quote/seq).
//
// Manual use:
//   GET  /wa-followups?dry=1   → JSON preview of who WOULD get what, sends nothing
//   GET  /wa-followups?run=1&key=<WHATSAPP_WEBHOOK_SECRET> → run for real now
//   Scheduled invocation (POST from Netlify) → run for real.
//
// Templates (names must match Meta):
//   quote_reminder_es / quote_reminder_en   {{1}} name, {{2}} quote id, {{3}} valid-until date
//   lead_nudge_es / lead_nudge_en           {{1}} name
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY, WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_WEBHOOK_SECRET

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WA_TOKEN     = process.env.WHATSAPP_TOKEN;
const PHONE_ID     = process.env.WHATSAPP_PHONE_ID;
const GRAPH_VER    = process.env.WHATSAPP_GRAPH_VERSION || "v22.0";
const RUN_KEY      = process.env.WHATSAPP_WEBHOOK_SECRET || "";

const REMIND_DAYS_BEFORE = 2;     // quote reminder N days before valid_until
const NUDGE_AFTER_DAYS   = 3;     // silence in both directions before nudging
const NUDGE_2_MIN_AGE    = 7;     // lead age for the second nudge
const NUDGE_MAX_AGE_DAYS = 30;    // older leads are never nudged automatically
const MAX_SENDS_PER_RUN  = 20;    // safety valve
const OPEN_LEAD_STATUS   = ["new", "qualifying", "sent_to_sales"];

const TEMPLATE_LANG = { es: "es", en: "en_US" };
const PREVIEW = {
  quote_reminder_es: (n, q, d) => `Hola ${n}, te recordamos que tu cotización ${q} de FR-Logistics vence el ${d}. Si quieres avanzar o ajustar algo, responde a este mensaje y nuestro equipo te ayuda.`,
  quote_reminder_en: (n, q, d) => `Hi ${n}, a quick reminder that your FR-Logistics quote ${q} expires on ${d}. If you want to move forward or adjust anything, reply to this message and our team will help.`,
  lead_nudge_es:     (n)       => `Hola ${n}, te escribimos de FR-Logistics Miami. Quedamos pendientes de tu operación en USA. ¿Seguimos? Responde a este mensaje y retomamos donde lo dejamos.`,
  lead_nudge_en:     (n)       => `Hi ${n}, this is FR-Logistics Miami. We are still here for your US operation. Shall we continue? Reply to this message and we pick up where we left off.`,
};

const JSON_HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

export default async function handler(req) {
  const url = new URL(req.url);
  const isScheduled = req.method === "POST";
  const dry = url.searchParams.get("dry") === "1";
  const manualRun = url.searchParams.get("run") === "1" && RUN_KEY && url.searchParams.get("key") === RUN_KEY;

  if (!isScheduled && !dry && !manualRun) {
    return new Response(JSON.stringify({ error: "Use ?dry=1 to preview, or ?run=1&key=… to run now." }), { status: 400, headers: JSON_HEADERS });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) return new Response(JSON.stringify({ error: "Supabase env missing" }), { status: 500, headers: JSON_HEADERS });

  const report = { dry, quote_reminders: [], lead_nudges: [], skipped: [], sent: 0, errors: 0, ran_at: new Date().toISOString() };
  try {
    const optouts = await loadOptouts();
    const plan = [];
    plan.push(...await planQuoteReminders(optouts, report));
    plan.push(...await planLeadNudges(optouts, report));

    let budget = MAX_SENDS_PER_RUN;
    for (const item of plan) {
      if (budget <= 0) { report.skipped.push({ ...item.summary, reason: "run_cap" }); continue; }
      if (dry) { await logFollowup(item, { status: "preview", dry_run: true }); continue; }
      const res = await sendTemplate(item);
      if (res.ok) { report.sent++; budget--; await logFollowup(item, { status: "sent", wa_msg_id: res.messageId }); await recordOutbound(item, res.messageId); }
      else { report.errors++; await logFollowup(item, { status: "failed", error: res.error }); item.summary.error = res.error; }
    }
  } catch (e) {
    console.error("[wa-followups] fatal:", e.message);
    report.fatal = e.message;
  }
  console.log(`[wa-followups] ${dry ? "DRY " : ""}quotes=${report.quote_reminders.length} nudges=${report.lead_nudges.length} sent=${report.sent} errors=${report.errors}`);
  return new Response(JSON.stringify(report, null, 2), { status: 200, headers: JSON_HEADERS });
}

/* ────────────────────────── planning ────────────────────────── */

async function planQuoteReminders(optouts, report) {
  const target = isoDate(addDays(new Date(), REMIND_DAYS_BEFORE));
  const quotes = await sb(`quotes?select=quote_id,client_name,contact_name,contact_email,valid_until,source_lead_id,client_id,status&status=eq.sent&valid_until=eq.${target}`);
  const out = [];
  for (const q of quotes || []) {
    if (q.client_id) { report.skipped.push({ kind: "quote_reminder", quote: q.quote_id, reason: "existing_client" }); continue; }
    let lead = null;
    if (q.source_lead_id) lead = (await sb(`wa_leads?select=id,name,phone,language,dq_flag&id=eq.${q.source_lead_id}`))?.[0] || null;
    if (!lead && q.contact_email) lead = (await sb(`wa_leads?select=id,name,phone,language,dq_flag&email=ilike.${encodeURIComponent(q.contact_email)}&order=created_at.desc&limit=1`))?.[0] || null;
    const phone = normalizePhone(lead?.phone || "");
    if (!phone) { report.skipped.push({ kind: "quote_reminder", quote: q.quote_id, reason: "no_whatsapp" }); continue; }
    if (optouts.has(phone)) { report.skipped.push({ kind: "quote_reminder", quote: q.quote_id, reason: "opted_out" }); continue; }
    const already = await sb(`wa_followups?select=id&kind=eq.quote_reminder&quote_id=eq.${encodeURIComponent(q.quote_id)}&dry_run=eq.false&status=eq.sent&limit=1`);
    if (already?.length) { report.skipped.push({ kind: "quote_reminder", quote: q.quote_id, reason: "already_sent" }); continue; }
    const lang = (lead?.language || "es").toLowerCase() === "en" ? "en" : "es";
    const name = firstName(q.contact_name || lead?.name || q.client_name) || (lang === "es" ? "de nuevo" : "again");
    const validPretty = prettyDate(q.valid_until, lang);
    const item = {
      kind: "quote_reminder", phone, lead_id: lead?.id || null, quote_id: q.quote_id, lang, seq: 1,
      template: `quote_reminder_${lang}`, params: [name, q.quote_id, validPretty],
      preview: PREVIEW[`quote_reminder_${lang}`](name, q.quote_id, validPretty),
      summary: { kind: "quote_reminder", to: phone, name, quote: q.quote_id, valid_until: q.valid_until, lang },
    };
    out.push(item); report.quote_reminders.push(item.summary);
  }
  return out;
}

async function planLeadNudges(optouts, report) {
  const minAge = isoDate(addDays(new Date(), -NUDGE_AFTER_DAYS));
  const maxAge = isoDate(addDays(new Date(), -NUDGE_MAX_AGE_DAYS));
  // Only leads a human (or the handoff scorer) marked as REAL. dq_flag is
  // null for unclassified leads on purpose: those are never nudged.
  const leads = await sb(`wa_leads?select=id,name,phone,language,status,created_at,client_id,meeting_start_time&dq_flag=eq.real&status=in.(${OPEN_LEAD_STATUS.join(",")})&client_id=is.null&created_at=lte.${minAge}T23:59:59Z&created_at=gte.${maxAge}T00:00:00Z&phone=not.is.null&order=created_at.desc&limit=300`);
  const out = [];
  const now = Date.now();
  const seen = new Set();   // one nudge per phone even if the lead row is duplicated
  for (const l of leads || []) {
    const phone = normalizePhone(l.phone);
    if (!phone || phone.length < 8) continue;
    if (seen.has(phone)) continue;
    seen.add(phone);
    if (optouts.has(phone)) continue;
    if (l.meeting_start_time && new Date(l.meeting_start_time).getTime() > now) { report.skipped.push({ kind: "lead_nudge", to: phone, reason: "meeting_scheduled" }); continue; }

    // Silence check: last message in either direction
    const last = (await sb(`wa_messages?select=timestamp,direction&or=(from_number.eq.${phone},to_number.eq.${phone})&is_internal=eq.false&order=timestamp.desc&limit=1`))?.[0];
    if (!last) { report.skipped.push({ kind: "lead_nudge", to: phone, reason: "no_messages" }); continue; }
    const silentDays = (now - new Date(last.timestamp).getTime()) / 864e5;
    if (silentDays < NUDGE_AFTER_DAYS) continue;

    // Previous nudges
    const prev = await sb(`wa_followups?select=created_at,seq&kind=eq.lead_nudge&wa_number=eq.${phone}&dry_run=eq.false&status=eq.sent&order=created_at.desc`);
    const nPrev = prev?.length || 0;
    if (nPrev >= 2) continue;
    const leadAgeDays = (now - new Date(l.created_at).getTime()) / 864e5;
    if (nPrev === 1) {
      const sinceFirst = (now - new Date(prev[0].created_at).getTime()) / 864e5;
      if (leadAgeDays < NUDGE_2_MIN_AGE || sinceFirst < NUDGE_AFTER_DAYS) continue;
    }
    // A quote reminder in the last 3 days counts as contact
    const recentQ = await sb(`wa_followups?select=id&kind=eq.quote_reminder&wa_number=eq.${phone}&dry_run=eq.false&status=eq.sent&created_at=gte.${isoDate(addDays(new Date(), -NUDGE_AFTER_DAYS))}&limit=1`);
    if (recentQ?.length) continue;

    const lang = (l.language || "es").toLowerCase() === "en" ? "en" : "es";
    const name = firstName(l.name) || (lang === "es" ? "de nuevo" : "again");
    const item = {
      kind: "lead_nudge", phone, lead_id: l.id, quote_id: null, lang, seq: nPrev + 1,
      template: `lead_nudge_${lang}`, params: [name],
      preview: PREVIEW[`lead_nudge_${lang}`](name),
      summary: { kind: "lead_nudge", to: phone, name, seq: nPrev + 1, silent_days: Math.floor(silentDays), lead_age_days: Math.floor(leadAgeDays), lang },
    };
    out.push(item); report.lead_nudges.push(item.summary);
  }
  return out;
}

/* ────────────────────────── sending ────────────────────────── */

async function sendTemplate(item) {
  if (!WA_TOKEN || !PHONE_ID) return { ok: false, error: "WHATSAPP_TOKEN / WHATSAPP_PHONE_ID missing" };
  const payload = {
    messaging_product: "whatsapp", to: item.phone, type: "template",
    template: {
      name: item.template, language: { code: TEMPLATE_LANG[item.lang] },
      components: [{ type: "body", parameters: item.params.map((p) => ({ type: "text", text: String(p || "-") })) }],
    },
  };
  try {
    const r = await fetch(`https://graph.facebook.com/${GRAPH_VER}/${PHONE_ID}/messages`, {
      method: "POST", headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: d?.error?.message || `HTTP ${r.status}` };
    return { ok: true, messageId: d?.messages?.[0]?.id || null };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function recordOutbound(item, messageId) {
  try {
    await sb(`wa_messages?on_conflict=wa_msg_id`, {
      method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify({
        wa_msg_id: messageId || `followup-${Date.now()}`, direction: "outbound", from_number: PHONE_ID, to_number: item.phone,
        client_name: "FR-Logistics (auto follow-up)", body: item.preview, msg_type: "template",
        timestamp: new Date().toISOString(), read: true, replied: false,
      }),
    });
  } catch (e) { console.error("[wa-followups] recordOutbound:", e.message); }
}

async function logFollowup(item, extra) {
  try {
    await sb(`wa_followups`, {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ kind: item.kind, wa_number: item.phone, lead_id: item.lead_id, quote_id: item.quote_id, template: item.template, language: item.lang, seq: item.seq, dry_run: false, ...extra }),
    });
  } catch (e) { console.error("[wa-followups] log:", e.message); }
}

/* ────────────────────────── helpers ────────────────────────── */

async function sb(path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init, headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status} on ${path.split("?")[0]}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
  if (init.headers?.Prefer && /return=minimal/.test(init.headers.Prefer)) return null;
  return r.json();
}
async function loadOptouts() {
  const rows = await sb(`wa_optouts?select=wa_number&reopted_in_at=is.null`).catch(() => []);
  return new Set((rows || []).map((r) => normalizePhone(r.wa_number)));
}
function normalizePhone(raw) {
  let d = String(raw || "").replace(/\D/g, ""); if (!d) return "";
  if (d.length === 12 && d.startsWith("11")) d = d.slice(1);
  if (d.length === 10 && /^[2-9]/.test(d)) d = "1" + d;
  return d;
}
function firstName(n) {
  const w = String(n || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const first = w[0] || "";
  return /^[\p{L}'-]{2,}$/u.test(first) && first.length <= 20 ? first : "";
}
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }
function isoDate(d) { return d.toISOString().slice(0, 10); }
function prettyDate(iso, lang) {
  const d = new Date(iso + "T12:00:00Z");
  return d.toLocaleDateString(lang === "es" ? "es-US" : "en-US", { month: "long", day: "numeric", timeZone: "America/New_York" });
}
