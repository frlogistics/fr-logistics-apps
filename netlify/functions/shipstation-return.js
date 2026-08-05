// netlify/functions/shipstation-return.js
//
// FR-Logistics · Return Labels API
// Generic return-label + carrier-pickup creation for ANY client.
//
// Style: Netlify Functions v2 (ESM) — matches dropship-manifests.js /
// dropshipments.js. Uses Netlify.env.get() and new Response().
// NOTE: do NOT add `export const config = { path }` — Netlify rejects it
// for non-scheduled functions in this site.
//
// ────────────────────────────────────────────────────────────────────
// ⚠ PREREQUISITE (must confirm before this works):
//   UPS account must be connected INSIDE ShipStation (Settings → Carriers).
//   Without it, /labels cannot rate/generate with your UPS account.
//
// API: ShipStation API V2 (api.shipstation.com) — supports native
//   return_label flag + /v2/pickups endpoint (label-based pickups).
// ────────────────────────────────────────────────────────────────────
//
// ════════════════════════════════════════════════════════════════════
// MULTI-CARRIER (UPS + USPS) — added 2026-06
//   The carrier is now selectable per return via `body.carrier` ('ups'
//   | 'usps'). Each entry resolves its own carrier_id + default service
//   + pickup capability. USPS is label-only (drop-off at any USPS
//   location); pickup remains UPS-only by business decision.
//
//     ups  → se-605521 (FR-Logistics UPS, account WE6433, funded)   pickup ✓
//     usps → se-595432 (ShipStation USPS / Stamps.com, balance)     pickup ✗
//
//   carrier_id + service codes confirmed via GET ?action=carriers.
//   A backend guard ignores schedule_pickup for any non-UPS carrier,
//   so a stale frontend can never book a USPS pickup by mistake.
// ════════════════════════════════════════════════════════════════════
//
// ════════════════════════════════════════════════════════════════════
// FIXES — 2026-08
//
// (A) MULTI-RECIPIENT EMAIL
//     The UI's Email field accepts several addresses separated by commas
//     or semicolons. That raw string used to be pushed into Resend's
//     `to` array as ONE element, so Resend answered 422 validation_error
//     ("Invalid `to` field") and NOTHING was sent — not even the
//     warehouse copy. Recipients are now split, trimmed, validated and
//     de-duplicated before the call.
//
// (B) PICKUP WINDOW TIME ZONE
//     pickup_window arrived from the UI as a naive local timestamp
//     ("2026-08-07T08:00:00", no offset). ISO 8601 without an offset is
//     ambiguous and ShipStation resolves it as UTC, so the window was
//     shifted 4-7 h earlier in the pickup address's local clock. UPS then
//     rejected it with "Closing time must be later than or equal to the
//     earliest allowable close time".
//
//     Evidence from return_labels (all 6 rows that carried a window):
//       Belton TX 76513      sent 09:00-19:00 -> close 14:00 local  OK
//       Green Bay WI 54303   sent 09:00-17:00 -> close 12:00 local  OK
//       Belton TX 76513      sent 09:00-17:00 -> close 12:00 local  OK
//       Gainesville VA 20155 sent 09:00-17:00 -> close 13:00 local  OK
//       Sacramento CA 95824  sent 09:00-17:00 -> close 10:00 local  FAIL
//       Los Angeles CA 90048 sent 08:00-18:00 -> close 11:00 local  FAIL
//
//     The window is now stamped with the real UTC offset of the pickup
//     ZIP (DST-aware), e.g. "2026-08-07T08:00:00-07:00". Local wall time
//     is preserved, so the operator's intent, the stored row and the
//     customer email all keep reading 8:00 AM - 6:00 PM.
// ════════════════════════════════════════════════════════════════════

import { getStore } from "@netlify/blobs";

const SS_BASE      = "https://api.shipstation.com/v2";
// NOTE: distinct env var from the V1 KPI dashboard function (which uses
// SS_API_KEY + SS_API_SECRET). V2 uses a single API-Key header.
const SS_API_KEY   = Netlify.env.get("SS_V2_API_KEY");
const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY");

// ─── Pickup-window time zone resolution ───────────────────────────────
// ShipStation expects ISO 8601. A timestamp with no offset is read as UTC,
// which silently moves the window in the pickup address's local clock.
// We resolve the address's IANA zone and stamp the real offset for that
// date, so DST is handled automatically.

const STATE_TZ = {
  AL:"America/Chicago",    AK:"America/Anchorage",  AZ:"America/Phoenix",
  AR:"America/Chicago",    CA:"America/Los_Angeles",CO:"America/Denver",
  CT:"America/New_York",   DE:"America/New_York",   DC:"America/New_York",
  FL:"America/New_York",   GA:"America/New_York",   HI:"Pacific/Honolulu",
  ID:"America/Denver",     IL:"America/Chicago",    IN:"America/New_York",
  IA:"America/Chicago",    KS:"America/Chicago",    KY:"America/New_York",
  LA:"America/Chicago",    ME:"America/New_York",   MD:"America/New_York",
  MA:"America/New_York",   MI:"America/New_York",   MN:"America/Chicago",
  MS:"America/Chicago",    MO:"America/Chicago",    MT:"America/Denver",
  NE:"America/Chicago",    NV:"America/Los_Angeles",NH:"America/New_York",
  NJ:"America/New_York",   NM:"America/Denver",     NY:"America/New_York",
  NC:"America/New_York",   ND:"America/Chicago",    OH:"America/New_York",
  OK:"America/Chicago",    OR:"America/Los_Angeles",PA:"America/New_York",
  RI:"America/New_York",   SC:"America/New_York",   SD:"America/Chicago",
  TN:"America/Chicago",    TX:"America/Chicago",    UT:"America/Denver",
  VT:"America/New_York",   VA:"America/New_York",   WA:"America/Los_Angeles",
  WV:"America/New_York",   WI:"America/Chicago",    WY:"America/Denver",
  PR:"America/Puerto_Rico",VI:"America/Puerto_Rico",
};

// ZIP3 overrides for states that straddle a time-zone line. Only the
// high-confidence, high-volume ones are encoded — a wrong override is
// worse than the state default, which is already correct for the bulk of
// each state.
// KNOWN GAPS (add here if a return ever comes from one): ND 586 (Dickinson),
// MI Upper Peninsula 498/499, far-west KS 677/679, NV 898 (West Wendover),
// far-west OR 977.
const ZIP3_TZ = {
  "324":"America/Chicago",     "325":"America/Chicago",      // FL panhandle
  "798":"America/Denver",      "799":"America/Denver",       // El Paso TX
  "885":"America/Denver",                                    // Hudspeth TX
  "463":"America/Chicago",     "464":"America/Chicago",      // NW Indiana
  "476":"America/Chicago",     "477":"America/Chicago",      // SW Indiana
  "420":"America/Chicago",     "421":"America/Chicago",      // western KY
  "422":"America/Chicago",     "423":"America/Chicago",
  "424":"America/Chicago",     "425":"America/Chicago",
  "426":"America/Chicago",     "427":"America/Chicago",
  "577":"America/Denver",                                    // western SD
  "691":"America/Denver",      "693":"America/Denver",       // western NE
  "838":"America/Los_Angeles",                               // northern ID
  "979":"America/Denver",                                    // eastern OR
  "865":"America/Denver",                                    // Navajo Nation AZ
};

const DEFAULT_TZ = "America/New_York";   // warehouse zone; prior behaviour

function resolveTimeZone(zip, state) {
  const z3 = String(zip || "").replace(/\D/g, "").slice(0, 3);
  if (ZIP3_TZ[z3]) return { tz: ZIP3_TZ[z3], source: "zip3" };
  const st = String(state || "").trim().toUpperCase().slice(0, 2);
  if (STATE_TZ[st]) return { tz: STATE_TZ[st], source: "state" };
  return { tz: DEFAULT_TZ, source: "default" };
}

// Minutes to add to UTC to get local time in `tz` at instant `dateUtc`.
function tzOffsetMinutes(tz, dateUtc) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const part of dtf.formatToParts(dateUtc)) p[part.type] = part.value;
  const asIfUtc = Date.UTC(
    +p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second
  );
  return Math.round((asIfUtc - dateUtc.getTime()) / 60000);
}

function formatOffset(min) {
  const sign = min < 0 ? "-" : "+";
  const abs  = Math.abs(min);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/;

// "2026-08-07T08:00:00" + tz  ->  "2026-08-07T08:00:00-07:00"
// Local wall time is preserved; only the offset is added.
function stampOffset(naive, tz) {
  if (!naive) return naive;
  const s = String(naive).trim();
  if (HAS_OFFSET.test(s)) return s;                    // already explicit
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return s;                                    // unparseable, leave as-is
  const [, y, mo, d, hh, mi, ss = "00"] = m;
  const wall = `${y}-${mo}-${d}T${hh}:${mi}:${ss}`;
  // Treat the wall time as UTC to get a first guess, then refine once so
  // the offset used is the one actually in effect at that local moment.
  const guess = Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss);
  let off = tzOffsetMinutes(tz, new Date(guess));
  off = tzOffsetMinutes(tz, new Date(guess - off * 60000));
  return `${wall}${formatOffset(off)}`;
}

// Returns { window, tz, tzSource, closeHourLocal }
function normalizePickupWindow(pickup_window, ship_from) {
  if (!pickup_window) return { window: null, tz: null, tzSource: null, closeHourLocal: null };
  const { tz, source } = resolveTimeZone(ship_from?.zip, ship_from?.state);
  const start_at = stampOffset(pickup_window.start_at, tz);
  const end_at   = stampOffset(pickup_window.end_at,   tz);
  const closeMatch = String(end_at || "").match(/[T ](\d{2}):/);
  return {
    window: { ...pickup_window, start_at, end_at },
    tz,
    tzSource: source,
    closeHourLocal: closeMatch ? +closeMatch[1] : null,
  };
}

// ─── Carrier registry ─────────────────────────────────────────────────
// Single source of truth for which carrier_id/service/pickup a return uses.
// key = value sent by the UI in body.carrier (lower-case).
const CARRIERS = {
  ups: {
    label:           "UPS",                 // human label + value stored in return_labels.carrier
    carrier_id:      "se-605521",           // FR-Logistics UPS (account WE6433, negotiated rates ON)
    default_service: "ups_ground",
    pickup:          true,                  // UPS supports label-based pickup
  },
  usps: {
    label:           "USPS",
    carrier_id:      "se-595432",           // ShipStation USPS (Stamps.com) — paid from ShipStation Balance
    default_service: "usps_ground_advantage",
    pickup:          false,                 // USPS = drop-off only (business decision)
  },
};

// Resolve a carrier key safely; default to UPS to preserve prior behaviour
// for any caller that omits `carrier`.
function resolveCarrier(key) {
  const k = String(key || "ups").toLowerCase();
  return CARRIERS[k] || CARRIERS.ups;
}

// Fixed destination: FR-Logistics warehouse (Ship To for all returns)
const WAREHOUSE_SHIP_TO = {
  name:          "FR-Logistics Miami",
  company_name:  "FR-Logistics Miami",
  phone:         "3052403172",
  address_line1: "10893 NW 17th St",
  address_line2: "Unit 121",
  city_locality: "Miami",
  state_province:"FL",
  postal_code:   "33172",
  country_code:  "US",
};

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const jRes = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

// ─── Supabase REST helpers (match existing function pattern) ──────────
async function sbInsert(table, row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`supabase insert failed: ${await r.text()}`);
  return (await r.json())[0];
}

async function sbPatch(table, filter, patch) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`supabase patch failed: ${await r.text()}`);
  return await r.json();
}

// ─── ShipStation V2 fetch helper ──────────────────────────────────────
async function ss(path, method = "GET", body = null) {
  const opts = {
    method,
    headers: { "API-Key": SS_API_KEY, "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${SS_BASE}${path}`, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`ShipStation ${method} ${path} → ${r.status}: ${JSON.stringify(data)}`);
  return data;
}

// ─── Email notification (Resend) ──────────────────────────────────────
const RESEND_KEY  = Netlify.env.get("RESEND_API_KEY");
const FROM_EMAIL  = "FR-Logistics Returns <warehouse@fr-logistics.net>";
const WAREHOUSE_CC = "warehouse@fr-logistics.net";

// Fetch the label PDF bytes and return base64 (for attachment)
async function fetchLabelPdfBase64(pdfUrl) {
  try {
    const r = await fetch(pdfUrl, { headers: { "API-Key": SS_API_KEY } });
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    // base64 encode
    let binary = "";
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  } catch (e) {
    return null;
  }
}

function returnEmailHtml({ carrierLabel, contactName, tracking, pickupConfirm, pickupWindow, service }) {
  const carrierName = carrierLabel || "UPS";
  const pickupBlock = pickupConfirm
    ? `<tr><td style="padding:6px 0;color:#475569">${carrierName} Pickup Confirmation</td>
         <td style="padding:6px 0;font-weight:700;color:#0f172a">${pickupConfirm}</td></tr>
       ${pickupWindow ? `<tr><td style="padding:6px 0;color:#475569">Pickup Window</td>
         <td style="padding:6px 0;color:#0f172a">${pickupWindow.start_at?.slice(0,16).replace("T"," ")} – ${pickupWindow.end_at?.slice(11,16)}</td></tr>` : ""}`
    : `<tr><td style="padding:6px 0;color:#475569">Pickup</td>
         <td style="padding:6px 0;color:#0f172a">Not scheduled — please drop off at any ${carrierName} location.</td></tr>`;
  return `<!doctype html><html><body style="margin:0;font-family:Arial,Helvetica,sans-serif;background:#f6f7fb;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
    <div style="background:#0F1D35;color:#fff;padding:18px 22px">
      <div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#16a3b5;font-weight:700">FR-Logistics Miami</div>
      <div style="font-size:20px;font-weight:800;margin-top:4px">Your Return Shipping Label</div>
    </div>
    <div style="padding:22px">
      <p style="color:#0f172a;font-size:14px;margin:0 0 14px">Hello ${contactName || "there"},</p>
      <p style="color:#475569;font-size:14px;line-height:1.5;margin:0 0 16px">
        Your ${carrierName} return label is attached to this email as a PDF. Print it, attach it to your package, and ${pickupConfirm ? `hand it to the ${carrierName} driver at the scheduled pickup` : `drop it off at any ${carrierName} location`}.
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;border-top:1px solid #e2e8f0">
        <tr><td style="padding:6px 0;color:#475569;width:45%">Tracking Number</td>
            <td style="padding:6px 0;font-weight:700;color:#0f172a">${tracking}</td></tr>
        <tr><td style="padding:6px 0;color:#475569">Service</td>
            <td style="padding:6px 0;color:#0f172a">${service || carrierName}</td></tr>
        ${pickupBlock}
      </table>
      <div style="margin-top:18px;padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;color:#475569">
        The package will be returned to FR-Logistics Miami, 10893 NW 17th St, Unit 121, Miami, FL 33172.
      </div>
      <p style="color:#94a3b8;font-size:12px;margin:18px 0 0">If you have any questions, reply to this email.</p>
    </div>
  </div></body></html>`;
}

// The UI's Email field is free text and operators legitimately type more
// than one address ("a@x.com, b@x.com"). Resend's `to` takes an ARRAY of
// addresses — one raw comma-joined string is a 422 that kills the whole
// send, warehouse copy included. Split, trim, validate, de-duplicate.
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function parseRecipients(raw) {
  const seen = new Set();
  const valid = [];
  const invalid = [];
  for (const piece of String(raw || "").split(/[,;\n]/)) {
    const addr = piece.trim().replace(/^["'<]+|[">']+$/g, "");
    if (!addr) continue;
    if (!EMAIL_RE.test(addr)) { invalid.push(addr); continue; }
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push(addr);
  }
  return { valid, invalid };
}

async function sendReturnEmail({ toEmail, carrierLabel, contactName, tracking, pickupConfirm, pickupWindow, service, pdfBase64 }) {
  if (!RESEND_KEY) return { sent: false, reason: "RESEND_API_KEY missing" };

  const { valid, invalid } = parseRecipients(toEmail);
  const recipients = [...valid];
  if (!recipients.some((a) => a.toLowerCase() === WAREHOUSE_CC.toLowerCase())) {
    recipients.push(WAREHOUSE_CC);          // always copy warehouse
  }

  const payload = {
    from: FROM_EMAIL,
    to: recipients,
    subject: `Return label — ${tracking}${pickupConfirm ? " · Pickup " + pickupConfirm : ""}`,
    html: returnEmailHtml({ carrierLabel, contactName, tracking, pickupConfirm, pickupWindow, service }),
  };
  if (pdfBase64) {
    payload.attachments = [{ filename: `return-label-${tracking}.pdf`, content: pdfBase64 }];
  }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      return { sent: false, reason: `resend ${r.status}: ${await r.text()}`, recipients, invalid };
    }
    return { sent: true, recipients, invalid };
  } catch (e) {
    return { sent: false, reason: e.message, recipients, invalid };
  }
}

// ─── ACTION: create_return — label + pickup + persist ─────────────────
async function actionCreateReturn(body) {
  const {
    client,            // 'MXS Overseas Ltd'
    client_id,         // optional uuid
    carrier,           // 'ups' | 'usps' (defaults to ups)
    ship_from,         // {name, company, line1, city, state, zip, phone, email}
    weight_oz,
    dims,              // {length, width, height}
    service_code,      // e.g. 'ups_ground' / 'usps_ground_advantage'
    pickup_window,     // {start_at, end_at}  ISO 8601
    schedule_pickup,   // boolean
    notes,
  } = body;

  // --- resolve carrier first (drives validation + payload) --------------
  const carrierCfg = resolveCarrier(carrier);
  const isUPS = carrierCfg.carrier_id === CARRIERS.ups.carrier_id;

  // --- validation -------------------------------------------------------
  if (!client)              return jRes({ error: "client required" }, 400);
  if (!ship_from?.line1)    return jRes({ error: "ship_from address required" }, 400);
  // company is a UPS rule; USPS does not require it, but we keep it if provided
  if (isUPS && !ship_from?.company)
    return jRes({ error: "ship_from.company required (UPS rule)" }, 400);
  if (!weight_oz)           return jRes({ error: "weight required" }, 400);

  // --- pickup guard: only UPS may schedule a pickup ---------------------
  // Even if a stale UI sends schedule_pickup:true for USPS, we ignore it.
  const wantsPickup = !!schedule_pickup && carrierCfg.pickup;

  // resolved service: explicit service_code wins, else carrier default
  const resolvedService = service_code || carrierCfg.default_service;

  // --- normalize the pickup window to the PICKUP ADDRESS's time zone ----
  // Without an explicit offset ShipStation reads the timestamp as UTC and
  // the window lands hours earlier in the customer's local clock, which is
  // what UPS rejects as "closing time ... earliest allowable close time".
  const pw = normalizePickupWindow(wantsPickup ? pickup_window : null, ship_from);
  const pickupWindowTz = pw.window;

  // --- 1) seed pending row so nothing is lost on partial failure --------
  const seed = await sbInsert("return_labels", {
    client,
    client_id:     client_id || null,
    status:        "pending_pickup",
    ship_from_json: ship_from,
    weight_oz,
    dims_json:     dims || null,
    carrier:       carrierCfg.label,     // 'UPS' | 'USPS'
    service:       resolvedService,
    pickup_window: pickupWindowTz,     // stamped with the pickup ZIP's offset
    notes:         notes || null,
  });

  // --- 2) create the label (V2 native return flag) ----------------------
  // carrier_id + service resolved from CARRIERS registry.
  const labelPayload = {
    shipment: {
      carrier_id:   carrierCfg.carrier_id,
      service_code: resolvedService,
      ship_from: {
        name:          ship_from.name,
        // company_name only sent if present (USPS may omit it)
        ...(ship_from.company ? { company_name: ship_from.company } : {}),
        phone:         ship_from.phone || "0000000000",
        address_line1: ship_from.line1,
        city_locality: ship_from.city,
        state_province:ship_from.state,
        postal_code:   ship_from.zip,
        country_code:  "US",
      },
      ship_to: WAREHOUSE_SHIP_TO,
      packages: [{
        weight: { value: weight_oz, unit: "ounce" },
        ...(dims ? { dimensions: { ...dims, unit: "inch" } } : {}),
      }],
    },
    is_return_label: true,
  };

  let label;
  try {
    label = await ss("/labels", "POST", labelPayload);
  } catch (e) {
    await sbPatch("return_labels", `id=eq.${seed.id}`, { status: "label_failed", notes: e.message });
    return jRes({ error: "label creation failed", detail: e.message, return_id: seed.id }, 502);
  }

  // store label PDF in Netlify Blobs (pattern from manifests)
  let label_url = label.label_download?.pdf || null;
  // (optional: fetch the PDF bytes and cache in Blobs like manifests do)

  await sbPatch("return_labels", `id=eq.${seed.id}`, {
    status:       "in_transit",
    label_id:     label.label_id,
    tracking:     label.tracking_number,
    carrier_cost: label.shipment_cost?.amount ?? null,
    label_url,
  });

  // --- 3) schedule pickup (label-based) — UPS only ----------------------
  let pickup = null;
  let pickupError = null;
  let pickupHint = null;
  if (wantsPickup && pickupWindowTz) {
    try {
      pickup = await ss("/pickups", "POST", {
        label_ids: [label.label_id],
        pickup_window: pickupWindowTz,
        contact_details: {
          name:  ship_from.name,
          email: ship_from.email || "warehouse@fr-logistics.net",
          phone: ship_from.phone || "0000000000",
        },
        pickup_address: {
          name:          ship_from.name,
          company_name:  ship_from.company,
          phone:         ship_from.phone || "0000000000",
          address_line1: ship_from.line1,
          city_locality: ship_from.city,
          state_province:ship_from.state,
          postal_code:   ship_from.zip,
          country_code:  "US",
        },
      });
      await sbPatch("return_labels", `id=eq.${seed.id}`, {
        pickup_confirm:   pickup.confirmation_number || pickup.pickup_id,
        pickup_scheduled: true,
      });
    } catch (e) {
      // non-fatal: label already created; pickup can be retried
      pickupError = e.message;
      // Extract the human-readable message from ShipStation's error JSON if present
      try {
        const m = e.message.match(/"message":"([^"]+)"/);
        if (m) pickupError = m[1];
      } catch(_) {}
      // UPS enforces an earliest allowable close time that varies by pickup
      // centre; a close time before noon local is almost always refused.
      if (/clos(?:e|ing)\s*time/i.test(pickupError || "")) {
        pickupHint = pw.closeHourLocal !== null && pw.closeHourLocal < 12
          ? `The window closes at ${String(pw.closeHourLocal).padStart(2,"0")}:00 local time at the pickup address (${pw.tz}). UPS rarely accepts a close time before 12:00 PM — try ending the window at 5:00 PM or later.`
          : `UPS refused the close time for this pickup centre (${pw.tz}). Try a later close time, or schedule the pickup directly on UPS.com with tracking ${label.tracking_number}.`;
      }
      await sbPatch("return_labels", `id=eq.${seed.id}`, {
        notes: `${notes || ""} | pickup_failed: ${e.message}`,
      });
    }
  }

  // --- 4) email notification (client final + warehouse copy, PDF attached) ---
  let emailResult = { sent: false, reason: "not attempted" };
  try {
    const pickupConfirm = pickup ? (pickup.confirmation_number || pickup.pickup_id) : null;
    const pdfBase64 = label_url ? await fetchLabelPdfBase64(label_url) : null;
    emailResult = await sendReturnEmail({
      toEmail:      ship_from.email || null,
      carrierLabel: carrierCfg.label,
      contactName:  ship_from.name || ship_from.company,
      tracking:     label.tracking_number,
      pickupConfirm,
      pickupWindow: pickupWindowTz,
      service:      resolvedService,
      pdfBase64,
    });
  } catch (e) {
    emailResult = { sent: false, reason: e.message };
  }

  return jRes({
    ok:             true,
    return_id:      seed.id,
    carrier:        carrierCfg.label,
    tracking:       label.tracking_number,
    carrier_cost:   label.shipment_cost?.amount ?? null,
    label_url,
    pickup_confirm: pickup?.confirmation_number || pickup?.pickup_id || null,
    pickup_error:   pickupError,   // null if no pickup requested or it succeeded
    pickup_hint:    pickupHint,    // actionable next step when UPS refuses
    pickup_tz:      pw.tz,         // zone used to stamp the window
    pickup_window:  pickupWindowTz,
    email_sent:     emailResult.sent,
    email_error:    emailResult.sent ? null : emailResult.reason,
    email_to:       emailResult.recipients || [],
    email_invalid:  emailResult.invalid || [],   // addresses skipped as malformed
  });
}

// ─── ACTION: carriers — connection test + discover UPS carrier_id ─────
// Call this FIRST (GET ?action=carriers) to confirm UPS is connected and
// to grab the carrier_id (se-xxxxx) you'll need for label/service codes.
async function actionCarriers() {
  const data = await ss("/carriers", "GET");
  const list = (data.carriers || []).map((c) => ({
    carrier_id:        c.carrier_id,
    friendly_name:     c.friendly_name,
    carrier_code:      c.carrier_code,
    primary:           c.primary,
    has_funded_account:c.has_multi_package_supporting_services ?? null,
    services:          (c.services || []).map((s) => ({ code: s.service_code, name: s.name })),
  }));
  const ups = list.find((c) => /ups/i.test(c.carrier_code || c.friendly_name || ""));
  return jRes({
    ok: true,
    ups_connected: !!ups,
    ups,                       // null if UPS not connected → must connect in ShipStation
    all_carriers: list,
  });
}

// ─── ACTION: list — open returns (for the UI dashboard) ───────────────
async function actionList(url) {
  const status = url.searchParams.get("status") || "";
  const filter = status ? `&status=eq.${encodeURIComponent(status)}` : "";
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/return_labels?select=*${filter}&order=created_at.desc`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  return jRes(await r.json());
}

// ─── Handler ──────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (!SS_API_KEY)                       return jRes({ error: "SS_V2_API_KEY missing" }, 500);
  if (!SUPABASE_URL || !SUPABASE_KEY)    return jRes({ error: "SUPABASE env vars missing" }, 500);

  try {
    if (req.method === "GET") {
      const url = new URL(req.url);
      const action = url.searchParams.get("action") || "";
      if (action === "carriers") return await actionCarriers();
      if (action === "list")     return await actionList(url);
      return jRes({ error: `unknown GET action: ${action || "(none)"}` }, 400);
    }
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if ((body.action || "") === "create_return") return await actionCreateReturn(body);
      return jRes({ error: `unknown POST action: ${body.action || "(none)"}` }, 400);
    }
    return jRes({ error: `method not allowed: ${req.method}` }, 405);
  } catch (e) {
    console.error("[shipstation-return]", e);
    return jRes({ error: e.message || "internal error" }, 500);
  }
}
