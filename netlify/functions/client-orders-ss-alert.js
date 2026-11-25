// netlify/functions/client-orders-ss-alert.js
// FR-Logistics — ALERTA: órdenes del portal exportadas a CSV que NO están en ShipStation.
//
// Función PROGRAMADA (ver netlify.toml). Corre cada hora en horario laboral,
// ejecuta la misma verificación que la pantalla Client Orders
// (runCheck() de client-orders-ss-check.js) y, si hay órdenes exportadas hace
// más de GRACE_HOURS que siguen sin aparecer en ShipStation, manda UN correo
// consolidado vía Resend.
//
// Cada orden se alerta UNA sola vez por exportación (client_orders.ss_alerted_at).
// Si la orden se devuelve a Pending y se vuelve a exportar, el requeue limpia
// ss_alerted_at y vuelve a quedar vigilada.
//
// IMPORTANTE: por ser programada, Netlify NO permite invocarla por URL
// (devuelve "Internal Error"). Para verificar a mano usar
// /.netlify/functions/client-orders-ss-check, que es la versión HTTP.
//
// Variables de entorno: SUPABASE_URL, SUPABASE_SERVICE_KEY, SS_API_KEY,
// SS_API_SECRET, RESEND_API_KEY — todas existen, no agrega ninguna.

const { runCheck, GRACE_HOURS } = require('./client-orders-ss-check.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;

const ALERT_TO = ['josefuentes@fr-logistics.net', 'warehouse@fr-logistics.net'];
const ALERT_FROM = 'FR-Logistics <alerts@fr-logistics.net>';
const ALERT_FROM_FALLBACK = 'onboarding@resend.dev';
const PAGE_URL = 'https://apps.fr-logistics.net/portal.html#app=warehouse-orders.html';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtET(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }) + ' ET';
}

async function sendEmail({ to, subject, html, from = ALERT_FROM }) {
  if (!RESEND_KEY) throw new Error('RESEND_API_KEY not configured');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (from !== ALERT_FROM_FALLBACK) {
      console.warn(`[ss-alert] Resend con ${from} falló; reintento con ${ALERT_FROM_FALLBACK}`);
      return sendEmail({ to, subject, html, from: ALERT_FROM_FALLBACK });
    }
    throw new Error(`Resend: ${r.status} ${j.message || JSON.stringify(j)}`);
  }
  return j;
}

async function markAlerted(ids) {
  if (!ids.length) return;
  const list = ids.map((id) => `"${id}"`).join(',');
  const r = await fetch(`${SUPABASE_URL}/rest/v1/client_orders?id=in.(${list})`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ ss_alerted_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error(`PATCH ss_alerted_at: ${r.status} ${await r.text()}`);
}

function buildHtml(rows) {
  const trs = rows.map((m) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;font-family:Consolas,monospace;font-weight:700">${esc(m.order_number)}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb">${esc(m.client)}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb">${esc(m.recipient_name)}<br><span style="color:#6b7280">${esc(m.destination)}</span></td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb">${esc(fmtET(m.exported_at))}<br><span style="color:#b91c1c;font-weight:700">${esc(m.hours_since_export)} h sin entrar</span></td>
    </tr>`).join('');
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1f2937;max-width:720px">
    <div style="background:#b91c1c;color:#fff;padding:14px 18px;border-radius:8px 8px 0 0;font-size:16px;font-weight:700">
      ⚠ ${rows.length} orden(es) exportada(s) que NO están en ShipStation
    </div>
    <div style="border:1px solid #e5e7eb;border-top:none;padding:16px 18px;border-radius:0 0 8px 8px">
      <p style="margin:0 0 12px">Estas órdenes del portal se descargaron en CSV hace más de ${GRACE_HOURS} horas y el sistema
      las buscó en ShipStation sin encontrarlas. Lo más probable es que el CSV no se haya importado.
      <strong>Mientras no se importen, no se despachan.</strong></p>
      <table style="border-collapse:collapse;width:100%;font-size:13px">
        <thead><tr style="background:#f9fafb;text-align:left;color:#6b7280;font-size:11px;text-transform:uppercase">
          <th style="padding:8px">Orden</th><th style="padding:8px">Cliente</th>
          <th style="padding:8px">Destinatario</th><th style="padding:8px">Exportada</th>
        </tr></thead>
        <tbody>${trs}</tbody>
      </table>
      <p style="margin:16px 0 6px"><strong>Qué hacer:</strong></p>
      <ol style="margin:0 0 12px;padding-left:20px">
        <li>Si todavía tienes el CSV, impórtalo en ShipStation (verifica Custom Field 1).</li>
        <li>Si no lo tienes, en Client Orders usa <em>Return to Pending</em> y vuelve a exportar.</li>
      </ol>
      <p style="margin:0"><a href="${PAGE_URL}" style="color:#1d4ed8">Abrir Client Orders</a></p>
      <p style="margin:14px 0 0;color:#6b7280;font-size:11px">Alerta automática · cada orden se avisa una sola vez por exportación.</p>
    </div>
  </div>`;
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
function isScheduledEvent(event) {
  try { const b = JSON.parse((event && event.body) || "{}"); return !!(b && b.next_run); } catch { return false; }
}

exports.handler = async (event) => {
  if (isScheduledEvent(event)) {
    const t = miamiClock();
    if (!([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19].includes(t.hour) && [1, 2, 3, 4, 5, 6].includes(t.weekday))) {
      console.log(`[client-orders-ss-alert] ${t.hour}:${String(t.minute).padStart(2, "0")} Miami (día ${t.weekday}) — fuera de 8:25 AM–7:25 PM lun–sáb, se omite`);
      return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: "outside_miami_window", miami_hour: t.hour, miami_weekday: t.weekday }) };
    }
  }
  try {
    // Programada: límite de Netlify de 30 s, se le da más presupuesto que a la HTTP.
    const result = await runCheck({ dryRun: false, timeBudgetMs: 20000 });
    // Solo las que pasaron la gracia, fueron consultadas de verdad y no se avisaron aún.
    const toAlert = result.missing.filter(
      (m) => m.severity === 'alert' && m.verified && !m.ss_alerted_at
    );
    console.log(
      `[ss-alert] lookups=${result.lookups} found=${result.found.length} ` +
      `missing=${result.missing.length} to_alert=${toAlert.length} errors=${result.errors.length}`
    );
    if (result.errors.length) console.error('[ss-alert] errors', JSON.stringify(result.errors));

    if (toAlert.length) {
      const subject = `⚠ ${toAlert.length} orden(es) del portal NO están en ShipStation`;
      await sendEmail({ to: ALERT_TO, subject, html: buildHtml(toAlert) });
      await markAlerted(toAlert.map((m) => m.id));
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, alerted: toAlert.length }) };
  } catch (err) {
    console.error('[ss-alert] failed', err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(err.message || err) }) };
  }
};
