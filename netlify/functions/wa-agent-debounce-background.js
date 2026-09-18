// netlify/functions/wa-agent-debounce-background.js
//
// DEBOUNCE WORKER for LIAM (2026-09-18).
//
// The webhook queues every eligible inbound WhatsApp message in
// wa_agent_inbox and POSTs here once per number. Netlify answers 202 right
// away (the "-background" suffix makes this an async function, up to 15 min)
// and this code keeps running:
//
//   1. sleep QUIET_MS
//   2. ask Postgres to claim the number's pending rows — fn_wa_inbox_claim()
//      only returns rows when the NEWEST pending message is older than
//      QUIET_MS (the person stopped typing) and takes an advisory lock per
//      number, so two invocations that wake together can never split one
//      burst: the second gets zero rows and exits.
//   3. if the claim came back empty because a newer message arrived, wait a
//      bit more and retry (bounded). If it is empty because another
//      invocation already claimed it, the retries also come back empty and
//      we exit quietly.
//   4. merge the burst into ONE message and hand it to routeIncomingMessage,
//      exactly the object the webhook used to pass.
//
// Security: this URL is public, so the webhook signs the call with
// WHATSAPP_WEBHOOK_SECRET in the x-fr-internal header. No new env vars.
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY, WHATSAPP_WEBHOOK_SECRET

import { routeIncomingMessage } from "./_agent-helpers/wa-agent-router.js";

const QUIET_MS      = 15000;   // silence window before LIAM answers
const MAX_WAITS     = 6;       // max extra waits if the person keeps typing (~90s)
const EXTRA_WAIT_MS = 12000;

const INTERNAL_SECRET = process.env.WHATSAPP_WEBHOOK_SECRET || "";

export default async function handler(req) {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  // The 202 has already been sent by the platform; from here on nothing we
  // return reaches the caller. We still return responses for the logs.
  if (!INTERNAL_SECRET || req.headers.get("x-fr-internal") !== INTERNAL_SECRET) {
    console.warn("[debounce] rejected call without valid x-fr-internal header");
    return new Response("Forbidden", { status: 403 });
  }

  let body;
  try { body = await req.json(); } catch { body = {}; }
  const waNumber = String(body?.wa_number || "").replace(/[^0-9]/g, "");
  if (!waNumber) {
    console.warn("[debounce] no wa_number in body");
    return new Response("Bad Request", { status: 400 });
  }

  const batchId = `dbz-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  console.log(`[debounce] ${batchId} start for ${waNumber} (queued_at=${body?.queued_at || "?"})`);

  await sleep(QUIET_MS);

  let rows = [];
  for (let attempt = 0; attempt <= MAX_WAITS; attempt++) {
    rows = await claimPending(waNumber, batchId);
    if (rows.length) break;

    // Empty claim: either nothing pending (someone else took it) or the
    // person is still typing. Peek to tell the two apart.
    const pending = await countPending(waNumber);
    if (pending === 0) {
      console.log(`[debounce] ${batchId} nothing pending for ${waNumber} — exit`);
      return new Response("OK (nothing pending)", { status: 200 });
    }
    console.log(`[debounce] ${batchId} ${pending} pending but still typing — wait ${EXTRA_WAIT_MS}ms (${attempt + 1}/${MAX_WAITS})`);
    await sleep(EXTRA_WAIT_MS);
  }

  if (!rows.length) {
    // Still typing after ~90s: force-claim so the burst is not abandoned.
    rows = await claimPending(waNumber, batchId, 0);
    if (!rows.length) {
      console.log(`[debounce] ${batchId} gave up for ${waNumber} — nothing claimable`);
      return new Response("OK (unclaimed)", { status: 200 });
    }
  }

  const merged = mergeBurst(rows);
  console.log(`[debounce] ${batchId} routing ${rows.length} msg(s) for ${waNumber} as one: ${JSON.stringify(merged.text).slice(0, 160)}`);

  try {
    await routeIncomingMessage(merged);
  } catch (err) {
    console.error(`[debounce] ${batchId} router error:`, err?.message || err);
  }
  return new Response("OK", { status: 200 });
}

// ───────────────────────────────── helpers

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function sbRest() {
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (!sbUrl || !sbKey) return null;
  return { sbUrl, sbKey };
}

async function claimPending(waNumber, batchId, quietMs = QUIET_MS) {
  const creds = sbRest();
  if (!creds) { console.error("[debounce] missing Supabase creds"); return []; }
  try {
    const r = await fetch(`${creds.sbUrl}/rest/v1/rpc/fn_wa_inbox_claim`, {
      method: "POST",
      headers: {
        apikey: creds.sbKey,
        Authorization: `Bearer ${creds.sbKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_number: waNumber, p_batch: batchId, p_quiet_ms: quietMs }),
    });
    if (!r.ok) {
      console.error(`[debounce] claim failed HTTP ${r.status} ${await r.text().catch(() => "")}`);
      return [];
    }
    const rows = await r.json().catch(() => []);
    return Array.isArray(rows) ? rows.sort((a, b) => new Date(a.received_at) - new Date(b.received_at)) : [];
  } catch (e) {
    console.error("[debounce] claim error:", e?.message || e);
    return [];
  }
}

async function countPending(waNumber) {
  const creds = sbRest();
  if (!creds) return 0;
  try {
    const r = await fetch(
      `${creds.sbUrl}/rest/v1/wa_agent_inbox?wa_number=eq.${encodeURIComponent(waNumber)}&routed_at=is.null&select=wa_msg_id`,
      { headers: { apikey: creds.sbKey, Authorization: `Bearer ${creds.sbKey}`, Prefer: "count=exact" } }
    );
    if (!r.ok) return 0;
    const rows = await r.json().catch(() => []);
    return Array.isArray(rows) ? rows.length : 0;
  } catch { return 0; }
}

// One burst → one message with the same shape the webhook builds.
// Text parts are joined with newlines (so "Juan" + "juan@x.com" in two
// messages still resolves as name+email). Pure media placeholders like
// "[image]" are dropped when there is real text alongside, so the media
// guard in the router only fires for bursts that are ONLY media.
function mergeBurst(rows) {
  const last = rows[rows.length - 1];
  const first = rows[0];
  const isPlaceholder = (s) => /^\[[a-z]+\]$/i.test(String(s || "").trim());
  const texts = rows.map((r) => String(r.body || "").trim()).filter(Boolean);
  const real  = texts.filter((t) => !isPlaceholder(t));
  const text  = real.length ? real.join("\n") : (texts[texts.length - 1] || `[${last.msg_type || "media"}]`);
  const mediaRow = [...rows].reverse().find((r) => r.media_id);
  return {
    id:         last.wa_msg_id,
    from:       first.wa_number,
    clientName: first.client_name || first.wa_number,
    text,
    timestamp:  Math.floor(new Date(last.received_at).getTime() / 1000),
    type:       real.length ? "text" : (last.msg_type || "text"),
    mediaId:    mediaRow?.media_id || null,
    mimeType:   null,
    caption:    null,
    isInternal: false,
    isOptOut:   false,
    isOptIn:    false,
    batchIds:   rows.map((r) => r.wa_msg_id),
  };
}
