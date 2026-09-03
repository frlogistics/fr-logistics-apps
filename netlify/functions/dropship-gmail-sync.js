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
// Day 5: parse the PDF label content to extract the REAL scannable barcode,
//        not just the filename ID. Some routes (e.g. Total Express / Brazil
//        Remessa Conforme) use a barcode like "MAIL103329991TX" that DIFFERS
//        from the filename's numeric ID. PDF-extracted value takes precedence;
//        filename is kept as fallback for when PDF parsing returns nothing.
//
// Day 6 (2026-08-03): CONSOLIDATED PACKAGES. Amazon (and other suppliers) merge
//        several purchases into ONE box with ONE inbound tracking, while each
//        purchase still fulfills a DIFFERENT outbound order. The client sends
//        one email per outbound Order ID, all repeating the same inbound
//        Tracking Number. Four things had to change for that to work:
//          1. Row identity is now (client_id, tracking_number, order_id).
//          2. Label storage path includes order_id — otherwise the 2nd and 3rd
//             PDFs overwrote the 1st (same path + x-upsert:true).
//          3. Orphan adoption is a separate lookup: an orphan row created by
//             scanning the physical box has NO order_id, so the exact match
//             can't find it. First email adopts the orphan; the rest insert.
//          4. group_total is read from the email body ("Ordenes en este
//             paquete: 3") so the warehouse knows the box isn't done yet.
//        group_seq is assigned as (rows already ingested for this tracking + 1).
//
// Day 6: outbound_tracking extraction is now PER CLIENT via
//        dropship_client_configs.outbound_filename_pattern / outbound_pdf_pattern.
//        NULL on both = historical defaults, so LN Store is unaffected.
//        When nothing matches, the sync returns pdf_hint with the numeric
//        candidates found in the label so the pattern can be configured
//        without guessing.
//
// Model: 1 Gmail message = 1 OUTBOUND ORDER = 1 DB row.
//        (N rows may share one inbound tracking_number.)
// Idempotent: uses (client_id, tracking_number, COALESCE(order_id,'')) unique
//        index to prevent duplicates.

// Note: import from /lib/pdf-parse.js (not the package root) to skip the
// debug auto-test that runs on `require('pdf-parse')` and breaks in serverless
// environments that don't ship the test fixtures.
import pdfParse from "pdf-parse/lib/pdf-parse.js";

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

// ─── Outbound-label conflict (Day 7, 2026-08-13) ─────────────────────────────
// dropshipments has a UNIQUE index on outbound_tracking
// (idx_dropshipments_outbound_unique ... WHERE outbound_tracking IS NOT NULL).
// It exists for a good reason: two packages must never carry the same outbound
// label. But there is a legitimate business case that hits it — a REPLACEMENT.
// When a package arrives empty/damaged and the client re-buys the item, the
// SALE is still the same, so the client re-sends the SAME outbound label with a
// NEW inbound tracking. Before this change, that insert/patch died with a 23505
// the sync only recorded in its summary: the email never became a row, nobody
// was alerted, and the box surfaced days later as an orphan.
//
// New behaviour: the row is created/updated anyway, WITHOUT outbound_tracking,
// with status "exception" and a reason naming the row that already owns the
// label. It shows up in the app's Exceptions tab, where a human decides which
// of the two ships.
function isOutboundConflict(err) {
  const m = String(err?.message || "");
  return m.includes("idx_dropshipments_outbound_unique") ||
         (m.includes("23505") && m.includes("outbound_tracking"));
}

async function findOutboundOwner(outbound) {
  if (!outbound) return null;
  try {
    const rows = await sbSelect(
      "dropshipments",
      `?outbound_tracking=eq.${encodeURIComponent(outbound)}&select=tracking_number,order_id,status,content&limit=1`
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

function outboundConflictReason(outbound, owner) {
  const who = owner
    ? `inbound ${owner.tracking_number}${owner.order_id ? ` / order ${owner.order_id}` : ""} (status: ${owner.status})`
    : "another row";
  return `Outbound label ${outbound} is already assigned to ${who}. ` +
         `Likely a replacement shipment reusing the same sale label. ` +
         `Decide which box ships, then use Link Outbound.`;
}

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
// Day 6: this is now per-client. cfg.outbound_filename_pattern holds a regex
// with ONE capture group; NULL falls back to the historical LN Store format,
// so existing clients keep working with no config change.
//
// Note for Shop World (SW): their PDFs are named after the SALE order
// (e.g. "MLA-82502-2026.pdf"), not the outbound tracking, so their
// outbound_filename_pattern stays NULL on purpose — their number has to come
// from the PDF content instead. See extractBarcodeFromPDF.
const DEFAULT_OUTBOUND_FILENAME_RE = "shipping_label_(\\d+)\\.pdf";

function extractOutboundFromFilename(filename, pattern) {
  if (!filename) return null;
  let re;
  try {
    re = new RegExp(pattern || DEFAULT_OUTBOUND_FILENAME_RE, "i");
  } catch (err) {
    console.warn(`[outbound-filename] bad pattern "${pattern}": ${err.message}`);
    re = new RegExp(DEFAULT_OUTBOUND_FILENAME_RE, "i");
  }
  const m = filename.match(re);
  return m && m[1] ? m[1] : null;
}

// ─── Extract real barcode from PDF content (Day 5) ───────────────────────────
// Some labels have a barcode that DIFFERS from the filename-embedded ID.
// Known case: MailAmericas → Total Express (Brazil / Remessa Conforme) uses
// a barcode like "MAIL103329991TX" while the filename has the MailAmericas
// internal numeric reference (e.g. "shipping_label_46893563630.pdf").
//
// This function parses the PDF text and tries to find the real scannable
// barcode. The caller should prefer this value over the filename extraction.
//
// Strategy (in order of specificity):
//   1. MailAmericas-Brazil format: "MAIL" + 9-10 digits + "TX".
//      Most specific pattern; when present, it's authoritative.
//   2. If the filename-ID is present in the PDF text → confirmed match,
//      meaning the filename IS the barcode (normal case, e.g. Argentina).
//   3. Return null → caller falls back to filename-based extraction.
//
// Returns: { barcode, source } on success, null otherwise.
// Non-fatal: any error returns null so the sync continues with filename fallback.
// Day 6: cfgPattern (dropship_client_configs.outbound_pdf_pattern) is tried
// FIRST when present, so a client whose label format we already know is
// resolved without touching this file. When nothing matches, the function
// returns a `hint` with the numeric candidates found in the label, which the
// sync surfaces in its summary so the pattern can be configured from evidence
// instead of guessed.
// ─── Day 7 (2026-09-03): detect the OUTBOUND carrier from the label ─────────
// From 2026-09-08 Mercado Libre replaces MailAmericas with Chilexpress, and
// between 09-08 and 09-11 both operate: orders placed up to 09-07 keep their
// MailAmericas label, new ones get Chilexpress.
//
// Until now the row's outbound_carrier was copied from the client config at
// ingestion time. That breaks during the transition: the config is per CLIENT,
// but the carrier is per PACKAGE, and the email can arrive days after the order
// was placed. A package with a MailAmericas label ingested on 09-09 would be
// stamped Chilexpress and land in the Chilexpress manifest — meaning we'd hand
// Chilexpress a manifest listing parcels we physically dropped at MailAmericas.
//
// So the label is the ground truth, same reasoning as detectCarrier() below for
// the inbound side: the config is a declaration, the label is evidence.
//
// Discriminator, verified against 6 real MailAmericas labels (AR + BR):
//   - "USXFL1" appears in the Chilexpress origin box  → Chilexpress
//   - "FBA02" (MELI origin box) or a MAIL…TX barcode  → MailAmericas
//   - note "MailAmericas" as a word is NOT reliable: on Argentina labels it is
//     a logo IMAGE, absent from extracted text. Only Brazil carries it as text.
// Returns null when nothing matches, so the caller falls back to the config.
function detectOutboundCarrierFromLabel(cleanedText) {
  if (!cleanedText) return null;
  const t = cleanedText.toUpperCase();
  if (t.includes("USXFL1")) return "Chilexpress";
  if (t.includes("FBA02") || /MAIL\d{9,10}TX/.test(t) || t.includes("MAILAMERICAS")) return "MailAmericas";
  return null;
}

async function extractBarcodeFromPDF(pdfBuffer, filenameId, cfgPattern = null) {
  if (!pdfBuffer) return null;

  let text;
  try {
    const data = await pdfParse(pdfBuffer);
    text = data?.text || "";
  } catch (err) {
    console.warn(`[pdf-extract] parse failed: ${err.message}`);
    return null;
  }

  // Normalize: strip whitespace so spaced-out barcodes match
  // (e.g. "MA IL1 033 299 91 TX" → "MAIL103329991TX")
  const cleaned = text.replace(/\s+/g, "");

  // Day 7: carrier detected from the label itself, returned on every path so
  // the caller can stamp the row regardless of which barcode pattern matched.
  const carrier = detectOutboundCarrierFromLabel(cleaned);

  // Pattern 0 — per-client pattern from config. Highest priority.
  if (cfgPattern) {
    try {
      const m = cleaned.match(new RegExp(cfgPattern, "i"));
      if (m && m[1]) return { barcode: m[1].toUpperCase(), source: "pdf_client_pattern", carrier };
    } catch (err) {
      console.warn(`[pdf-extract] bad outbound_pdf_pattern "${cfgPattern}": ${err.message}`);
    }
  }

  // Pattern 1 — MailAmericas / Total Express (Brazil, Remessa Conforme)
  // Specific format, highest priority when present.
  const brazilMatch = cleaned.match(/MAIL\d{9,10}TX/i);
  if (brazilMatch) {
    return { barcode: brazilMatch[0].toUpperCase(), source: "pdf_brazil_total", carrier };
  }

  // Pattern 2 — filename-ID appears in PDF text
  // This confirms filename = barcode (typical MailAmericas Express route).
  if (filenameId && cleaned.includes(filenameId)) {
    return { barcode: filenameId, source: "pdf_filename_confirmed", carrier };
  }

  // No recognized pattern matched. Return the numeric candidates so whoever
  // configures outbound_pdf_pattern can see what the label actually contains.
  const candidates = [...new Set((text.match(/[A-Z0-9]{8,}/gi) || []))].slice(0, 12);
  return { barcode: null, source: "no_match", hint: candidates, carrier };
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
// META_KEYS are entries inside parsing_rules that are NOT body fields:
// they configure other parts of the pipeline. Running them as field regexes
// would put junk in the parsed object.
const META_KEYS = new Set(["block_separator", "label_file"]);
const INT_FIELDS = new Set(["qty_boxes", "group_total"]);

function applyParsingRules(body, rules) {
  const out = {};
  for (const [field, pattern] of Object.entries(rules || {})) {
    if (META_KEYS.has(field)) continue;
    let re;
    try {
      re = new RegExp(pattern, "im");
    } catch (err) {
      console.warn(`[parse] bad rule "${field}": ${err.message}`);
      continue;
    }
    const m = body.match(re);
    if (m && m[1] !== undefined) {
      out[field] = INT_FIELDS.has(field) ? parseInt(m[1], 10) : m[1].trim();
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

  // ── Day 6: row identity is (client, inbound tracking, outbound order) ──────
  // Pull every row already ingested for this inbound tracking. With a
  // consolidated package there can be several — one per outbound order.
  const trackingQ = encodeURIComponent(parsed.tracking_number);
  const siblings = await sbSelect(
    "dropshipments",
    `?client_id=eq.${cfg.client_id}&tracking_number=eq.${trackingQ}&select=id,status,order_id`
  );

  // 1. Exact match on this outbound order → already ingested.
  let existingRow = parsed.order_id
    ? siblings.find(r => r.order_id === parsed.order_id)
    : siblings.find(r => !r.order_id);

  // 2. Orphan adoption. When the operator scans the physical box before the
  //    email arrives, the row has this tracking and NO order_id yet, so the
  //    exact match above can't find it. The FIRST email for the box adopts
  //    that orphan; the remaining orders insert their own rows.
  if (!existingRow) {
    existingRow = siblings.find(r => r.status === "orphan" && !r.order_id) || null;
  }

  // Group bookkeeping. group_total comes from the email body
  // ("Ordenes en este paquete: 3"); a value of 1 or absent means a plain
  // single-order package and both columns stay NULL.
  const groupTotal = Number.isInteger(parsed.group_total) && parsed.group_total > 1
    ? parsed.group_total
    : null;
  const groupSeq = groupTotal
    ? siblings.filter(r => r.id !== existingRow?.id).length + 1
    : null;

  // Upload PDF attachment (if present).
  let labelPath = null;
  let labelFilename = null;
  let outboundTracking = null;
  let pdfHint = null;
  let outboundCarrierFromLabel = null;
  const att = findPdfAttachment(msg.payload, cfg.attachment_pattern || ".*\\.pdf$");
  if (att) {
    const bytes = await gmailGetAttachment(msg.id, att.attachmentId);
    const safeTracking = parsed.tracking_number.replace(/[^A-Za-z0-9._-]/g, "_");
    // Day 6: the order_id MUST be part of the path. Without it, the 2nd and 3rd
    // labels of a consolidated package write to the same object with
    // x-upsert:true and silently overwrite the 1st — leaving all three rows
    // pointing at the same PDF.
    const safeOrder = (parsed.order_id || "no-order").replace(/[^A-Za-z0-9._-]/g, "_");
    labelPath = `${cfg.client_code}/${safeTracking}__${safeOrder}.pdf`;
    labelFilename = att.filename;

    // Day 5: Try PDF content first for the authoritative barcode (e.g. Brazil
    // routes where the barcode differs from the filename ID). Fall back to
    // filename-based extraction if the PDF parser returns nothing.
    const filenameId = extractOutboundFromFilename(labelFilename, cfg.outbound_filename_pattern);
    const pdfResult  = await extractBarcodeFromPDF(bytes, filenameId, cfg.outbound_pdf_pattern);
    // NOTE: deliberately NOT called detectedCarrier — that name is already
    // taken above for the INBOUND carrier (Amazon/UPS/USPS). Two different
    // things: this one is who takes the parcel OUT of the building.
    outboundCarrierFromLabel = pdfResult?.carrier || null;
    if (outboundCarrierFromLabel && outboundCarrierFromLabel !== cfg.outbound_carrier) {
      console.log(`[${cfg.client_code}] ${parsed.tracking_number}: outbound carrier from label = ${outboundCarrierFromLabel} (config says ${cfg.outbound_carrier})`);
    }

    if (pdfResult?.barcode) {
      outboundTracking = pdfResult.barcode;
      console.log(`[${cfg.client_code}] ${parsed.tracking_number}: outbound=${outboundTracking} (source: ${pdfResult.source})`);
    } else if (filenameId) {
      outboundTracking = filenameId;
      console.log(`[${cfg.client_code}] ${parsed.tracking_number}: outbound=${outboundTracking} (source: filename_fallback)`);
    } else {
      pdfHint = pdfResult?.hint || null;
      console.log(`[${cfg.client_code}] ${parsed.tracking_number}: no outbound_tracking extracted (will need Link Outbound modal). PDF candidates: ${(pdfHint || []).join(", ") || "none"}`);
    }

    await sbStorageUpload(labelPath, bytes, att.mimeType || "application/pdf");
  }

  const emailReceivedAt = new Date(parseInt(msg.internalDate, 10)).toISOString();

  if (existingRow?.status === "orphan") {
    // Match orphan with its email → promote to received.
    // Clear orphan_alerted_at so if it re-enters orphan status later it's freshly alerted.
    const patch = {
      order_id:          parsed.order_id || null,
      carrier:           parsed.carrier || null,
      content:           parsed.content || null,
      qty_boxes:         parsed.qty_boxes || 1,
      notes:             cfg.default_notes,
      label_url:         labelPath,
      label_filename:    labelFilename,
      outbound_carrier:  outboundCarrierFromLabel || cfg.outbound_carrier,
      outbound_platform: cfg.outbound_platform,
      outbound_tracking: outboundTracking,
      group_seq:         groupSeq,
      group_total:       groupTotal,
      email_message_id:  msg.id,
      email_received_at: emailReceivedAt,
      orphan_alerted_at: null,
      status:            "received"
    };

    let conflict = null;
    try {
      await sbPatch("dropshipments", `id=eq.${existingRow.id}`, patch);
    } catch (e) {
      if (!isOutboundConflict(e)) throw e;
      // Day 7: the outbound label belongs to another row. Land the data anyway
      // as an exception instead of failing the message forever.
      const owner = await findOutboundOwner(outboundTracking);
      conflict = { outbound: outboundTracking, owner: owner?.tracking_number || null };
      await sbPatch("dropshipments", `id=eq.${existingRow.id}`, {
        ...patch,
        outbound_tracking: null,
        status:            "exception",
        exception_reason:  outboundConflictReason(outboundTracking, owner)
      });
      console.warn(`[${cfg.client_code}] ${parsed.tracking_number}: outbound ${outboundTracking} already used → row saved as exception`);
    }

    await gmailAddLabel(msg.id, labelIdProcessed);
    return {
      status: conflict ? "orphan_matched_outbound_conflict" : "orphan_matched",
      id: existingRow.id,
      order_id: parsed.order_id || null,
      group: groupTotal ? `${groupSeq}/${groupTotal}` : null,
      ...(conflict ? { outbound_conflict: conflict } : {}),
      ...(pdfHint ? { pdf_hint: pdfHint } : {})
    };
  }

  if (existingRow) {
    // Already ingested (not orphan) → just label the email and move on.
    await gmailAddLabel(msg.id, labelIdProcessed);
    return { status: "already_ingested", id: existingRow.id, order_id: existingRow.order_id || null };
  }

  // Fresh insert.
  const newRow = {
    client_id:         cfg.client_id,
    tracking_number:   parsed.tracking_number,
    order_id:          parsed.order_id || null,
    carrier:           parsed.carrier || null,
    content:           parsed.content || null,
    qty_boxes:         parsed.qty_boxes || 1,
    notes:             cfg.default_notes,
    label_url:         labelPath,
    label_filename:    labelFilename,
    outbound_carrier:  outboundCarrierFromLabel || cfg.outbound_carrier,
    outbound_platform: cfg.outbound_platform,
    outbound_tracking: outboundTracking,
    group_seq:         groupSeq,
    group_total:       groupTotal,
    email_message_id:  msg.id,
    email_received_at: emailReceivedAt,
    status:            "pending"
  };

  let inserted;
  let conflict = null;
  try {
    [inserted] = await sbInsert("dropshipments", newRow);
  } catch (e) {
    if (!isOutboundConflict(e)) throw e;
    // Day 7: same outbound label as an existing row (typically a replacement
    // for a package that arrived empty/damaged). Insert without the label and
    // flag it so it appears in Exceptions instead of vanishing.
    const owner = await findOutboundOwner(outboundTracking);
    conflict = { outbound: outboundTracking, owner: owner?.tracking_number || null };
    [inserted] = await sbInsert("dropshipments", {
      ...newRow,
      outbound_tracking: null,
      status:            "exception",
      exception_reason:  outboundConflictReason(outboundTracking, owner)
    });
    console.warn(`[${cfg.client_code}] ${parsed.tracking_number}: outbound ${outboundTracking} already used → row inserted as exception`);
  }

  await gmailAddLabel(msg.id, labelIdProcessed);
  return {
    status: conflict ? "inserted_outbound_conflict" : "inserted",
    id: inserted.id,
    tracking: parsed.tracking_number,
    order_id: parsed.order_id || null,
    group: groupTotal ? `${groupSeq}/${groupTotal}` : null,
    outbound_tracking: conflict ? null : outboundTracking,
    ...(conflict ? { outbound_conflict: conflict } : {}),
    ...(pdfHint ? { pdf_hint: pdfHint } : {})
  };
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
      model: "1 Gmail message = 1 outbound order = 1 row; N rows may share one inbound tracking (consolidated packages)",
      row_identity: "(client_id, tracking_number, COALESCE(order_id,''))",
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
