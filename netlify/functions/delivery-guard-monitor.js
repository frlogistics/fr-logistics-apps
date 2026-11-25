// netlify/functions/delivery-guard-monitor.js
// FR-Logistics — DELIVERY GUARD, scheduled pass (23-nov-2026).
//
// Runs the engine in _delivery-guard/core.js for every client with
// fr_clients.delivery_guard = true:
//   (a) open ShipStation orders  → status sync + pre-ship address hold
//   (b) new shipments            → shipment_tracking
//   (c) tracking (ShipStation V2) → exceptions + client email
//   (d) overdue cases            → default action / reminder
//
// Schedule lives in netlify.toml ([functions."delivery-guard-monitor"]).
// Stack rule: a scheduled function never answers the browser — the HTTP
// "Run now" button calls delivery-exceptions.js?action=run instead.
//
// No new environment variables.

const { runMonitor } = require('./_delivery-guard/core.js');

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
    if (!([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18].includes(t.hour))) {
      console.log(`[delivery-guard-monitor] ${t.hour}:${String(t.minute).padStart(2, "0")} Miami (día ${t.weekday}) — fuera de 6:05 AM–6:05 PM, se omite`);
      return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: "outside_miami_window", miami_hour: t.hour, miami_weekday: t.weekday }) };
    }
  }
  try {
    // Scheduled functions are cut at 30 s; leave margin for the last writes.
    const report = await runMonitor({ timeBudgetMs: 24000 });
    console.log('[delivery-guard-monitor]', JSON.stringify(report));
    return { statusCode: 200, body: JSON.stringify(report) };
  } catch (err) {
    console.error('[delivery-guard-monitor] failed:', err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(err.message || err) }) };
  }
};
