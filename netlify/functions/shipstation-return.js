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
//
// ════════════════════════════════════════════════════════════════════
// CLIENT PICKUP REQUESTS + PICKUP RETRY — 2026-11-24
//
// (C) PAST PICKUP WINDOWS NO LONGER BUY A LABEL
//     23-nov-2026, RMA-24641118: a label was created at 5:47 PM ET with a
//     9:00-17:00 window for the same day. UPS refused the pickup ("start_at
//     must not be in the past"), and the only way to retry was to create a
//     SECOND label 26 s later — two labels, one return. The window is now
//     checked BEFORE the label is bought: a start time that already passed
//     is moved to the next quarter hour; a window that closes in less than
//     2 h (or is on a weekend / UPS holiday) is refused with 409 and the
//     next business day is suggested.
//
// (D) RETRY ONLY THE PICKUP     POST { action:'retry_pickup', return_id,
//                                      pickup_date, window_start, window_end }
//     Re-books the pickup for an existing label (same label_id). Never
//     creates a new label.
//
// (E) VOID A LABEL              POST { action:'void_label', return_id, reason }
//     Cancels its pickup when there is one (pickup_id is stored now) and
//     voids the label in ShipStation. Status becomes 'voided', which
//     billing-returns.js excludes. Refused once the label is billed.
//
// (F) ADDRESS LINE 2            ship_from.line2 is sent to the label and
//     the pickup (apartment / suite). Placeholders like "N/A" are dropped.
//
// (G) CLIENT PICKUP REQUESTS    (table pickup_requests, filled by
//     portal-pickup-requests.js from the Client Portal → Returns tab)
//     · create_return accepts `pickup_request_id`: the label is linked to
//       the request and the client is emailed with the label attached.
//     · The same core (createReturnLabel) is exported and used by the
//       portal function for clients with return_pickup_mode = 'auto'.
//     · GET  ?action=requests          → staff queue (open + arrived)
//     · POST { action:'request_cancel', id, reason }
//     · POST { action:'request_outcome', id, outcome, note }
//
// Identity: the edge gate (auth-gate.js) lets only STAFF sessions reach
// this function and sets x-fr-user-email, used as the actor.
// No new environment variables (the site is at the 4 KB Lambda limit).
// ════════════════════════════════════════════════════════════════════

const SS_BASE      = "https://api.shipstation.com/v2";
// NOTE: distinct env var from the V1 KPI dashboard function (which uses
// SS_API_KEY + SS_API_SECRET). V2 uses a single API-Key header.
const SS_API_KEY   = Netlify.env.get("SS_V2_API_KEY");
const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY");

const APPS_URL   = "https://apps.fr-logistics.net/Inbound_Outbound.html";
const PORTAL_URL = "https://fr-logistics.net/app/";
const STAFF_TO   = "warehouse@fr-logistics.net";
const STAFF_CC   = ["josefuentes@fr-logistics.net"];

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
const ET_TZ      = "America/New_York";

export function resolveTimeZone(zip, state) {
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

// ─── Calendar helpers (business days + UPS holidays) ──────────────────
// All dates are "YYYY-MM-DD" strings of a wall calendar; arithmetic runs on
// UTC midnights so no host time zone can shift a day.
const pad2 = (n) => String(n).padStart(2, "0");

function ymdParts(ymd) {
  const [y, m, d] = String(ymd).split("-").map(Number);
  return { y, m, d };
}
function ymdFromUtcMs(ms) { return new Date(ms).toISOString().slice(0, 10); }
export function addDaysYmd(ymd, n) {
  const { y, m, d } = ymdParts(ymd);
  return ymdFromUtcMs(Date.UTC(y, m - 1, d + n));
}
function weekdayOf(ymd) {
  const { y, m, d } = ymdParts(ymd);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();   // 0 Sun … 6 Sat
}
function nthWeekday(y, month0, wd, n) {                 // n-th <wd> of a month
  const first = new Date(Date.UTC(y, month0, 1)).getUTCDay();
  return ymdFromUtcMs(Date.UTC(y, month0, 1 + ((wd - first + 7) % 7) + (n - 1) * 7));
}
function lastWeekday(y, month0, wd) {
  const lastDay = new Date(Date.UTC(y, month0 + 1, 0));
  const back = (lastDay.getUTCDay() - wd + 7) % 7;
  return ymdFromUtcMs(Date.UTC(y, month0, lastDay.getUTCDate() - back));
}
// UPS does no pickups on these six days. A fixed-date holiday that falls on
// a Sunday is observed on Monday. (Saturdays are never offered anyway.)
const HOLIDAY_CACHE = new Map();
export function upsHolidays(y) {
  if (HOLIDAY_CACHE.has(y)) return HOLIDAY_CACHE.get(y);
  const fixed = (m, d) => {
    const ymd = `${y}-${pad2(m)}-${pad2(d)}`;
    return weekdayOf(ymd) === 0 ? addDaysYmd(ymd, 1) : ymd;
  };
  const set = new Set([
    fixed(1, 1),                 // New Year's Day
    lastWeekday(y, 4, 1),        // Memorial Day (last Monday of May)
    fixed(7, 4),                 // Independence Day
    nthWeekday(y, 8, 1, 1),      // Labor Day (1st Monday of September)
    nthWeekday(y, 10, 4, 4),     // Thanksgiving (4th Thursday of November)
    fixed(12, 25),               // Christmas Day
  ]);
  HOLIDAY_CACHE.set(y, set);
  return set;
}
export function isBusinessDay(ymd) {
  const wd = weekdayOf(ymd);
  if (wd === 0 || wd === 6) return false;
  return !upsHolidays(ymdParts(ymd).y).has(ymd);
}
export function nextBusinessDay(ymd) {
  let d = addDaysYmd(ymd, 1);
  while (!isBusinessDay(d)) d = addDaysYmd(d, 1);
  return d;
}
// Wall clock "now" in a zone → { date:'YYYY-MM-DD', hh, mm }
export function wallNow(tz, now = new Date()) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const p = {};
  for (const part of dtf.formatToParts(now)) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hh: (+p.hour) % 24, mm: +p.minute };
}
// Wall date + "HH:MM" → minutes on one shared scale (comparisons only).
function wallMinutes(ymd, hhmm) {
  const { y, m, d } = ymdParts(ymd);
  const [hh, mi] = String(hhmm).split(":").map(Number);
  return Date.UTC(y, m - 1, d, hh, mi) / 60000;
}
function hhmmOf(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}
export const fmtWindowDate = (ymd) => {
  const { y, m, d } = ymdParts(ymd);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
};
export const fmtClock = (hhmm) => {
  const [h, mi] = String(hhmm || "").split(":").map(Number);
  if (!Number.isFinite(h)) return "";
  const ap = h >= 12 ? "PM" : "AM";
  return `${((h + 11) % 12) + 1}:${pad2(mi || 0)} ${ap}`;
};

const MIN_WINDOW_MIN = 120;   // UPS needs a usable ready → close span

// Checks a NAIVE local window ("YYYY-MM-DDTHH:MM[:SS]") against the pickup
// address's clock BEFORE a label is bought.
//   → { ok:true, window:{start_at,end_at}, adjusted:boolean, tz }
//   → { ok:false, error, message, suggest_date, tz }
export function guardPickupWindow(pickup_window, ship_from, now = new Date()) {
  const { tz } = resolveTimeZone(ship_from?.zip, ship_from?.state);
  const RX = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/;
  const s = String(pickup_window?.start_at || "").trim().match(RX);
  const e = String(pickup_window?.end_at   || "").trim().match(RX);
  const today = wallNow(tz, now);
  const suggest = nextBusinessDay(today.date);
  if (!s || !e || s[1] !== e[1]) {
    return { ok: false, error: "pickup_window_invalid", tz, suggest_date: suggest,
      message: "The pickup window is missing or invalid (it must start and end on the same day)." };
  }
  const date = s[1];
  if (!isBusinessDay(date)) {
    return { ok: false, error: "pickup_day_closed", tz, suggest_date: nextBusinessDay(addDaysYmd(date, -1)),
      message: `UPS does not do pickups on ${fmtWindowDate(date)} (weekend or UPS holiday). Choose ${fmtWindowDate(nextBusinessDay(addDaysYmd(date, -1)))} or later.` };
  }
  const nowMin = wallMinutes(today.date, `${pad2(today.hh)}:${pad2(today.mm)}`);
  let startMin = wallMinutes(date, s[2]);
  const endMin = wallMinutes(date, e[2]);
  if (endMin - startMin < MIN_WINDOW_MIN) {
    return { ok: false, error: "pickup_window_invalid", tz, suggest_date: suggest,
      message: "The pickup window must be at least 2 hours long." };
  }
  const tooLate = () => ({
    ok: false, error: "pickup_window_past", tz, suggest_date: suggest,
    message: `The pickup window ${fmtClock(s[2])}–${fmtClock(e[2])} on ${fmtWindowDate(date)} has already passed (or closes in less than 2 hours) at the pickup address (${tz}). Choose ${fmtWindowDate(suggest)} or later.`,
  });
  if (endMin - nowMin < MIN_WINDOW_MIN) return tooLate();
  let adjusted = false;
  if (startMin < nowMin + 15) {
    // Start already passed: move it to the next quarter hour, keep the close.
    startMin = Math.ceil((nowMin + 15) / 15) * 15;
    adjusted = true;
    if (endMin - startMin < MIN_WINDOW_MIN) return tooLate();
  }
  return {
    ok: true, tz, adjusted,
    window: { start_at: `${date}T${hhmmOf(startMin)}:00`, end_at: `${date}T${e[2]}:00` },
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

// Address Line 2 placeholders that carriers read as a real (wrong) unit.
// Same list as the Delivery Guard.
const LINE2_PLACEHOLDER_RE = /^\s*(n\/?a|none|null|house|home|no|nil|-+|\.+|0|#)\s*$/i;
export function cleanLine2(v) {
  const s = String(v == null ? "" : v).trim();
  return LINE2_PLACEHOLDER_RE.test(s) ? "" : s;
}

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

export async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!r.ok) throw new Error(`supabase ${path.split("?")[0]} ${r.status}: ${(await r.text()).slice(0, 240)}`);
  return r.json();
}

// return_labels.pickup_id arrives with the 24-nov-2026 migration. If this
// file is deployed before it, the write is retried without that column so a
// label that was already bought is never left half-recorded.
async function patchReturnLabel(id, patch) {
  try {
    return await sbPatch("return_labels", `id=eq.${id}`, patch);
  } catch (e) {
    if ("pickup_id" in patch && /pickup_id/.test(e.message)) {
      const { pickup_id, ...rest } = patch;
      console.warn("[shipstation-return] return_labels.pickup_id missing — run the pickup_requests_portal migration");
      return await sbPatch("return_labels", `id=eq.${id}`, rest);
    }
    throw e;
  }
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

// Human-readable message out of a ShipStation error string.
function ssMessage(msg) {
  const m = String(msg || "").match(/"message":"([^"]+)"/);
  return m ? m[1] : String(msg || "");
}

// ─── Email notification (Resend) ──────────────────────────────────────
const RESEND_KEY  = Netlify.env.get("RESEND_API_KEY");
const FROM_EMAIL  = "FR-Logistics Returns <warehouse@fr-logistics.net>";
const WAREHOUSE_CC = "warehouse@fr-logistics.net";

export function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Fetch the label PDF bytes and return base64 (for attachment)
export async function fetchLabelPdfBase64(pdfUrl) {
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
  const carrierName = esc(carrierLabel || "UPS");
  const pickupBlock = pickupConfirm
    ? `<tr><td style="padding:6px 0;color:#475569">${carrierName} Pickup Confirmation</td>
         <td style="padding:6px 0;font-weight:700;color:#0f172a">${esc(pickupConfirm)}</td></tr>
       ${pickupWindow ? `<tr><td style="padding:6px 0;color:#475569">Pickup Window</td>
         <td style="padding:6px 0;color:#0f172a">${esc(pickupWindow.start_at?.slice(0,16).replace("T"," "))} – ${esc(pickupWindow.end_at?.slice(11,16))}</td></tr>` : ""}`
    : `<tr><td style="padding:6px 0;color:#475569">Pickup</td>
         <td style="padding:6px 0;color:#0f172a">Not scheduled — please drop off at any ${carrierName} location.</td></tr>`;
  return `<!doctype html><html><body style="margin:0;font-family:Arial,Helvetica,sans-serif;background:#f6f7fb;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
    <div style="background:#0F1D35;color:#fff;padding:18px 22px">
      <div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#16a3b5;font-weight:700">FR-Logistics Miami</div>
      <div style="font-size:20px;font-weight:800;margin-top:4px">Your Return Shipping Label</div>
    </div>
    <div style="padding:22px">
      <p style="color:#0f172a;font-size:14px;margin:0 0 14px">Hello ${esc(contactName || "there")},</p>
      <p style="color:#475569;font-size:14px;line-height:1.5;margin:0 0 16px">
        Your ${carrierName} return label is attached to this email as a PDF. Print it, attach it to your package, and ${pickupConfirm ? `hand it to the ${carrierName} driver at the scheduled pickup` : `drop it off at any ${carrierName} location`}.
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;border-top:1px solid #e2e8f0">
        <tr><td style="padding:6px 0;color:#475569;width:45%">Tracking Number</td>
            <td style="padding:6px 0;font-weight:700;color:#0f172a">${esc(tracking)}</td></tr>
        <tr><td style="padding:6px 0;color:#475569">Service</td>
            <td style="padding:6px 0;color:#0f172a">${esc(service || carrierLabel || "UPS")}</td></tr>
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

export function parseRecipients(raw) {
  const seen = new Set();
  const valid = [];
  const invalid = [];
  const pieces = Array.isArray(raw) ? raw : String(raw || "").split(/[,;\n]/);
  for (const piece of pieces) {
    const addr = String(piece || "").trim().replace(/^["'<]+|[">']+$/g, "");
    if (!addr) continue;
    if (!EMAIL_RE.test(addr)) { invalid.push(addr); continue; }
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push(addr);
  }
  return { valid, invalid };
}

async function sendReturnEmail({ toEmail, carrierLabel, contactName, tracking, pickupConfirm, pickupWindow, service, pdfBase64, copyWarehouse = true }) {
  if (!RESEND_KEY) return { sent: false, reason: "RESEND_API_KEY missing" };

  const { valid, invalid } = parseRecipients(toEmail);
  const recipients = [...valid];
  if (copyWarehouse && !recipients.some((a) => a.toLowerCase() === WAREHOUSE_CC.toLowerCase())) {
    recipients.push(WAREHOUSE_CC);          // always copy warehouse
  }
  if (!recipients.length) return { sent: false, reason: "no recipients", recipients, invalid };

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

// Generic sender for the request notifications (client + staff).
export async function sendMail({ to, cc, bcc, subject, html, attachments }) {
  if (!RESEND_KEY) return { sent: false, reason: "RESEND_API_KEY missing" };
  const toList = parseRecipients(to).valid;
  if (!toList.length) return { sent: false, reason: "no recipients" };
  const payload = { from: FROM_EMAIL, to: toList, reply_to: WAREHOUSE_CC, subject, html };
  const ccList = parseRecipients(cc).valid.filter((a) => !toList.some((t) => t.toLowerCase() === a.toLowerCase()));
  const bccList = parseRecipients(bcc).valid.filter((a) =>
    ![...toList, ...ccList].some((t) => t.toLowerCase() === a.toLowerCase()));
  if (ccList.length) payload.cc = ccList;
  if (bccList.length) payload.bcc = bccList;
  if (attachments && attachments.length) payload.attachments = attachments;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) return { sent: false, reason: `resend ${r.status}: ${(await r.text()).slice(0, 200)}` };
    return { sent: true, to: toList };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

// ─── Client pickup requests: shared texts + notifications ─────────────
export const DISPOSITION_TEXT = {
  restock:       "Restock if sealed and saleable (if not, we photograph it and ask you)",
  inspect_hold:  "Inspect, photograph and hold for my instructions",
  fulfill_order: "Use it to fulfill an order",
  other:         "Other — see instructions",
};
export const OUTCOME_TEXT = {
  restocked:      "Restocked — saleable inventory",
  used_for_order: "Used to fulfill an order",
  held:           "Held — waiting for your instructions",
  damaged:        "Damaged — not saleable",
  other:          "Other",
};
export function dispositionLine(r) {
  const base = DISPOSITION_TEXT[r.disposition] || r.disposition || "";
  if (r.disposition === "fulfill_order" && r.disposition_order_ref) return `${base}: ${r.disposition_order_ref}`;
  return base;
}
// Short text that goes into return_labels.notes (visible to the warehouse).
export function requestNotes(r) {
  const parts = [r.reference];
  if (r.order_ref) parts.push(`Order ${r.order_ref}`);
  parts.push(r.request_code);
  const disp = { restock: "On arrival: restock if sealed", inspect_hold: "On arrival: inspect + hold",
    fulfill_order: `On arrival: fulfill ${r.disposition_order_ref || ""}`.trim(), other: "On arrival: see request" }[r.disposition];
  if (disp) parts.push(disp);
  return parts.filter(Boolean).join(" · ").slice(0, 300);
}
export const upsTrackUrl = (t) => `https://www.ups.com/track?tracknum=${encodeURIComponent(t || "")}`;

function mailShell(title, inner) {
  return `<!doctype html><html><body style="margin:0;font-family:Arial,Helvetica,sans-serif;background:#f6f7fb;padding:24px">
  <div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
    <div style="background:#0F1D35;color:#fff;padding:18px 22px">
      <div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#16a3b5;font-weight:700">FR-Logistics Miami · Returns</div>
      <div style="font-size:20px;font-weight:800;margin-top:4px">${esc(title)}</div>
    </div>
    <div style="padding:22px;color:#0f172a;font-size:14px;line-height:1.55">${inner}</div>
    <div style="background:#f8fafc;padding:12px 22px;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0">
      FR Logistics Miami Inc, d/b/a FR-Logistics · 10893 NW 17th Street, Unit 121, Miami, FL 33172 · warehouse@fr-logistics.net
    </div>
  </div></body></html>`;
}

function rowsTable(rows) {
  return `<table style="width:100%;border-collapse:collapse;font-size:13px;margin:12px 0;border-top:1px solid #e2e8f0">${
    rows.filter(Boolean).map(([k, v], i) =>
      `<tr style="background:${i % 2 ? "#f8fafc" : "#fff"}"><td style="padding:7px 10px;border-bottom:1px solid #e2e8f0;width:38%;color:#475569">${esc(k)}</td><td style="padding:7px 10px;border-bottom:1px solid #e2e8f0">${v}</td></tr>`
    ).join("")}</table>`;
}

function requestRows(r, extra = []) {
  const sf = r.ship_from || {};
  const cityLine = [sf.city, sf.state, sf.zip].filter(Boolean).join(", ");
  const items = Array.isArray(r.items) ? r.items : [];
  const itemsHtml = items.map((it) =>
    `${esc(it.qty || 1)} × ${esc([it.sku, it.description].filter(Boolean).join(" — "))}`).join("<br>");
  const when = r.method === "dropoff"
    ? "Drop-off — the customer takes the box to any UPS location"
    : (r.pickup_date ? `${esc(fmtWindowDate(r.pickup_date))}, ${esc(fmtClock(String(r.window_start).slice(0, 5)))} – ${esc(fmtClock(String(r.window_end).slice(0, 5)))} (customer's local time)` : "");
  return [
    ["Request", `<b>${esc(r.request_code)}</b>`],
    ["Reference", esc(r.reference)],
    r.order_ref ? ["Original order", esc(r.order_ref)] : null,
    ["Customer", `${esc(sf.name)}<br>${esc(sf.line1)}${sf.line2 ? ", " + esc(sf.line2) : ""}<br>${esc(cityLine)}`],
    itemsHtml ? ["Items", itemsHtml] : null,
    [r.method === "dropoff" ? "Method" : "Pickup", when],
    ...extra,
    ["On arrival", esc(dispositionLine(r))],
    r.disposition_notes ? ["Instructions", esc(r.disposition_notes)] : null,
  ];
}

// Who hears about a request: the person who filed it (or the client's main
// email when FR filed it from the internal view) + the extra addresses.
export function clientRecipientsFor(r, clientEmail) {
  const base = r.submitted_via === "internal" ? (clientEmail || "") : (r.submitted_by || "");
  return parseRecipients([base, ...(Array.isArray(r.notify_emails) ? r.notify_emails : [])]).valid;
}

async function clientEmailFor(clientId) {
  try {
    const rows = await sbGet(`fr_clients?id=eq.${encodeURIComponent(clientId)}&select=email,company,name&limit=1`);
    return rows && rows[0] ? rows[0] : null;
  } catch { return null; }
}

export async function notifyClientScheduled(r, { pdfBase64, customerEmailed } = {}) {
  const client = await clientEmailFor(r.client_id);
  const to = clientRecipientsFor(r, client && client.email);
  if (!to.length) return { sent: false, reason: "no client recipients" };
  const isDrop = r.method === "dropoff";
  const title = isDrop ? "Return label ready" : "Return pickup scheduled";
  const extra = [
    !isDrop && r.pickup_confirm ? ["UPS pickup confirmation", `<b>${esc(r.pickup_confirm)}</b>`] : null,
    r.tracking ? ["Tracking", `<a href="${upsTrackUrl(r.tracking)}" style="color:#0f766e">${esc(r.tracking)}</a>`] : null,
  ];
  const custNote = customerEmailed
    ? `We also emailed the label to the customer at <b>${esc((r.ship_from || {}).email)}</b>.`
    : "Please forward the attached label to your customer: it must be printed and taped to the box before the driver arrives.";
  const inner = `<p>Hello ${esc((client && (client.company || client.name)) || r.client)},</p>
    <p>${isDrop ? "Your return label is ready." : "Your return pickup request is confirmed with UPS."} The label is attached as a PDF.</p>
    ${rowsTable(requestRows(r, extra))}
    <p>${custNote}</p>
    <p>You can follow this return in the <a href="${PORTAL_URL}" style="color:#0f766e;font-weight:700">Client Portal</a> → <b>Returns</b>. When it arrives we update it there and email you the result.</p>`;
  return sendMail({
    to, bcc: [STAFF_TO], subject: `${title} — ${r.reference} · ${r.request_code}`,
    html: mailShell(title, inner),
    attachments: pdfBase64 ? [{ filename: `return-label-${r.tracking || r.request_code}.pdf`, content: pdfBase64 }] : null,
  });
}

export async function notifyClientReceived(r, reasonsForClient = []) {
  const client = await clientEmailFor(r.client_id);
  const to = clientRecipientsFor(r, client && client.email);
  if (!to.length) return { sent: false, reason: "no client recipients" };
  const reasons = reasonsForClient.length
    ? `<ul style="margin:6px 0 12px 18px;padding:0">${reasonsForClient.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : "";
  const inner = `<p>Hello ${esc((client && (client.company || client.name)) || r.client)},</p>
    <p>We received your return pickup request. Our team is reviewing it and will confirm the pickup within 1 business day.</p>
    ${reasons}${rowsTable(requestRows(r))}
    <p>You can follow it in the <a href="${PORTAL_URL}" style="color:#0f766e;font-weight:700">Client Portal</a> → <b>Returns</b>.</p>`;
  return sendMail({ to, bcc: [STAFF_TO], subject: `Return request received — ${r.reference} · ${r.request_code}`, html: mailShell("Return request received", inner) });
}

export async function notifyClientCancelled(r) {
  const client = await clientEmailFor(r.client_id);
  const to = clientRecipientsFor(r, client && client.email);
  if (!to.length) return { sent: false, reason: "no client recipients" };
  const inner = `<p>Hello ${esc((client && (client.company || client.name)) || r.client)},</p>
    <p>Return request <b>${esc(r.request_code)}</b> was cancelled${r.cancel_reason ? `: ${esc(r.cancel_reason)}` : "."}</p>
    ${rowsTable(requestRows(r))}
    <p>If this return is still needed, submit a new request in the <a href="${PORTAL_URL}" style="color:#0f766e;font-weight:700">Client Portal</a> → <b>Returns</b>, or reply to this email.</p>`;
  return sendMail({ to, bcc: [STAFF_TO], subject: `Return request cancelled — ${r.reference} · ${r.request_code}`, html: mailShell("Return request cancelled", inner) });
}

export async function notifyClientOutcome(r, receivedAt) {
  const client = await clientEmailFor(r.client_id);
  const to = clientRecipientsFor(r, client && client.email);
  if (!to.length) return { sent: false, reason: "no client recipients" };
  const when = receivedAt ? new Date(receivedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: ET_TZ }) : "";
  const extra = [
    ["Received", esc(when || "—")],
    ["Result", `<b>${esc(OUTCOME_TEXT[r.outcome] || r.outcome)}</b>`],
    r.outcome_note ? ["Note", esc(r.outcome_note)] : null,
  ];
  const inner = `<p>Hello ${esc((client && (client.company || client.name)) || r.client)},</p>
    <p>Your return arrived at our warehouse and was processed.</p>
    ${rowsTable(requestRows(r, extra))}
    <p>Details stay available in the <a href="${PORTAL_URL}" style="color:#0f766e;font-weight:700">Client Portal</a> → <b>Returns</b>.</p>`;
  return sendMail({ to, bcc: [STAFF_TO], subject: `Return processed — ${r.reference} · ${r.request_code}`, html: mailShell("Return processed", inner) });
}

export async function notifyStaff(r, headline, detailLines = []) {
  const lines = detailLines.filter(Boolean).map((m) => `<li>${esc(m)}</li>`).join("");
  const inner = `<p><b>${esc(headline)}</b></p>
    ${lines ? `<ul style="margin:6px 0 12px 18px;padding:0">${lines}</ul>` : ""}
    <p>Client: <b>${esc(r.client)}</b> · filed by ${esc(r.submitted_by)}${r.submitted_via === "internal" ? " (internal view)" : ""}</p>
    ${rowsTable(requestRows(r, [
      r.tracking ? ["Tracking", esc(r.tracking)] : null,
      ["Package", `${esc(r.weight_lb)} lb · ${esc(r.length_in)} × ${esc(r.width_in)} × ${esc(r.height_in)} in`],
    ]))}
    <p>Open <a href="${APPS_URL}" style="color:#0f766e;font-weight:700">Inbound / Outbound</a> → <b>Create Return Label</b> → <b>Client requests</b>.</p>`;
  return sendMail({ to: [STAFF_TO], cc: STAFF_CC, subject: `[Returns] ${r.request_code} — ${headline} — ${r.client}`, html: mailShell(headline, inner) });
}

async function getRequest(id) {
  const rows = await sbGet(`pickup_requests?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  return rows && rows[0] ? rows[0] : null;
}
async function patchRequest(id, patch) {
  const rows = await sbPatch("pickup_requests", `id=eq.${encodeURIComponent(id)}`, patch);
  return rows && rows[0] ? rows[0] : null;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── CORE: create_return — label + pickup + persist ───────────────────
// Returns { status, body } so both this endpoint and portal-pickup-requests
// can use it. `ctx.actor` = who is doing it (staff email or 'portal:<email>').
export async function createReturnLabel(body, ctx = {}) {
  const {
    client,            // 'MXS Overseas Ltd'
    client_id,         // optional uuid
    carrier,           // 'ups' | 'usps' (defaults to ups)
    ship_from: rawShipFrom, // {name, company, line1, line2, city, state, zip, phone, email}
    weight_oz,
    dims,              // {length, width, height}
    service_code,      // e.g. 'ups_ground' / 'usps_ground_advantage'
    pickup_window,     // {start_at, end_at}  ISO 8601 (naive local wall time)
    schedule_pickup,   // boolean
    notes,
    pickup_request_id, // optional: links the label to a client request
  } = body;
  const actor = ctx.actor || null;
  const ship_from = { ...(rawShipFrom || {}) };
  if ("line2" in ship_from) ship_from.line2 = cleanLine2(ship_from.line2);

  // --- resolve carrier first (drives validation + payload) --------------
  const carrierCfg = resolveCarrier(carrier);
  const isUPS = carrierCfg.carrier_id === CARRIERS.ups.carrier_id;

  // --- validation -------------------------------------------------------
  if (!client)              return { status: 400, body: { error: "client required" } };
  if (!ship_from?.line1)    return { status: 400, body: { error: "ship_from address required" } };
  // company is a UPS rule; USPS does not require it, but we keep it if provided
  if (isUPS && !ship_from?.company)
    return { status: 400, body: { error: "ship_from.company required (UPS rule)" } };
  if (!weight_oz)           return { status: 400, body: { error: "weight required" } };

  // --- dims / weight sanity guard (2026-11-05) ---------------------------
  // A return label created with 60x31x14 instead of 25x17x8 cost $519.44
  // (RMA_4BLANC_101926_01). Oversize/dim-weight mistakes are caught here and
  // must be explicitly confirmed by the operator (confirm_oversize: true).
  if (dims) {
    const flags = dimsFlags(dims, weight_oz / 16);
    if (flags.length && !body.confirm_oversize) {
      const L = +dims.length || 0, W = +dims.width || 0, H = +dims.height || 0;
      return { status: 409, body: {
        error: "dims_check",
        message: `Check the dimensions ${L}x${W}x${H} in / ${weight_oz} oz before buying the label: ${flags.join("; ")}. If they are correct, send it again with confirm_oversize: true.`,
        flags, dims: { length: L, width: W, height: H }, weight_oz,
        dim_weight_lb: Math.round(((L * W * H) / 139) * 10) / 10,
      } };
    }
  }

  // --- linked client request (optional) ---------------------------------
  let request = null;
  if (pickup_request_id) {
    if (!UUID_RE.test(String(pickup_request_id))) return { status: 400, body: { error: "invalid pickup_request_id" } };
    request = await getRequest(pickup_request_id);
    if (!request) return { status: 404, body: { error: "pickup request not found" } };
    if (request.status === "cancelled") return { status: 409, body: { error: "request_cancelled", message: `${request.request_code} was cancelled.` } };
    if (request.return_label_id) {
      // A request stuck in 'processing' may point at a seed row whose label
      // never got bought — that one can be replaced. A real label cannot.
      const prev = await sbGet(`return_labels?id=eq.${request.return_label_id}&select=id,label_id,status&limit=1`);
      const p = prev && prev[0];
      if (p && p.label_id && !["label_failed", "voided"].includes(p.status)) {
        return { status: 409, body: { error: "request_has_label", message: `${request.request_code} already has a label. Use Retry pickup or void that label first.` } };
      }
    }
  }

  // --- pickup guard: only UPS may schedule a pickup ---------------------
  // Even if a stale UI sends schedule_pickup:true for USPS, we ignore it.
  const wantsPickup = !!schedule_pickup && carrierCfg.pickup;

  // resolved service: explicit service_code wins, else carrier default
  const resolvedService = service_code || carrierCfg.default_service;

  // --- (C) check the window BEFORE buying the label ----------------------
  let windowToUse = pickup_window || null;
  let windowAdjusted = false;
  if (wantsPickup) {
    if (!pickup_window || !pickup_window.start_at || !pickup_window.end_at) {
      return { status: 400, body: { error: "pickup_window required when scheduling a pickup" } };
    }
    const naive = !HAS_OFFSET.test(String(pickup_window.start_at).trim()) && !HAS_OFFSET.test(String(pickup_window.end_at).trim());
    if (naive) {
      const g = guardPickupWindow(pickup_window, ship_from, ctx.now || new Date());
      if (!g.ok) return { status: 409, body: { error: g.error, message: g.message, suggest_date: g.suggest_date, pickup_tz: g.tz } };
      windowToUse = g.window;
      windowAdjusted = g.adjusted;
    }
  }

  // --- normalize the pickup window to the PICKUP ADDRESS's time zone ----
  // Without an explicit offset ShipStation reads the timestamp as UTC and
  // the window lands hours earlier in the customer's local clock, which is
  // what UPS rejects as "closing time ... earliest allowable close time".
  const pw = normalizePickupWindow(wantsPickup ? windowToUse : null, ship_from);
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

  // Link early: if this run dies half-way the request already points at it.
  if (request) {
    try {
      request = (await patchRequest(request.id, {
        return_label_id: seed.id, status: "processing", handled_by: actor || request.handled_by || null,
      })) || request;
    } catch (e) { console.warn("[shipstation-return] link request failed:", e.message); }
  }

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
        ...(ship_from.line2 ? { address_line2: ship_from.line2 } : {}),
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
    if (request) {
      const reasons = Array.isArray(request.review_reasons) ? request.review_reasons : [];
      try {
        request = (await patchRequest(request.id, {
          status: "needs_review", return_label_id: null, last_error: e.message,
          review_reasons: [...reasons, { code: "label_failed", message: `UPS did not accept the label: ${ssMessage(e.message)}` }],
        })) || request;
      } catch (pe) { console.warn("[shipstation-return] request patch failed:", pe.message); }
    }
    return { status: 502, body: { error: "label creation failed", detail: e.message, return_id: seed.id, request_status: request ? request.status : null } };
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
    const r = await bookPickup({
      label_id: label.label_id, ship_from, pickupWindowTz, pw,
      tracking: label.tracking_number, contactEmail: ship_from.email || ctx.contactEmail || null,
    });
    pickup = r.pickup; pickupError = r.error; pickupHint = r.hint;
    if (pickup) {
      await patchReturnLabel(seed.id, {
        pickup_confirm:   pickup.confirmation_number || pickup.pickup_id,
        pickup_id:        pickup.pickup_id || null,
        pickup_scheduled: true,
      });
    } else {
      await sbPatch("return_labels", `id=eq.${seed.id}`, {
        notes: `${notes || ""} | pickup_failed: ${r.raw}`,
      });
    }
  }
  const pickupConfirm = pickup ? (pickup.confirmation_number || pickup.pickup_id) : null;

  // --- 4) emails ---------------------------------------------------------
  let emailResult = { sent: false, reason: "not attempted" };
  let requestStatus = null;
  try {
    const pdfBase64 = label_url ? await fetchLabelPdfBase64(label_url) : null;
    if (request) {
      if (wantsPickup && !pickup) {
        // Client request whose pickup failed: hold every email until FR
        // books the pickup (Retry pickup) — the client and the customer get
        // one clean message instead of a "drop it off" one.
        request = (await patchRequest(request.id, {
          status: "pickup_failed", return_label_id: seed.id, tracking: label.tracking_number,
          label_created_at: new Date().toISOString(), last_error: pickupError,
        })) || request;
        requestStatus = request.status;
        emailResult = { sent: false, reason: "held until the pickup is scheduled" };
        await notifyStaff(request, "Label created, pickup not scheduled", [
          `UPS said: ${pickupError}`, pickupHint, `Tracking ${label.tracking_number} — use Retry pickup (do not create another label).`,
        ]);
      } else {
        request = (await patchRequest(request.id, {
          status: wantsPickup ? "scheduled" : "label_sent", return_label_id: seed.id,
          tracking: label.tracking_number, pickup_confirm: pickupConfirm,
          label_created_at: new Date().toISOString(), last_error: null,
        })) || request;
        requestStatus = request.status;
        const sendCustomer = request.email_customer !== false && !!ship_from.email;
        const [custRes] = await Promise.all([
          sendCustomer
            ? sendReturnEmail({
                toEmail: ship_from.email, carrierLabel: carrierCfg.label,
                contactName: ship_from.name || ship_from.company, tracking: label.tracking_number,
                pickupConfirm, pickupWindow: pickupWindowTz, service: resolvedService, pdfBase64,
                copyWarehouse: false,   // the client confirmation is already BCC'd to the warehouse
              })
            : Promise.resolve({ sent: false, reason: "customer email not requested" }),
          notifyClientScheduled(request, { pdfBase64, customerEmailed: sendCustomer }),
        ]);
        emailResult = custRes.sent ? custRes : { sent: false, reason: custRes.reason, recipients: [] };
      }
    } else {
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
    }
  } catch (e) {
    emailResult = { sent: false, reason: e.message };
  }

  return { status: 200, body: {
    ok:             true,
    return_id:      seed.id,
    carrier:        carrierCfg.label,
    tracking:       label.tracking_number,
    carrier_cost:   label.shipment_cost?.amount ?? null,
    label_url,
    pickup_confirm: pickupConfirm,
    pickup_error:   pickupError,   // null if no pickup requested or it succeeded
    pickup_hint:    pickupHint,    // actionable next step when UPS refuses
    pickup_tz:      pw.tz,         // zone used to stamp the window
    pickup_window:  pickupWindowTz,
    pickup_window_adjusted: windowAdjusted,   // start moved because it had passed
    email_sent:     emailResult.sent,
    email_error:    emailResult.sent ? null : emailResult.reason,
    email_to:       emailResult.recipients || [],
    email_invalid:  emailResult.invalid || [],   // addresses skipped as malformed
    request_id:     request ? request.id : null,
    request_code:   request ? request.request_code : null,
    request_status: requestStatus,
  } };
}

// dims/weight sanity flags (shared with the portal validation)
export function dimsFlags(dims, actualLb) {
  const L = +dims?.length || 0, W = +dims?.width || 0, H = +dims?.height || 0;
  const flags = [];
  if (!(L > 0 && W > 0 && H > 0)) return flags;
  const dimLb   = (L * W * H) / 139;                 // UPS/FedEx divisor
  const girth   = L + 2 * (W + H);                   // length + girth
  const longest = Math.max(L, W, H);
  if (girth > 130)                flags.push(`length+girth ${girth.toFixed(0)}" > 130" (UPS Large Package surcharge)`);
  if (longest > 48)               flags.push(`longest side ${longest}" > 48"`);
  if (actualLb > 0 && dimLb > 3 * actualLb && dimLb - actualLb > 10)
    flags.push(`dim weight ${dimLb.toFixed(1)} lb is ${(dimLb / actualLb).toFixed(1)}x the actual ${actualLb.toFixed(1)} lb`);
  return flags;
}

// POST /v2/pickups for an existing label. Never throws.
async function bookPickup({ label_id, ship_from, pickupWindowTz, pw, tracking, contactEmail }) {
  try {
    const pickup = await ss("/pickups", "POST", {
      label_ids: [label_id],
      pickup_window: pickupWindowTz,
      contact_details: {
        name:  ship_from.name,
        email: contactEmail || "warehouse@fr-logistics.net",
        phone: ship_from.phone || "0000000000",
      },
      pickup_address: {
        name:          ship_from.name,
        company_name:  ship_from.company,
        phone:         ship_from.phone || "0000000000",
        address_line1: ship_from.line1,
        ...(ship_from.line2 ? { address_line2: ship_from.line2 } : {}),
        city_locality: ship_from.city,
        state_province:ship_from.state,
        postal_code:   ship_from.zip,
        country_code:  "US",
      },
    });
    return { pickup, error: null, hint: null, raw: null };
  } catch (e) {
    // non-fatal: label already created; pickup can be retried
    const error = ssMessage(e.message);
    let hint = null;
    // UPS enforces an earliest allowable close time that varies by pickup
    // centre; a close time before noon local is almost always refused.
    if (/clos(?:e|ing)\s*time/i.test(error || "")) {
      hint = pw.closeHourLocal !== null && pw.closeHourLocal < 12
        ? `The window closes at ${String(pw.closeHourLocal).padStart(2,"0")}:00 local time at the pickup address (${pw.tz}). UPS rarely accepts a close time before 12:00 PM — try ending the window at 5:00 PM or later.`
        : `UPS refused the close time for this pickup centre (${pw.tz}). Try a later close time, or schedule the pickup directly on UPS.com with tracking ${tracking}.`;
    }
    return { pickup: null, error, hint, raw: e.message };
  }
}

async function actionCreateReturn(body, actor) {
  const r = await createReturnLabel(body, { actor });
  return jRes(r.body, r.status);
}

// ─── ACTION: retry_pickup — book the pickup of an EXISTING label ──────
export async function retryPickup({ return_id, pickup_date, window_start, window_end }, ctx = {}) {
  if (!UUID_RE.test(String(return_id || ""))) return { status: 400, body: { error: "invalid return_id" } };
  const rows = await sbGet(`return_labels?id=eq.${return_id}&select=*&limit=1`);
  const row = rows && rows[0];
  if (!row) return { status: 404, body: { error: "return label not found" } };
  if (row.status !== "in_transit" || !row.label_id) return { status: 409, body: { error: "label_not_active", message: `This label is ${row.status}; only an active label can get a pickup.` } };
  if (String(row.carrier || "").toUpperCase() !== "UPS") return { status: 409, body: { error: "pickup_ups_only", message: "Pickups are booked for UPS labels only." } };
  if (row.pickup_scheduled && row.pickup_confirm) return { status: 409, body: { error: "pickup_already_scheduled", message: `Pickup ${row.pickup_confirm} is already scheduled for this label.` } };

  const date = String(pickup_date || "").trim();
  const s = String(window_start || "09:00").slice(0, 5), e = String(window_end || "17:00").slice(0, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(s) || !/^\d{2}:\d{2}$/.test(e)) {
    return { status: 400, body: { error: "pickup_date, window_start and window_end are required (YYYY-MM-DD, HH:MM)" } };
  }
  const ship_from = row.ship_from_json || {};
  const g = guardPickupWindow({ start_at: `${date}T${s}:00`, end_at: `${date}T${e}:00` }, ship_from, ctx.now || new Date());
  if (!g.ok) return { status: 409, body: { error: g.error, message: g.message, suggest_date: g.suggest_date, pickup_tz: g.tz } };
  const pw = normalizePickupWindow(g.window, ship_from);

  // linked request (if this label came from the portal)
  let request = null;
  try {
    const rq = await sbGet(`pickup_requests?return_label_id=eq.${row.id}&select=*&limit=1`);
    request = rq && rq[0] ? rq[0] : null;
  } catch { request = null; }

  const r = await bookPickup({
    label_id: row.label_id, ship_from, pickupWindowTz: pw.window, pw, tracking: row.tracking,
    contactEmail: ship_from.email || (request && request.submitted_via !== "internal" ? request.submitted_by : null),
  });
  if (!r.pickup) {
    await sbPatch("return_labels", `id=eq.${row.id}`, { notes: `${row.notes || ""} | pickup_retry_failed: ${r.raw}`.slice(0, 2000) });
    if (request) { try { await patchRequest(request.id, { last_error: r.error }); } catch {} }
    return { status: 502, body: { error: "pickup_failed", message: r.error, hint: r.hint, pickup_tz: pw.tz } };
  }
  const confirm = r.pickup.confirmation_number || r.pickup.pickup_id;
  await patchReturnLabel(row.id, {
    pickup_confirm: confirm, pickup_id: r.pickup.pickup_id || null, pickup_scheduled: true, pickup_window: pw.window,
  });

  // emails: the customer gets the label + pickup; the client gets its confirmation
  let pdfBase64 = null;
  try { pdfBase64 = row.label_url ? await fetchLabelPdfBase64(row.label_url) : null; } catch {}
  const sendCustomer = !!ship_from.email && (!request || request.email_customer !== false);
  const tasks = [];
  if (sendCustomer) {
    tasks.push(sendReturnEmail({
      toEmail: ship_from.email, carrierLabel: "UPS", contactName: ship_from.name || ship_from.company,
      tracking: row.tracking, pickupConfirm: confirm, pickupWindow: pw.window, service: row.service, pdfBase64,
      copyWarehouse: !request,
    }));
  }
  if (request) {
    request = (await patchRequest(request.id, {
      status: "scheduled", pickup_confirm: confirm, tracking: row.tracking, last_error: null,
      pickup_date: date, window_start: g.window.start_at.slice(11, 16), window_end: g.window.end_at.slice(11, 16),
      handled_by: ctx.actor || request.handled_by || null,
    })) || request;
    tasks.push(notifyClientScheduled(request, { pdfBase64, customerEmailed: sendCustomer }));
  }
  const results = await Promise.all(tasks);
  return { status: 200, body: {
    ok: true, return_id: row.id, tracking: row.tracking, pickup_confirm: confirm, pickup_window: pw.window, pickup_tz: pw.tz,
    pickup_window_adjusted: g.adjusted, request_code: request ? request.request_code : null,
    emails: results.map((x) => (x && x.sent ? "sent" : `not sent: ${x && x.reason}`)),
  } };
}

// ─── ACTION: void_label — cancel pickup + void label ──────────────────
export async function voidLabel({ return_id, reason }, ctx = {}) {
  if (!UUID_RE.test(String(return_id || ""))) return { status: 400, body: { error: "invalid return_id" } };
  const rows = await sbGet(`return_labels?id=eq.${return_id}&select=*&limit=1`);
  const row = rows && rows[0];
  if (!row) return { status: 404, body: { error: "return label not found" } };
  if (row.status === "voided") return { status: 200, body: { ok: true, already: true, return_id: row.id } };
  if (row.billed_at) return { status: 409, body: { error: "already_billed", message: `This label was billed on ${String(row.billed_at).slice(0, 10)} (${row.invoice_id || "invoice"}). Handle it as a credit, not a void.` } };
  if (!row.label_id) return { status: 409, body: { error: "no_label", message: "This row has no ShipStation label to void." } };

  // Already received at the warehouse? Then the label was used.
  if (row.tracking) {
    const got = await sbGet(`shipments_general?tracking=eq.${encodeURIComponent(row.tracking)}&select=received_at&limit=1`);
    if (got && got.length) return { status: 409, body: { error: "label_used", message: `Tracking ${row.tracking} was already received at the warehouse — it cannot be voided.` } };
  }

  const steps = [];
  if (row.pickup_scheduled && row.pickup_id) {
    try { await ss(`/pickups/${encodeURIComponent(row.pickup_id)}`, "DELETE"); steps.push(`pickup ${row.pickup_confirm || row.pickup_id} cancelled`); }
    catch (e) { return { status: 502, body: { error: "pickup_cancel_failed", message: `Could not cancel pickup ${row.pickup_confirm}: ${ssMessage(e.message)}. Cancel it on ups.com first.` } }; }
  } else if (row.pickup_scheduled) {
    steps.push(`pickup ${row.pickup_confirm} must be cancelled on ups.com (no pickup_id stored for this older label)`);
  }

  let v;
  try { v = await ss(`/labels/${encodeURIComponent(row.label_id)}/void`, "PUT"); }
  catch (e) { return { status: 502, body: { error: "void_failed", message: ssMessage(e.message), steps } }; }
  if (v && v.approved === false) return { status: 409, body: { error: "void_refused", message: v.message || "ShipStation refused the void.", steps } };

  const who = ctx.actor || "staff";
  await sbPatch("return_labels", `id=eq.${row.id}`, {
    status: "voided", pickup_scheduled: false,
    notes: `${row.notes || ""} | voided ${new Date().toISOString().slice(0, 10)} by ${who}${reason ? ": " + reason : ""}`.slice(0, 2000),
  });
  steps.push("label voided");

  // A client request linked to it goes back to review (recreate or cancel).
  try {
    const rq = await sbGet(`pickup_requests?return_label_id=eq.${row.id}&select=*&limit=1`);
    if (rq && rq[0] && rq[0].status !== "cancelled") {
      const reasons = Array.isArray(rq[0].review_reasons) ? rq[0].review_reasons : [];
      await patchRequest(rq[0].id, {
        status: "needs_review", return_label_id: null, tracking: null, pickup_confirm: null,
        review_reasons: [...reasons, { code: "label_voided", message: "The label was voided by FR-Logistics." }],
      });
      steps.push(`${rq[0].request_code} back to review`);
    }
  } catch (e) { steps.push(`request update failed: ${e.message}`); }

  return { status: 200, body: { ok: true, return_id: row.id, tracking: row.tracking, message: v && v.message, steps } };
}

// ─── Staff queue for client requests ──────────────────────────────────
async function receivedMap(trackings) {
  const list = [...new Set((trackings || []).filter(Boolean).map((t) => String(t).toUpperCase()))];
  const map = new Map();
  for (let i = 0; i < list.length; i += 60) {
    const chunk = list.slice(i, i + 60).map((t) => `"${t.replace(/"/g, "")}"`).join(",");
    const rows = await sbGet(`shipments_general?tracking=in.(${encodeURIComponent(chunk)})&direction=eq.Inbound&select=tracking,received_at`);
    for (const r of rows || []) {
      const k = String(r.tracking || "").toUpperCase();
      if (!map.has(k) || (r.received_at && r.received_at < map.get(k))) map.set(k, r.received_at);
    }
  }
  return map;
}
export { receivedMap };

async function actionRequests() {
  const open = await sbGet(
    "pickup_requests?status=in.(processing,needs_review,pickup_failed)&select=*&order=created_at.asc&limit=200");
  const since = new Date(Date.now() - 60 * 86400000).toISOString();
  const shipped = await sbGet(
    `pickup_requests?status=in.(scheduled,label_sent)&outcome=is.null&tracking=not.is.null&created_at=gte.${encodeURIComponent(since)}&select=*&order=created_at.asc&limit=300`);
  const rec = await receivedMap(shipped.map((r) => r.tracking));
  const arrived = shipped
    .filter((r) => rec.has(String(r.tracking).toUpperCase()))
    .map((r) => ({ ...r, received_at: rec.get(String(r.tracking).toUpperCase()) }));
  // pickup error details for the failed ones
  const ids = open.filter((r) => r.return_label_id).map((r) => r.return_label_id);
  let labels = [];
  if (ids.length) labels = await sbGet(`return_labels?id=in.(${ids.join(",")})&select=id,tracking,label_url,pickup_scheduled,pickup_confirm,status`);
  const byId = new Map(labels.map((l) => [l.id, l]));
  return jRes({
    ok: true,
    open: open.map((r) => ({ ...r, label: r.return_label_id ? byId.get(r.return_label_id) || null : null })),
    arrived,
    counts: { open: open.length, arrived: arrived.length },
  });
}

async function actionRequestCancel({ id, reason }, actor) {
  if (!UUID_RE.test(String(id || ""))) return jRes({ error: "invalid id" }, 400);
  const r = await getRequest(id);
  if (!r) return jRes({ error: "request not found" }, 404);
  if (r.status === "cancelled") return jRes({ ok: true, already: true });
  if (r.return_label_id && ["scheduled", "label_sent", "pickup_failed"].includes(r.status)) {
    return jRes({ error: "has_label", message: "This request has an active label. Void the label first (Open returns → Void)." }, 409);
  }
  const updated = await patchRequest(id, {
    status: "cancelled", cancelled_at: new Date().toISOString(), cancelled_by: actor || "staff",
    cancel_reason: String(reason || "").trim().slice(0, 300) || "Cancelled by FR-Logistics",
  });
  const mail = await notifyClientCancelled(updated);
  return jRes({ ok: true, request: updated, email_sent: mail.sent });
}

async function actionRequestOutcome({ id, outcome, note }, actor) {
  if (!UUID_RE.test(String(id || ""))) return jRes({ error: "invalid id" }, 400);
  if (!OUTCOME_TEXT[outcome]) return jRes({ error: "invalid outcome" }, 400);
  if (outcome === "other" && !String(note || "").trim()) return jRes({ error: "a note is required for 'Other'" }, 400);
  const r = await getRequest(id);
  if (!r) return jRes({ error: "request not found" }, 404);
  if (!r.tracking) return jRes({ error: "no_tracking", message: "This request has no label yet." }, 409);
  const rec = await receivedMap([r.tracking]);
  const receivedAt = rec.get(String(r.tracking).toUpperCase()) || null;
  if (!receivedAt) return jRes({ error: "not_received", message: `Tracking ${r.tracking} has not been received in Inbound yet.` }, 409);
  const updated = await patchRequest(id, {
    outcome, outcome_note: String(note || "").trim().slice(0, 500) || null,
    outcome_at: new Date().toISOString(), outcome_by: actor || "staff",
  });
  const mail = await notifyClientOutcome(updated, receivedAt);
  return jRes({ ok: true, request: updated, email_sent: mail.sent });
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

  const actor = req.headers.get("x-fr-user-email") || null;   // set by auth-gate.js

  try {
    if (req.method === "GET") {
      const url = new URL(req.url);
      const action = url.searchParams.get("action") || "";
      if (action === "carriers") return await actionCarriers();
      if (action === "list")     return await actionList(url);
      if (action === "requests") return await actionRequests();
      return jRes({ error: `unknown GET action: ${action || "(none)"}` }, 400);
    }
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const action = body.action || "";
      if (action === "create_return")   return await actionCreateReturn(body, actor);
      if (action === "retry_pickup")    { const r = await retryPickup(body, { actor }); return jRes(r.body, r.status); }
      if (action === "void_label")      { const r = await voidLabel(body, { actor }); return jRes(r.body, r.status); }
      if (action === "request_cancel")  return await actionRequestCancel(body, actor);
      if (action === "request_outcome") return await actionRequestOutcome(body, actor);
      return jRes({ error: `unknown POST action: ${action || "(none)"}` }, 400);
    }
    return jRes({ error: `method not allowed: ${req.method}` }, 405);
  } catch (e) {
    console.error("[shipstation-return]", e);
    return jRes({ error: e.message || "internal error" }, 500);
  }
}
