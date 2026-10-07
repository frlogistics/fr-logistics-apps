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

exports.handler = async () => {
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
