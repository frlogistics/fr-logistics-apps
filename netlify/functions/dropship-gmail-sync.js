// netlify/functions/dropship-gmail-sync.js
// Dropshipments · Gmail ingestion sync
//
// Polls warehouse@fr-logistics.net for client emails, parses them using
// per-client regex rules, uploads label PDFs to Supabase Storage, and
// inserts rows into the dropshipments table.
//
// Day 1: manual invocation only (HTTP POST to /.netlify/functions/dropship-gmail-sync).
// Day 2: migrate to Netlify Scheduled Function (hourly cron).
// Day 4: auto-extract outbound_tracking from label filename when possible,
//        eliminating the need for the Link Outbound modal in the 95%+ case
//        where the carrier embeds the outbound number in the PDF filename
//        (e.g. "shipping_label_46886078645.pdf").
// Day 4: detect inbound carrier from tracking format when the email's
//        "Transportista:" field is unreliable (some clients hardcode "Amazon"
//        regardless of actual carrier). Format-based detection overrides the
//        parsed value when a known pattern matches (UPS, Amazon, USPS, FedEx, DHL).
//
// Model: 1 Gmail message = 1 package = 1 DB row.
// Idempotent: uses (client_id, tracking_number) unique index to prevent duplicates.

const SUPABASE_URL    = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY    = Netlify.env.get("SUPABASE_SERVICE_KEY");
const GMAIL_CLIENT_ID = Netlify.env.get("GMAIL_CLIENT_ID");
const GMAIL_SECRET    = Netlify.env.get("GMAIL_CLIENT_SECRET");
const GMAIL_REFRESH   = Netlify.env.get("GMAIL_REFRESH_TOKEN");
const GMAIL_USER      = Netlify.env.get("GMAIL_USER_EMAIL");

const SB_BUCKET = "dropship-labels";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

// ─── Supabase helpers (REST) ─────────────────────────────────────────────────
const SB = () => ({ "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" });
async function sbSelect(t, q = "") { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}${q}`, { headers: SB() }); if (!r.ok) throw new Error(`sbSelect ${t}: ${await r.text()}`); return r.json(); }
async function sbInsert(t, d) { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}`, { method: "POST", headers: { ...SB(), "Prefer": "return=representation" }, body: JSON.stringify(d) }); if (!r.ok) throw new Error(`sbInsert ${t}: ${await r.text()}`); return r.json(); }
async function sbPatch(t, f, d) { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}?${f}`, { method: "PATCH", headers: { ...SB(), "Prefer": "return=representation" }, body: JSON.stringify(d) }); if (!r.ok) throw new Error(`sbPatch ${t}: ${await r.text()}`); return r.json(); }

// ─── Supabase Storage upload ─────────────────────────────────────────────────
async function sbStorageUpload(path, bytes, contentType = "application/pdf") {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${SB_BUCKET}/${path}`, {
    method: "POST",
    headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": contentType, "x-upsert": "true" },
    body: bytes
  });
  if (!r.ok) throw new Error(`sbStorageUpload ${path}: ${await r.text()}`);
  return `${SB_BUCKET}/${path}`;
}

// ─── Gmail OAuth: get short-lived access token from refresh token ────────────
let _accessTokenCache = { token: null, expiresAt: 0 };
async function gmailAccessToken() {
  if (_accessTokenCache.token && Date.now() < _accessTokenCache.expiresAt - 30000) return _accessTokenCache.token;
  const params = new URLSearchParams({ client_id: GMAIL_CLIENT_ID, client_secret: GMAIL_SECRET, refresh_token: GMAIL_REFRESH, grant_type: "refresh_token" });
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString() });
  const j = await r.json();
  if (!r.ok) throw new Error(`gmail token: ${j.error_description || j.error}`);
  _accessTokenCache = { token: j.access_token, expiresAt: Date.now() + (j.expires_in * 1000) };
  return j.access_token;
}
async function gmailFetch(path, opts = {}) {
  const t = await gmailAccessToken();
  const r = await fetch(`${GMAIL_BASE}${path}`, { ...opts, headers: { ...(opts.headers || {}), "Authorization": `Bearer ${t}` } });
  if (!r.ok) throw new Error(`gmail ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

// ─── Gmail: search, read, decode, label ──────────────────────────────────────
async function gmailSearch(query, maxResults = 50) {
  const q = encodeURIComponent(query);
  const j = await gmailFetch(`/messages?q=${q}&maxResults=${maxResults}`);
  return j.messages || [];
}
async function gmailGetMessage(id) {
  return gmailFetch(`/messages/${id}?format=full`);
}
async function gmailGetAttachment(msgId, attId) {
  const j = await gmailFetch(`/messages/${msgId}/attachments/${attId}`);
  return b64urlToBytes(j.data);
}
async function gmailEnsureLabel(name) {
  const all = await gmailFetch("/labels");
  const existing = (all.labels || []).find(l => l.name === name);
  if (existing) return existing.id;
  const created = await gmailFetch("/labels", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }) });
  return created.id;
}
async function gmailAddLabel(msgId, labelId) {
  await gmailFetch(`/messages/${msgId}/modify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ addLabelIds: [labelId] }) });
}

// ─── Decode helpers ──────────────────────────────────────────────────────────
function b64urlToBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function b64urlToString(s) {
  const bytes = b64urlToBytes(s);
  return new TextDecoder("utf-8").decode(bytes);
}
// Walk MIME tree and return the text/plain body (fallback to text/html stripped).
function extractBody(payload) {
  if (!payload) return "";
  const parts = [payload, ...(payload.parts || [])];
  const queue = [...parts];
  let htmlFallback = "";
  while (queue.length) {
    const p = queue.shift();
    if (p.parts) queue.push(...p.parts);
    if (!p.body?.data) continue;
    if (p.mimeType === "text/plain") return b64urlToString(p.body.data);
    if (p.mimeType === "text/html" && !htmlFallback) htmlFallback = b64urlToString(p.body.data);
  }
  return htmlFallback.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
}
// Find first PDF attachment that matches pattern, return { filename, attachmentId }.
function findPdfAttachment(payload, pattern) {
  const re = new RegExp(pattern, "i");
  const queue = [payload];
  while (queue.length) {
    const p = queue.shift();
    if (p.parts) queue.push(...p.parts);
    if (p.filename && p.body?.attachmentId && re.test(p.filename)) {
      return { filename: p.filename, attachmentId: p.body.attachmentId, mimeType: p.mimeType };
    }
  }
  return null;
}

// ─── Extract outbound tracking from label filename ───────────────────────────
// Many carriers embed the outbound tracking number in the PDF filename itself,
// e.g. "shipping_label_46886078645.pdf" → outbound = 46886078645.
//
// When this matches, the row is inserted with outbound_tracking already set,
// eliminating the need for the operator to scan the outbound barcode via the
// Link Outbound modal. If the pattern doesn't match (e.g. future clients with
// a different filename convention), the field stays NULL and the modal serves
// as the fallback path.
//
// FUTURE: if additional clients onboard with different filename formats,
// move this regex into dropship_client_configs.outbound_filename_pattern
// (per-client, like parsing_rules and attachment_pattern).
function extractOutboundFromFilename(filename) {
  if (!filename) return null;
  const m = filename.match(/shipping_label_(\d+)\.pdf/i);
  return m ? m[1] : null;
}

// ─── Detect carrier from tracking number format ──────────────────────────────
// Day 4: some client emails have an unreliable "Transportista:" field that
// always says "Amazon" regardless of the actual carrier. Since carrier formats
// are highly recognizable, we use the tracking pattern as ground truth and
// override when there's a clear match.
//
// Returns a normalized carrier name if the tracking matches a known pattern,
// null otherwise. The caller decides whether to override the email value.
function detectCarrierFromTracking(tracking) {
  if (!tracking) return null;
  const t = tracking.trim().toUpperCase();

  // UPS: "1Z" + 16 alphanumeric characters (total 18 chars)
  if (/^1Z[A-Z0-9]{16}$/.test(t)) return "UPS";

  // Amazon Logistics: "TBA" + 9-12 digits (historically 10 or 12)
  if (/^TBA\d{9,12}$/.test(t)) return "Amazon";

  // USPS: 20-26 digits, often starting with 92, 93, 94, 95, 9202, 9305, etc.
  // Also: USPS tracking label starts with 9 and is 22-26 digits.
  if (/^9\d{21,25}$/.test(t)) return "USPS";

  // FedEx Ground: 15 digits. FedEx Express: 12 digits.
  // Avoid collision with UPS/USPS/Amazon by requiring no prefix.
  if (/^\d{12}$/.test(t)) return "FedEx";
  if (/^\d{15}$/.test(t)) return "FedEx";

  // DHL: 10-11 digits (common for DHL Express).
  if (/^\d{10,11}$/.test(t)) return "DHL";

  // No known pattern matched — caller should keep the email-provided value.
  return null;
}

// ─── Parser: apply per-client regex rules to email body ──────────────────────
function applyParsingRules(body, rules) {
  const out = {};
  for (const [field, pattern] of Object.entries(rules)) {
    const re = new RegExp(pattern, "im");
    const m = body.match(re);
    if (m && m[1] !== undefined) {
      out[field] = field === "qty_boxes" ? parseInt(m[1], 10) : m[1].trim();
    }
  }
  return out;
}

// ─── Build Gmail query string per client ─────────────────────────────────────
// Options:
//   since           (string, e.g. "2026/04/20")  → use `after:YYYY/MM/DD`
//                                                   instead of `newer_than:14d`
//   ignoreProcessed (boolean)                    → drop the `-label:` exclude
//                                                   so already-processed
//                                                   emails are re-processed.
//                                                   Used during reset flows.
function buildGmailQuery(cfg, opts = {}) {
  const senders = cfg.sender_emails.map(e => `from:${e}`).join(" OR ");
  const dateFilter = opts.since
    ? `after:${opts.since}`
    : "newer_than:14d";
  const labelExclude = opts.ignoreProcessed
    ? ""
    : `-label:"${cfg.gmail_label_processed}"`;
  return [
    `(${senders})`,
    `subject:"${cfg.subject_pattern}"`,
    labelExclude,
    "has:attachment",
    dateFilter
  ].filter(Boolean).join(" ");
}

// ─── Core: process one message for one client ────────────────────────────────
async function processMessage(msgSummary, cfg, labelIdProcessed) {
  const msg = await gmailGetMessage(msgSummary.id);
  const body = extractBody(msg.payload);
  const parsed = applyParsingRules(body, cfg.parsing_rules);

  if (!parsed.tracking_number) {
    console.warn(`[${cfg.client_code}] msg ${msg.id}: no tracking_number extracted, skipping`);
    return { status: "skipped", reason: "no_tracking" };
  }

  // Day 4: override carrier with format-based detection when possible.
  // Some clients' emails always report "Amazon" even when the tracking is UPS,
  // USPS, etc. The tracking number format is reliable ground truth.
  const detectedCarrier = detectCarrierFromTracking(parsed.tracking_number);
  if (detectedCarrier && detectedCarrier !== parsed.carrier) {
    console.log(`[${cfg.client_code}] msg ${msg.id}: carrier override ${parsed.carrier || "(empty)"} → ${detectedCarrier} (from tracking ${parsed.tracking_number})`);
    parsed.carrier = detectedCarrier;
  }

  // Idempotency: check if tracking already ingested for this client.
  const existing = await sbSelect("dropshipments", `?client_id=eq.${cfg.client_id}&tracking_number=eq.${encodeURIComponent(parsed.tracking_number)}&select=id,status`);
  const existingRow = existing[0];

  // Upload PDF attachment (if present).
  let labelPath = null;
  let labelFilename = null;
  let outboundTracking = null;
  const att = findPdfAttachment(msg.payload, cfg.attachment_pattern || ".*\\.pdf$");
  if (att) {
    const bytes = await gmailGetAttachment(msg.id, att.attachmentId);
    const safeTracking = parsed.tracking_number.replace(/[^A-Za-z0-9._-]/g, "_");
    labelPath = `${cfg.client_code}/${safeTracking}.pdf`;
    labelFilename = att.filename;
    outboundTracking = extractOutboundFromFilename(labelFilename);
    await sbStorageUpload(labelPath, bytes, att.mimeType || "application/pdf");
  }

  const emailReceivedAt = new Date(parseInt(msg.internalDate, 10)).toISOString();

  if (existingRow?.status === "orphan") {
    // Match orphan with its email → promote to received.
    // Clear orphan_alerted_at so if it re-enters orphan status later it's freshly alerted.
    await sbPatch("dropshipments", `id=eq.${existingRow.id}`, {
      order_id:          parsed.order_id || null,
      carrier:           parsed.carrier || null,
      content:           parsed.content || null,
      qty_boxes:         parsed.qty_boxes || 1,
      notes:             cfg.default_notes,
      label_url:         labelPath,
      label_filename:    labelFilename,
      outbound_carrier:  cfg.outbound_carrier,
      outbound_platform: cfg.outbound_platform,
      outbound_tracking: outboundTracking,
      email_message_id:  msg.id,
      email_received_at: emailReceivedAt,
      orphan_alerted_at: null,
      status:            "received"
    });
    await gmailAddLabel(msg.id, labelIdProcessed);
    return { status: "orphan_matched", id: existingRow.id };
  }

  if (existingRow) {
    // Already ingested (not orphan) → just label the email and move on.
    await gmailAddLabel(msg.id, labelIdProcessed);
    return { status: "already_ingested", id: existingRow.id };
  }

  // Fresh insert.
  const [inserted] = await sbInsert("dropshipments", {
    client_id:         cfg.client_id,
    tracking_number:   parsed.tracking_number,
    order_id:          parsed.order_id || null,
    carrier:           parsed.carrier || null,
    content:           parsed.content || null,
    qty_boxes:         parsed.qty_boxes || 1,
    notes:             cfg.default_notes,
    label_url:         labelPath,
    label_filename:    labelFilename,
    outbound_carrier:  cfg.outbound_carrier,
    outbound_platform: cfg.outbound_platform,
    outbound_tracking: outboundTracking,
    email_message_id:  msg.id,
    email_received_at: emailReceivedAt,
    status:            "pending"
  });

  await gmailAddLabel(msg.id, labelIdProcessed);
  return { status: "inserted", id: inserted.id, tracking: parsed.tracking_number };
}

// ─── Core: sync all active clients ───────────────────────────────────────────
async function runSync({ dryRun = false, since = null, ignoreProcessed = false, maxResults = 50 } = {}) {
  const configs = await sbSelect("dropship_client_configs", "?active=eq.true&select=*");
  const summary = {
    started_at: new Date().toISOString(),
    overrides: { since, ignoreProcessed, maxResults },
    clients: []
  };

  for (const cfg of configs) {
    const clientSummary = { client_code: cfg.client_code, processed: [], errors: [] };
    try {
      const labelIdProcessed = await gmailEnsureLabel(cfg.gmail_label_processed);
      const query = buildGmailQuery(cfg, { since, ignoreProcessed });
      clientSummary.query = query;
      const messages = await gmailSearch(query, maxResults);
      clientSummary.found = messages.length;

      if (dryRun) {
        clientSummary.dry_run = true;
        summary.clients.push(clientSummary);
        continue;
      }

      for (const m of messages) {
        try {
          const r = await processMessage(m, cfg, labelIdProcessed);
          clientSummary.processed.push({ msg_id: m.id, ...r });
        } catch (e) {
          console.error(`[${cfg.client_code}] msg ${m.id}:`, e.message);
          clientSummary.errors.push({ msg_id: m.id, error: e.message });
        }
      }
    } catch (e) {
      console.error(`[${cfg.client_code}] fatal:`, e.message);
      clientSummary.fatal = e.message;
    }
    summary.clients.push(clientSummary);
  }

  summary.finished_at = new Date().toISOString();
  return summary;
}

// ─── HTTP handler ────────────────────────────────────────────────────────────
const CORS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,Authorization" };
const jRes = (d, s = 200) => new Response(JSON.stringify(d, null, 2), { status: s, headers: CORS });

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "1";

  // Override params (used during reset / backfill flows). When NOT supplied,
  // the sync uses its normal defaults (newer_than:14d, exclude processed label).
  //
  //   ?since=2026/04/20      → use `after:2026/04/20` instead of newer_than:14d
  //   ?ignore_processed=1    → drop the -label exclude, re-process everything
  //   ?max_results=200       → fetch more messages in a single sync (default 50)
  //
  // Scheduled invocations always use defaults — overrides are only for manual.
  const sinceRaw = url.searchParams.get("since") || null;
  // Validate: only accept YYYY/MM/DD pattern to avoid Gmail query injection.
  const since = (sinceRaw && /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(sinceRaw)) ? sinceRaw : null;
  const ignoreProcessed = url.searchParams.get("ignore_processed") === "1";
  const maxResultsRaw = parseInt(url.searchParams.get("max_results") || "0", 10);
  const maxResults = (maxResultsRaw > 0 && maxResultsRaw <= 500) ? maxResultsRaw : 50;

  // Netlify Scheduled Functions identify themselves via this header.
  // We also accept legacy User-Agent match as a fallback.
  const ua = req.headers.get("user-agent") || "";
  const isScheduled =
    req.headers.get("x-nf-event") === "schedule" ||
    ua.toLowerCase().includes("netlify-scheduled");

  // Health/info endpoint
  if (req.method === "GET" && url.searchParams.get("action") === "info") {
    return jRes({
      module: "dropship-gmail-sync",
      gmail_user: GMAIL_USER,
      bucket: SB_BUCKET,
      mode: "manual + scheduled (every 2h)",
      usage: {
        run:               "POST /.netlify/functions/dropship-gmail-sync",
        dry_run:           "POST /.netlify/functions/dropship-gmail-sync?dry_run=1",
        info:              "GET  /.netlify/functions/dropship-gmail-sync?action=info",
        backfill_since:    "POST /.netlify/functions/dropship-gmail-sync?since=2026/04/20",
        full_reset_resync: "POST /.netlify/functions/dropship-gmail-sync?since=2026/04/20&ignore_processed=1&max_results=200"
      },
      scheduled: {
        active: true,
        schedule: "0 */2 * * *",
        note: "Runs automatically every 2 hours. See netlify.toml."
      }
    });
  }

  // Allow GET from scheduled invocation as well (belt + suspenders for Netlify quirks).
  const shouldRun = req.method === "POST" || isScheduled;
  if (!shouldRun) {
    return jRes({ error: "Method not allowed. POST to run sync." }, 405);
  }

  // Scheduled invocations always use defaults; reject overrides for safety.
  const effectiveSince = isScheduled ? null : since;
  const effectiveIgnore = isScheduled ? false : ignoreProcessed;
  const effectiveMaxResults = isScheduled ? 50 : maxResults;

  try {
    const summary = await runSync({
      dryRun,
      since: effectiveSince,
      ignoreProcessed: effectiveIgnore,
      maxResults: effectiveMaxResults
    });
    if (isScheduled) {
      const totalProcessed = (summary.clients || []).reduce((a, c) => a + (c.processed?.length || 0), 0);
      const totalErrors    = (summary.clients || []).reduce((a, c) => a + (c.errors?.length    || 0), 0);
      console.log(`[dropship-gmail-sync] scheduled run: ${totalProcessed} processed, ${totalErrors} errors`);
    }
    return jRes({ ok: true, scheduled: isScheduled, summary });
  } catch (e) {
    console.error("[dropship-gmail-sync] fatal:", e);
    return jRes({ ok: false, error: e.message, stack: e.stack }, 500);
  }
}
