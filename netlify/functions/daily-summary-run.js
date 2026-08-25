// netlify/functions/daily-summary-run.js
//
// Manual trigger for daily-summary. Netlify refuses URL invocation of any
// function declared with a schedule (it answers "Internal Error" in plain
// text — the exact trap that broke the Dropshipments Sync button in July), so
// the runnable copy has to live in a separate file with no schedule of its
// own. Same wrapper pattern as dropship-sync-run.js: zero duplicated logic.
//
//   ?key=<WHATSAPP_WEBHOOK_SECRET>   required
//   &dry=1                           build everything, send nothing
//   &only=<client_id | company name> restrict to one client (skips the ops CC)
//
// Example (PowerShell):
//   iwr "https://apps.fr-logistics.net/.netlify/functions/daily-summary-run?key=XXX&dry=1" | % Content

import { runDailySummary } from "./daily-summary.js";

export default async function handler(req) {
  const url    = new URL(req.url);
  const key    = url.searchParams.get("key") || "";
  const secret = Netlify.env.get("WHATSAPP_WEBHOOK_SECRET") || "";

  // No secret configured means no way to authenticate the caller, and this
  // endpoint sends real WhatsApp messages and real email. Fail closed.
  if (!secret || key !== secret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" }
    });
  }

  const dryRun = url.searchParams.get("dry") === "1";
  const only   = url.searchParams.get("only") || null;

  try {
    const summary = await runDailySummary({ dryRun, only });
    return new Response(JSON.stringify(summary, null, 2), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error("[daily-summary-run] Fatal:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
}
