// netlify/functions/dropship-sync-run.js
// ─────────────────────────────────────────────────────────────────────────────
// Gemelo invocable por HTTP de dropship-gmail-sync.
//
// POR QUÉ EXISTE:
// dropship-gmail-sync.js está declarada como Scheduled Function en netlify.toml
// ("0 */2 * * *"). Netlify NO permite invocar funciones programadas por URL, así
// que el navegador recibe "Internal Error" en texto plano en vez de JSON y el
// portal revienta con: unexpected token "I" ... is not valid JSON.
//
// Esta función NO tiene cron, así que sí acepta peticiones del portal. Reutiliza
// la misma lógica importando el handler original: cero código duplicado.
//
// ⚠️ NO agregar esta función a netlify.toml. Si le pones schedule, se rompe igual.
// ⚠️ NO tocar dropship-gmail-sync.js. Sigue corriendo su cron cada 2 horas.
//
// Uso:
//   POST /.netlify/functions/dropship-sync-run
//   POST /.netlify/functions/dropship-sync-run?dry_run=1
//   GET  /.netlify/functions/dropship-sync-run?action=info
//   POST /.netlify/functions/dropship-sync-run?since=2026/04/20
//   POST /.netlify/functions/dropship-sync-run?since=2026/04/20&ignore_processed=1&max_results=200
// ─────────────────────────────────────────────────────────────────────────────

import syncHandler from "./dropship-gmail-sync.js";

export default async function handler(req, context) {
  return syncHandler(req, context);
}
