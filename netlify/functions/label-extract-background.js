// netlify/functions/label-extract-background.js
// FR-Logistics · Receiving v2 — reads a carrier label from a photo and works
// out whose package it is.
//
// Background function (the "-background" suffix): Netlify answers 202 at once
// and lets this run up to 15 minutes, so a slow vision call never times out on
// the handheld. The handheld creates the row first (label-reads.js action
// 'start'), fires this with the row id, then polls label-reads.js?id=.
//
// POST { read_id }
//
// What it does:
//   1. Loads the wh_label_reads row and the photo (must live in our bucket).
//   2. Asks the model for the label's fields as strict JSON — tracking, master,
//      "n of N", ship-from, recipient lines, RA#, references, weight.
//   3. Cleans the tracking (GS1 / spaced / OCR "12"→"1Z") and checks it against
//      what the trigger scanned. Scan wins; a mismatch lowers the status.
//   4. Calls fr_resolve_label() in Supabase — the client cascade lives in the
//      database so it can be tested with plain SQL against real data:
//        dropshipment → our outbound coming back → return label we made →
//        client order number on the label → Amazon RA# prefix → code / alias /
//        company / contact on the label → sibling boxes of the same shipment.
//      Sources that disagree = no proposal (the operator picks, as today).
//   5. Writes everything back to the row. status:
//        ok             fields read with confidence, tracking agrees with the scan
//        low_confidence blurry, partial, or scan and label disagree
//        not_label      the photo is not a shipping label
//        failed         something broke (photo kept, can be re-run)
//
// Design rules (same as slip-extract.js):
//   * NEVER writes to shipments_general. Shadow mode until Jose cuts over.
//   * NEVER guesses: an unreadable field is null; the client comes from data,
//     not from the model's opinion.
//   * Idempotent: re-running the same read_id overwrites the same row.
//
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY (or
// CLAUDE_API_KEY) — all already set. Optional LABEL_EXTRACT_MODEL. No new
// variables are required (the site is at the 4 KB env-var ceiling).

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const AI_KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
const MODEL = process.env.LABEL_EXTRACT_MODEL || process.env.SLIP_EXTRACT_MODEL || 'claude-sonnet-5';
const MAX_TOKENS = 1500;
const MIN_CONFIDENCE = 0.75;

const ALLOWED_PHOTO_PREFIX = `${SB_URL}/storage/v1/object/public/shipment-photos/`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CARRIERS = ['Amazon', 'UPS', 'USPS', 'FedEx', 'Walmart', 'Other'];

const SB_HEADERS = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
};

async function sb(path, init = {}) {
  return fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { ...SB_HEADERS, ...(init.headers || {}) } });
}

// ─── Pure helpers (exported for tests) ──────────────────────────────────────

// Mirror of public.fr_norm_tracking().
function normTracking(raw) {
  if (raw == null) return null;
  let t = String(raw).replace(/[\s()\-\u001d\u001e]/g, '').toUpperCase();
  if (!t) return null;
  if (/^12[0-9A-Z]{16}$/.test(t) && /[A-Z]/.test(t)) t = '1Z' + t.slice(2);
  const routed = t.match(/^420(?:\d{5}|\d{9})(9[2-5]\d{20})$/);
  if (routed) return routed[1];
  if (/^9[2-5]\d{20}$/.test(t)) return t;
  if (/^1Z[0-9A-Z]{16}$/.test(t)) return t;
  if (/^TBA\d{9,15}$/.test(t)) return t;
  if (/^96\d{32}$/.test(t)) return t.slice(-12);
  return t;
}

// Mirror of public.fr_tracking_carrier().
function carrierFromTracking(t) {
  if (!t) return null;
  if (/^1Z[0-9A-Z]{16}$/.test(t)) return 'UPS';
  if (/^9[2-5]\d{20}$/.test(t)) return 'USPS';
  if (/^TBA\d+$/.test(t)) return 'Amazon';
  if (/^\d{12}$/.test(t) || /^\d{15}$/.test(t)) return 'FedEx';
  return null;
}

// Map whatever the model says to the Receiving module's list.
function mapCarrier(c) {
  const s = String(c || '').toUpperCase();
  if (!s) return null;
  if (s.includes('UPS')) return 'UPS';
  if (s.includes('USPS') || s.includes('POSTAL')) return 'USPS';
  if (s.includes('FEDEX')) return 'FedEx';
  if (s.includes('AMAZON') || s.includes('AMZL')) return 'Amazon';
  if (s.includes('WALMART')) return 'Walmart';
  return 'Other';
}

// Scan vs. label: equal, or equal once the characters a camera confuses are
// folded (O/0, I/1, S/5, Z/2, B/8). The trigger scan is exact; the photo is not.
function sameTracking(a, b) {
  if (!a || !b) return null;
  if (a === b) return true;
  const fold = (x) => x.replace(/[OQ]/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5').replace(/Z/g, '2').replace(/B/g, '8');
  const fa = fold(a);
  const fb = fold(b);
  if (fa === fb) return true;
  // FedEx prints the 12-digit tracking INSIDE longer barcode strings (Ground
  // Economy "9229…", the 34-digit "96…"). On 1-Oct the scan was 530243647098
  // and the photo read 922995302436470983 — same package. If the shorter one
  // (at least 10 characters) sits inside the longer one, it is a match.
  const [s, l] = fa.length <= fb.length ? [fa, fb] : [fb, fa];
  return s.length >= 10 && l.includes(s);
}

// Does a tracking READ FROM THE PHOTO have the shape its carrier always uses?
// Only the families we are sure of are checked; anything else passes.
// 8-Oct (DLM): with no scan, the photo gave TBA33520961613319 (17) and
// TBA3352212429064 (16) for TBA335209613319 / TBA335212429064. Real Amazon
// trackings are TBA + 12 digits (379 of 388 in the log).
function trackingShapeOk(t) {
  if (!t) return false;
  if (/^TBA/.test(t)) return /^TBA\d{12}$/.test(t);
  if (/^1Z/.test(t)) return /^1Z[0-9A-Z]{16}$/.test(t);
  return true;
}

// The model sometimes returns almost-JSON (a trailing comma, a // comment, a
// sentence after the object). Every failed parse used to cost a second model
// call — 8-10 s more on the handheld — so repair the common slips first and
// only ask again when that is not enough.
function parseModelJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('model did not return JSON');
  const body = s.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch (first) {
    const repaired = body
      .replace(/\/\/[^\n"]*$/gm, '')          // line comments outside strings
      .replace(/,\s*([}\]])/g, '$1')          // trailing commas
      .replace(/[“”]/g, '"')        // curly quotes
      .replace(/\bNone\b/g, 'null').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false');
    return JSON.parse(repaired);              // throws -> caller retries once
  }
}

function cleanList(arr, max = 12) {
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => String(x == null ? '' : x).trim()).filter(Boolean).slice(0, max).map((x) => x.slice(0, 120));
}

function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 && n < 1000 ? n : null; }
function toNum(v) { const n = Number(v); return Number.isFinite(n) && n > 0 && n < 5000 ? n : null; }
function toDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null; }

// Decide status from what came back. Pure, so it can be unit-tested.
function decideStatus(parsed, trackingMatch, tracking, scanned) {
  if (parsed.is_label === false) return 'not_label';
  const conf = Number(parsed.confidence);
  if (!tracking) return 'low_confidence';
  if (trackingMatch === false) return 'low_confidence';
  if (!scanned && !trackingShapeOk(tracking)) return 'low_confidence';
  if (!Number.isFinite(conf) || conf < MIN_CONFIDENCE) return 'low_confidence';
  return 'ok';
}

const PROMPT = `You are reading a SHIPPING LABEL on a parcel that just arrived at a 3PL warehouse in Miami (FR-Logistics, 10893 NW 17th St Unit 121, Miami FL 33172). The photo was taken with a handheld; the label may be rotated 90° or 180°, creased, or partly covered. Read it in whatever orientation it is.

Return ONLY a JSON object, no markdown fences, no commentary, with exactly these keys:

{
  "is_label": true/false,
  "carrier": "UPS" | "USPS" | "FedEx" | "Amazon" | "Walmart" | "DHL" | "OnTrac" | "Other" | null,
  "service": string|null,
  "tracking": string|null,
  "master_tracking": string|null,
  "piece_no": number|null,
  "piece_total": number|null,
  "ship_from": { "name": string|null, "city": string|null, "state": string|null, "is_fr_logistics": true/false },
  "recipient_lines": [string],
  "ra_number": string|null,
  "origin_fc": string|null,
  "refs": [string],
  "weight_lb": number|null,
  "label_date": "YYYY-MM-DD"|null,
  "description": string|null,
  "confidence": number
}

How to read each field:
- tracking: the human-readable tracking number printed on the label, without spaces.
    UPS: "1Z" + 16 characters (it is printed "TRACKING #: 1Z ..."; the Z can look like a 2 — it is always 1Z).
    USPS: 20-22 digits under "USPS TRACKING #" (starts 92, 93, 94 or 95). Do NOT include the 420+ZIP routing prefix.
    FedEx: the 12-digit number printed after "TRK#" or "MPS#" (often in large bold digits like "8773 9494 1709"). Never copy the long digit string printed under a barcode (34 digits starting 96, or Ground Economy strings starting 92) — if you cannot find the 12-digit number, use null.
    Amazon: "TBA" + digits.
- master_tracking: FedEx "Mstr#" number when present (multi-piece shipments). Otherwise null.
- piece_no / piece_total: from "2 of 5", "5 OF 14", "1 OF 1".
- ship_from: the sender / FROM / return-address block. is_fr_logistics = true ONLY if the SENDER is FR Logistics / FR-Logistics / Joe Raymond at 10893 NW 17th (i.e. our own outbound label that came back).
- recipient_lines: every line of the SHIP TO / TO block EXCEPT the street, city/state/ZIP, country and phone lines. Copy them exactly as printed, including codes such as "REGALOSONLINE - REGA REG-260819", "MXS OVERSEAS LTD. (FR LOG)", "C/O FR-LOGISTICS", "FR Logistics / Fernando T", person names. Also include the "[RA# ...]" line if it sits inside that block.
- ra_number: Amazon return authorization, the text after "RA#" (e.g. "RBJOF-260821QZW-DAL2-1"). Keep the dashes.
- origin_fc: the Amazon fulfillment-center code that is the second-to-last segment of the RA# (e.g. "DAL2"), else null.
- refs: every reference / order number printed on the label: "REF:", "PO:", "INV:", "DEPT:", "Reference No.1:", shipper order numbers, and short code blocks such as "WS4B235120" in the lower part of the label. Do not include the tracking number, ZIP codes, phone numbers or Amazon routing codes (DMF5, CYCLE 1, MIA1, sort codes).
- weight_lb: package weight in pounds if printed ("20 LBS", "ACTWGT: 16.09 LB", "4.2 Lbs").
- label_date: ship date if printed, as YYYY-MM-DD; else null.
- description: "DESC:" text if present, else null.
- confidence: 0..1, how sure you are of the tracking number and the recipient lines together.

Rules: never invent a value — if a field is not legible, use null (or [] for lists). If the photo is not a shipping label at all, set is_label to false and everything else null/[] with your confidence.`;

// 8-Oct: 9 of 12 photos failed with "model did not return JSON" / a broken
// JSON string. The answer now comes back through a forced tool call, so the
// API hands us an object instead of text we have to parse. Text is only the
// fallback, and when even that fails the error keeps what the model said.
const S = (t) => ({ type: [t, 'null'] });
const LABEL_TOOL = {
  name: 'record_label',
  description: 'Record the fields read from the shipping label in the photo.',
  input_schema: {
    type: 'object',
    properties: {
      is_label: { type: 'boolean' },
      carrier: S('string'),
      service: S('string'),
      tracking: S('string'),
      master_tracking: S('string'),
      piece_no: S('number'),
      piece_total: S('number'),
      ship_from: {
        type: 'object',
        properties: { name: S('string'), city: S('string'), state: S('string'), is_fr_logistics: { type: 'boolean' } },
      },
      recipient_lines: { type: 'array', items: { type: 'string' } },
      ra_number: S('string'),
      origin_fc: S('string'),
      refs: { type: 'array', items: { type: 'string' } },
      weight_lb: S('number'),
      label_date: S('string'),
      description: S('string'),
      confidence: { type: 'number' },
    },
    required: ['is_label', 'tracking', 'recipient_lines', 'confidence'],
  },
};

async function askModel(contentType, b64, extra) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      tools: [LABEL_TOOL],
      tool_choice: { type: 'tool', name: LABEL_TOOL.name },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: contentType, data: b64 } },
          { type: 'text', text: PROMPT + '\n\nAnswer by calling record_label.' + (extra || '') },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const tool = (j.content || []).find((b) => b.type === 'tool_use' && b.input && typeof b.input === 'object');
  if (tool) return tool.input;
  const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  try {
    return parseModelJson(text);
  } catch (e) {
    throw new Error(`${e.message} [stop=${j.stop_reason || '?'}] ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
  }
}

async function patchRead(id, patch) {
  await sb(`wh_label_reads?id=eq.${id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  let readId = null;
  try {
    const body = JSON.parse(event.body || '{}');
    readId = String(body.read_id || '');
    if (!UUID_RE.test(readId)) return { statusCode: 400, body: 'bad read_id' };
    if (!SB_URL || !SB_KEY) throw new Error('Supabase not configured');
    if (!AI_KEY) throw new Error('Missing ANTHROPIC_API_KEY (or CLAUDE_API_KEY)');

    // 1. The row and its photo.
    const rr = await sb(`wh_label_reads?id=eq.${readId}&select=id,photo_url,scanned_raw,scanned_tracking&limit=1`);
    const row = (await rr.json())[0];
    if (!row) return { statusCode: 404, body: 'read not found' };
    if (!String(row.photo_url || '').startsWith(ALLOWED_PHOTO_PREFIX)) throw new Error('photo is not in our bucket');

    await patchRead(readId, { status: 'pending', error: null, model: MODEL });

    const img = await fetch(row.photo_url);
    if (!img.ok) throw new Error(`photo fetch ${img.status}`);
    const contentType = img.headers.get('content-type') || 'image/jpeg';
    const b64 = Buffer.from(await img.arrayBuffer()).toString('base64');

    // 2. Model (structured answer through the tool), one retry if it still fails.
    let parsed;
    let attempts = 1;
    try {
      parsed = await askModel(contentType, b64);
    } catch (e) {
      attempts = 2;
      parsed = await askModel(contentType, b64,
        '\n\nIMPORTANT: your previous answer could not be read. Call record_label with the fields.');
    }

    // 3. Tracking: the scan is exact, the photo is not.
    const trackingRead = normTracking(parsed.tracking);
    const scanned = row.scanned_tracking || normTracking(row.scanned_raw);
    const tracking = scanned || trackingRead;
    const trackingMatch = sameTracking(scanned, trackingRead);
    const master = normTracking(parsed.master_tracking);

    const from = parsed.ship_from || {};
    const recipientLines = cleanList(parsed.recipient_lines);
    const refs = cleanList(parsed.refs);
    const raNumber = parsed.ra_number ? String(parsed.ra_number).replace(/\s+/g, '').toUpperCase().slice(0, 60) : null;
    const raPrefix = raNumber ? raNumber.split('-')[0] || null : null;
    const fromIsFr = from.is_fr_logistics === true;

    // 4. Whose is it? Decided in the database, from data.
    let resolution = null;
    if (parsed.is_label !== false && tracking) {
      const rpc = await sb('rpc/fr_resolve_label', {
        method: 'POST',
        body: JSON.stringify({
          p_tracking: tracking,
          p_master: master,
          p_ra_number: raNumber,
          p_texts: recipientLines.length ? recipientLines : null,
          p_refs: refs.length ? refs : null,
          p_ship_from_is_fr: fromIsFr,
          p_ship_from_name: from.name || null,
          p_exclude_read: readId,
        }),
      });
      if (!rpc.ok) throw new Error(`resolver ${rpc.status}: ${(await rpc.text()).slice(0, 300)}`);
      resolution = await rpc.json();
    }

    // Same package already read in v2? (A photo taken without a scan only
    // reveals its tracking here.) Recorded, not blocked: the handheld shows it.
    if (tracking) {
      const t = encodeURIComponent(tracking);
      const pr = await sb(`wh_label_reads?or=(tracking.eq.${t},scanned_tracking.eq.${t})&id=neq.${readId}` +
        '&select=id,created_at,operator&order=created_at.desc&limit=3');
      const prev = pr.ok ? await pr.json() : [];
      if (Array.isArray(prev) && prev.length) {
        resolution = { ...(resolution || {}), duplicate_of: prev };
      }
    }

    const carrier = carrierFromTracking(tracking) || mapCarrier(parsed.carrier);
    const status = decideStatus(parsed, trackingMatch, tracking, scanned);
    if (!scanned && tracking && !trackingShapeOk(tracking)) {
      resolution = { ...(resolution || {}), tracking_suspect: true };
    }
    const confidence = Number(parsed.confidence);

    // 5. Write it all back.
    await patchRead(readId, {
      status,
      error: null,
      model: MODEL,
      confidence: Number.isFinite(confidence) ? confidence : null,
      raw_response: { ...parsed, _attempts: attempts },
      completed_at: new Date().toISOString(),
      carrier: CARRIERS.includes(carrier) ? carrier : carrier ? 'Other' : null,
      service: parsed.service ? String(parsed.service).slice(0, 80) : null,
      tracking_read: trackingRead,
      tracking,
      tracking_match: trackingMatch,
      master_tracking: master,
      piece_no: toInt(parsed.piece_no),
      piece_total: toInt(parsed.piece_total),
      ship_from_name: from.name ? String(from.name).slice(0, 120) : null,
      ship_from_city: from.city ? String(from.city).slice(0, 80) : null,
      ship_from_state: from.state ? String(from.state).slice(0, 20) : null,
      ship_from_is_fr: fromIsFr,
      recipient_lines: recipientLines,
      ra_number: raNumber,
      ra_prefix: raPrefix,
      origin_fc: parsed.origin_fc ? String(parsed.origin_fc).slice(0, 10).toUpperCase()
        : (raNumber && raNumber.split('-').length >= 3 ? raNumber.split('-').slice(-2, -1)[0] : null),
      refs,
      weight_lb: toNum(parsed.weight_lb),
      label_date: toDate(parsed.label_date),
      description: parsed.description ? String(parsed.description).slice(0, 120) : null,
      suggested_client_id: resolution ? resolution.client_id || null : null,
      suggested_type: resolution ? resolution.suggested_type || null : null,
      suggested_carrier: CARRIERS.includes(carrier) ? carrier : null,
      match_method: resolution ? resolution.method || null : null,
      route: resolution ? resolution.route || null : null,
      resolution,
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, status }) };
  } catch (err) {
    const message = String((err && err.message) || err).slice(0, 500);
    if (readId && UUID_RE.test(readId)) {
      try { await patchRead(readId, { status: 'failed', error: message, completed_at: new Date().toISOString() }); } catch { /* best effort */ }
    }
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: message }) };
  }
};

// Exported for tests only.
exports._test = { normTracking, carrierFromTracking, mapCarrier, sameTracking, parseModelJson, decideStatus, cleanList, trackingShapeOk };
