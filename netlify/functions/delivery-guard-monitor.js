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

exports.handler = async () => {
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
