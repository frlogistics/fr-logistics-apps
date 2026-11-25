// netlify/functions/portal-pickup-requests.js
// FR-Logistics Client Portal — "Returns" tab: return pickup requests (24-nov-2026).
//
// WHY: return pickups used to arrive by email (4BLANC/MXS), were retyped by
// hand into Inbound/Outbound → Create Return Label, and the label went back
// by email. Typos broke labels (missing state, wrong dims → $519.44), the RMA
// reference lived in free text, and every return needed several emails
// ("is it back in saleable inventory?"). The client now files the request in
// the portal; this function validates it and, when every check passes and
// the client is set to auto, buys the UPS return label and books the pickup
// on the spot (same core as the warehouse uses: shipstation-return.js).
//
// Which clients: fr_clients.return_pickup_mode
//   off    → the form is hidden; POST answers 403.
//   review → every request waits for the warehouse (needs_review).
//   auto   → label + pickup created immediately when nothing is flagged.
//
// Auth contract: same as the other portal-* functions. The edge gate
// (auth-gate.js) requires a session, FORCES portal_user to the signed-in
// email and sets x-fr-user-email; as_client is honoured only for the admin
// account (warehouse@). This function refuses to run without that header,
// so it stays closed even if the gate is ever switched off.
//
// GET  ?portal_user=…[&as_client=…]            → { ok, enabled, mode, client, rules, requests:[…] }
// GET  ?action=label&id=<request id>            → the label PDF (owner only)
// POST { action:'create', …form }               → { ok, request }   (422 with field errors)
// POST { action:'cancel', id }                  → { ok, request }   (only before a label exists)
//
// No new environment variables.

import {
  createReturnLabel, sbGet, parseRecipients, cleanLine2, dimsFlags,
  isBusinessDay, nextBusinessDay, addDaysYmd, wallNow, upsHolidays,
  notifyClientReceived, notifyStaff, receivedMap, fetchLabelPdfBase64,
  dispositionLine, requestNotes, OUTCOME_TEXT, upsTrackUrl, fmtWindowDate,
} from "./shipstation-return.js";

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY");

const ADMIN_EMAIL    = "warehouse@fr-logistics.net";
const ET             = "America/New_York";
const MAX_DAYS_AHEAD = 14;     // latest pickup date offered
const LIST_DAYS      = 90;     // history shown in the portal
const DUP_DAYS       = 14;     // same address within this window → review
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const enc = encodeURIComponent;

const HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: HEADERS });

// ─── Supabase ──────────────────────────────────────────────────────────
async function sb(path, { method = "GET", body, prefer } = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) {
    const err = new Error(`Supabase ${method} ${path.split("?")[0]} ${r.status}: ${text.slice(0, 240)}`);
    err.status = r.status;
    try { err.pg = JSON.parse(text); } catch { err.pg = null; }
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

// ─── Who is calling ────────────────────────────────────────────────────
function callerOf(req, url, body) {
  const email = String(req.headers.get("x-fr-user-email") || "").trim().toLowerCase();
  if (!email) return { error: [401, "Your session could not be verified. Please sign in again."] };
  const claimed = String((body && body.portal_user) || url.searchParams.get("portal_user") || "").trim().toLowerCase();
  if (claimed && claimed !== email) return { error: [401, "Session mismatch. Please sign in again."] };
  const isAdmin = email === ADMIN_EMAIL;
  const raw = isAdmin ? String((body && body.as_client) || url.searchParams.get("as_client") || "").trim() : "";
  return { email, isAdmin, asClient: UUID_RE.test(raw) ? raw : "" };
}

const CLIENT_SELECT = "id,name,company,store_name,email,client_code,return_pickup_mode";
async function resolveClient(caller) {
  if (caller.isAdmin && !caller.asClient) return { allClients: true, client: null };
  const f = caller.asClient ? `id=eq.${caller.asClient}` : `portal_user=eq.${enc(caller.email)}`;
  const rows = await sb(`fr_clients?${f}&select=${CLIENT_SELECT}&limit=1`);
  return { allClients: false, client: rows && rows[0] ? rows[0] : null };
}
// Same value the warehouse app writes to return_labels.client
const clientValue = (c) => (c.store_name || c.company || c.name || "").trim();
const clientLabel = (c) => (c.company || c.name || c.store_name || "").trim();

// ─── Calendar rules shown to the form ─────────────────────────────────
export function pickupRules(now = new Date()) {
  const today = wallNow(ET, now).date;
  const earliest = nextBusinessDay(today);
  const latest = addDaysYmd(today, MAX_DAYS_AHEAD);
  const years = new Set([earliest.slice(0, 4), latest.slice(0, 4)].map(Number));
  const holidays = [];
  for (const y of years) for (const d of upsHolidays(y)) if (d >= earliest && d <= latest) holidays.push(d);
  holidays.sort();
  return {
    today, earliest_date: earliest, latest_date: latest, holidays,
    default_window: { start: "09:00", end: "17:00" },
    window_limits: { start_min: "07:00", start_max: "16:00", end_min: "12:00", end_max: "20:00", min_hours: 2 },
    max_weight_lb: 150, max_side_in: 108,
  };
}

// ─── Address tables ────────────────────────────────────────────────────
const US_STATES = new Set(("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH " +
  "NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY").split(" "));

// ZIP3 → state (USPS prefixes). Only prefixes we are sure of; an unknown
// prefix is not an error (UPS validates the address anyway).
const ZIP3_RANGES = [
  ["NY", 5, 5], ["MA", 10, 27], ["RI", 28, 29], ["NH", 30, 38], ["ME", 39, 49], ["VT", 50, 54], ["MA", 55, 55],
  ["VT", 56, 59], ["CT", 60, 69], ["NJ", 70, 89], ["NY", 100, 149], ["PA", 150, 196], ["DE", 197, 199],
  ["DC", 200, 200], ["VA", 201, 201], ["DC", 202, 205], ["MD", 206, 212], ["MD", 214, 219], ["VA", 220, 246],
  ["WV", 247, 268], ["NC", 270, 289], ["SC", 290, 299], ["GA", 300, 319], ["FL", 320, 339], ["FL", 341, 349],
  ["AL", 350, 369], ["TN", 370, 385], ["MS", 386, 397], ["GA", 398, 399], ["KY", 400, 427], ["OH", 430, 459],
  ["IN", 460, 479], ["MI", 480, 499], ["IA", 500, 528], ["WI", 530, 549], ["MN", 550, 567], ["SD", 570, 577],
  ["ND", 580, 588], ["MT", 590, 599], ["IL", 600, 629], ["MO", 630, 658], ["KS", 660, 679], ["NE", 680, 693],
  ["LA", 700, 714], ["AR", 716, 729], ["OK", 730, 731], ["TX", 733, 733], ["OK", 734, 749], ["TX", 750, 799],
  ["CO", 800, 816], ["WY", 820, 831], ["ID", 832, 838], ["UT", 840, 847], ["AZ", 850, 865], ["NM", 870, 884],
  ["TX", 885, 885], ["NV", 889, 898], ["CA", 900, 961], ["HI", 967, 968], ["OR", 970, 979], ["WA", 980, 994],
  ["AK", 995, 999],
];
export function stateForZip(zip) {
  const z3 = parseInt(String(zip || "").replace(/\D/g, "").slice(0, 3), 10);
  if (!Number.isFinite(z3)) return null;
  const hit = ZIP3_RANGES.find(([, a, b]) => z3 >= a && z3 <= b);
  return hit ? hit[0] : null;
}
const PO_BOX_RE = /\bp\.?\s*o\.?\s*box\b|\bpost\s*office\s*box\b|\bpobox\b/i;
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMin = (hhmm) => { const m = HHMM_RE.exec(hhmm); return m ? +m[1] * 60 + +m[2] : NaN; };

const str = (v, max = 200) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max + 1);
const num = (v) => (v === "" || v == null ? NaN : Number(String(v).replace(",", ".")));

// ─── Validation ────────────────────────────────────────────────────────
// → { errors:{field:msg}, flags:[{code,message}], clean:{…} }
// errors = the client must fix them; flags = accepted, but the warehouse
// checks before a label is bought.
export function validateRequest(input, now = new Date()) {
  const errors = {};
  const flags = [];
  const bad = (k, m) => { if (!errors[k]) errors[k] = m; };
  const c = input && typeof input.customer === "object" && input.customer ? input.customer : {};
  const pkg = input && typeof input.package === "object" && input.package ? input.package : {};

  const reference = str(input.reference, 60);
  if (!reference) bad("reference", "Enter your RMA or return reference.");
  else if (reference.length > 60) bad("reference", "Keep the reference under 60 characters.");
  const order_ref = str(input.order_ref, 40);
  if (order_ref.length > 40) bad("order_ref", "Keep the order number under 40 characters.");

  const name = str(c.name, 35);
  if (name.length < 2) bad("customer.name", "Enter the customer's name.");
  else if (name.length > 35) bad("customer.name", "UPS allows 35 characters for the name.");
  let company = str(c.company, 35);
  if (company.length > 35) bad("customer.company", "UPS allows 35 characters for the company.");
  const line1 = str(c.line1, 35);
  if (line1.length < 3) bad("customer.line1", "Enter the street address.");
  else if (line1.length > 35) bad("customer.line1", "UPS allows 35 characters per address line — move the rest to Line 2.");
  else if (!/\d/.test(line1)) bad("customer.line1", "The street address needs a house or building number.");
  const line2 = cleanLine2(str(c.line2, 35));
  if (line2.length > 35) bad("customer.line2", "UPS allows 35 characters per address line.");
  if (PO_BOX_RE.test(line1) || PO_BOX_RE.test(line2)) bad("customer.line1", "UPS cannot pick up from a P.O. Box. Use the street address.");
  const city = str(c.city, 30);
  if (city.length < 2) bad("customer.city", "Enter the city.");
  else if (city.length > 30) bad("customer.city", "Keep the city under 30 characters.");
  const state = str(c.state, 2).toUpperCase();
  if (!US_STATES.has(state)) bad("customer.state", "Use the 2-letter code of a US state (e.g. NJ). Pickups are US only.");
  const zipDigits = String(c.zip || "").replace(/\D/g, "");
  let zip = "";
  if (zipDigits.length === 5) zip = zipDigits;
  else if (zipDigits.length === 9) zip = `${zipDigits.slice(0, 5)}-${zipDigits.slice(5)}`;
  if (!zip) bad("customer.zip", "Enter a 5-digit ZIP code.");
  else if (US_STATES.has(state)) {
    const zs = stateForZip(zip);
    if (zs && zs !== state) bad("customer.zip", `ZIP ${zip.slice(0, 5)} is in ${zs}, not ${state}. Check the ZIP or the state.`);
  }
  let phone = String(c.phone || "").replace(/\D/g, "");
  if (phone.length === 11 && phone.startsWith("1")) phone = phone.slice(1);
  if (phone.length !== 10 || /^(\d)\1{9}$/.test(phone) || /^[01]/.test(phone)) {
    bad("customer.phone", "Enter the customer's 10-digit US phone number (UPS calls it if needed).");
  }
  const email = str(c.email, 80).toLowerCase();
  if (email && !EMAIL_RE.test(email)) bad("customer.email", "This email address is not valid.");
  const email_customer = input.email_customer !== false;
  if (email_customer && !email) bad("customer.email", "Add the customer's email, or untick “Email the label to the customer”.");
  if (!company) company = name;

  // items
  const rawItems = Array.isArray(input.items) ? input.items : [];
  const items = [];
  rawItems.slice(0, 11).forEach((it) => {
    const sku = str(it && it.sku, 60);
    const description = str(it && it.description, 120);
    const qtyRaw = it && it.qty;
    if (!sku && !description && (qtyRaw === "" || qtyRaw == null)) return;     // empty line
    const qty = Number(qtyRaw);
    items.push({ sku, description, qty });
  });
  if (!items.length) bad("items", "Add at least one item (SKU or description and quantity).");
  else if (items.length > 10) bad("items", "Up to 10 item lines per request — file a second request for the rest.");
  else {
    items.forEach((it, i) => {
      if (!it.sku && !it.description) bad("items", `Line ${i + 1}: enter a SKU or a description.`);
      else if (it.sku.length > 60 || it.description.length > 120) bad("items", `Line ${i + 1}: SKU or description is too long.`);
      else if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > 999) bad("items", `Line ${i + 1}: quantity must be a whole number from 1 to 999.`);
    });
  }

  // package
  const weight_lb = Math.round(num(pkg.weight_lb) * 100) / 100;
  if (!Number.isFinite(weight_lb) || weight_lb < 0.1) bad("package.weight_lb", "Enter the packed weight in pounds.");
  else if (weight_lb > 150) bad("package.weight_lb", "UPS takes up to 150 lb per box. Contact us for heavier returns.");
  const L = Math.round(num(pkg.length_in) * 10) / 10;
  const W = Math.round(num(pkg.width_in) * 10) / 10;
  const H = Math.round(num(pkg.height_in) * 10) / 10;
  if (![L, W, H].every((v) => Number.isFinite(v) && v >= 1)) bad("package.dims", "Enter the box length, width and height in inches.");
  else if ([L, W, H].some((v) => v > 108)) bad("package.dims", "UPS takes boxes up to 108 inches on the longest side.");
  else {
    const dims = [L, W, H].sort((a, b) => b - a);
    if (dims[0] + 2 * (dims[1] + dims[2]) > 165) bad("package.dims", "UPS takes up to 165 inches of length + girth. Contact us for this box.");
  }

  // method + window
  const method = input.method === "dropoff" ? "dropoff" : "pickup";
  const rules = pickupRules(now);
  let pickup_date = null, window_start = null, window_end = null;
  if (method === "pickup") {
    pickup_date = str(input.pickup_date, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pickup_date)) bad("pickup_date", "Choose the pickup date.");
    else if (pickup_date < rules.earliest_date) bad("pickup_date", `The earliest pickup date is ${fmtWindowDate(rules.earliest_date)} (next business day).`);
    else if (pickup_date > rules.latest_date) bad("pickup_date", `Choose a date up to ${fmtWindowDate(rules.latest_date)}.`);
    else if (!isBusinessDay(pickup_date)) bad("pickup_date", "UPS does not pick up on weekends or UPS holidays. Choose a business day.");
    window_start = str(input.window_start, 5);
    window_end = str(input.window_end, 5);
    const s = toMin(window_start), e = toMin(window_end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) bad("window", "Enter the pickup window (from / to).");
    else if (s < toMin("07:00") || s > toMin("16:00")) bad("window", "The window can start between 7:00 AM and 4:00 PM.");
    else if (e < toMin("12:00") || e > toMin("20:00")) bad("window", "The window must end between 12:00 PM and 8:00 PM (UPS refuses earlier close times).");
    else if (e - s < 120) bad("window", "The window must be at least 2 hours long.");
  }

  // on arrival
  const disposition = ["restock", "inspect_hold", "fulfill_order", "other"].includes(input.disposition) ? input.disposition : null;
  if (!disposition) bad("disposition", "Tell us what to do when the return arrives.");
  const disposition_order_ref = str(input.disposition_order_ref, 40);
  if (disposition === "fulfill_order" && !disposition_order_ref) bad("disposition_order_ref", "Enter the order to fulfill with this item.");
  const disposition_notes = String(input.disposition_notes == null ? "" : input.disposition_notes).trim().slice(0, 501);
  if (disposition_notes.length > 500) bad("disposition_notes", "Keep the instructions under 500 characters.");
  if (disposition === "other" && !disposition_notes) bad("disposition_notes", "Write the instructions for this return.");

  // notifications
  const { valid: notify_emails, invalid: badEmails } = parseRecipients(input.notify_emails || "");
  if (badEmails.length) bad("notify_emails", `Not a valid email: ${badEmails.slice(0, 2).join(", ")}`);
  else if (notify_emails.length > 5) bad("notify_emails", "Up to 5 extra email addresses.");

  // flags (accepted, but checked by the warehouse before buying the label)
  if (!Object.keys(errors).length) {
    const df = dimsFlags({ length: L, width: W, height: H }, weight_lb);
    if (df.length) flags.push({ code: "dims_check", message: "The box size or weight needs a check before we buy the label (possible UPS oversize or dimensional-weight charges).", detail: df.join("; ") });
    if (state === "AK" || state === "HI") flags.push({ code: "ak_hi", message: "UPS Ground does not pick up in Alaska or Hawaii — we will confirm the service and cost with you." });
  }

  return {
    errors, flags,
    clean: {
      reference, order_ref: order_ref || null,
      ship_from: { name, company, line1, ...(line2 ? { line2 } : {}), city, state, zip, phone, ...(email ? { email } : {}) },
      items, weight_lb, length_in: L, width_in: W, height_in: H,
      method, pickup_date, window_start, window_end, email_customer: email_customer && !!email,
      disposition, disposition_order_ref: disposition === "fulfill_order" ? disposition_order_ref : null,
      disposition_notes: disposition_notes || null,
      notify_emails: notify_emails.slice(0, 5),
    },
  };
}

// ─── Duplicates ────────────────────────────────────────────────────────
export const addrKey = (sf) =>
  `${String((sf && sf.zip) || "").replace(/\D/g, "").slice(0, 5)}|${String((sf && sf.line1) || "").toLowerCase().replace(/[^a-z0-9]/g, "")}`;

async function duplicateFlags(clientId, shipFrom, now = new Date()) {
  const since = new Date(now.getTime() - DUP_DAYS * 86400000).toISOString();
  const key = addrKey(shipFrom);
  const [reqs, labels] = await Promise.all([
    sb(`pickup_requests?client_id=eq.${clientId}&status=neq.cancelled&created_at=gte.${enc(since)}&select=request_code,ship_from,created_at&order=created_at.desc&limit=200`),
    sb(`return_labels?client_id=eq.${clientId}&status=not.in.(label_failed,voided)&created_at=gte.${enc(since)}&select=tracking,ship_from_json,created_at,notes&order=created_at.desc&limit=200`),
  ]);
  const day = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: ET });
  const r = (reqs || []).find((x) => addrKey(x.ship_from) === key);
  if (r) return [{ code: "possible_duplicate", message: `A return from this address was already requested on ${day(r.created_at)} (${r.request_code}). We will check it is not a duplicate before booking.` }];
  const l = (labels || []).find((x) => addrKey(x.ship_from_json) === key);
  if (l) return [{ code: "possible_duplicate", message: `A return label from this address was already created on ${day(l.created_at)} (tracking ${l.tracking || "pending"}). We will check it is not a duplicate before booking.` }];
  return [];
}

// ─── Public shape (never cost, never label_url, never raw carrier errors) ─
const STATUS_LABEL = {
  processing: "Processing",
  needs_review: "Under review",
  scheduled: "Pickup scheduled",
  label_sent: "Label sent",
  pickup_failed: "Label ready — scheduling pickup",
  cancelled: "Cancelled",
};
const CLIENT_REASON = {
  label_failed: "UPS did not accept the address or package details — our team is checking them.",
  label_voided: "The label was cancelled by our team — we will contact you.",
};
export function publicRequest(r, receivedAt = null, withClient = false) {
  const sf = r.ship_from || {};
  const received = !!receivedAt && r.status !== "cancelled";
  let statusLabel = STATUS_LABEL[r.status] || r.status;
  let statusKey = r.status;
  if (received) { statusKey = r.outcome ? "processed" : "received"; statusLabel = r.outcome ? "Processed" : "Received"; }
  const hasLabel = !!(r.return_label_id && r.tracking && ["scheduled", "label_sent", "pickup_failed"].includes(r.status));
  const reasons = (Array.isArray(r.review_reasons) ? r.review_reasons : [])
    .map((x) => CLIENT_REASON[x.code] || x.message).filter(Boolean);
  const stale = r.status === "processing" && Date.now() - new Date(r.created_at).getTime() > 10 * 60000;
  return {
    id: r.id,
    request_code: r.request_code,
    created_at: r.created_at,
    ...(withClient ? { client: r.client } : {}),
    status: statusKey,
    status_label: statusLabel,
    reference: r.reference,
    order_ref: r.order_ref,
    customer: { name: sf.name || "", city: sf.city || "", state: sf.state || "", zip: sf.zip || "" },
    items: Array.isArray(r.items) ? r.items : [],
    package: { weight_lb: r.weight_lb, length_in: r.length_in, width_in: r.width_in, height_in: r.height_in },
    method: r.method,
    pickup_date: r.pickup_date,
    window_start: r.window_start ? String(r.window_start).slice(0, 5) : null,
    window_end: r.window_end ? String(r.window_end).slice(0, 5) : null,
    pickup_confirm: r.status === "scheduled" ? r.pickup_confirm : null,
    tracking: hasLabel ? r.tracking : null,
    tracking_url: hasLabel ? upsTrackUrl(r.tracking) : null,
    label_available: hasLabel,
    disposition: r.disposition,
    disposition_label: dispositionLine(r),
    disposition_notes: r.disposition_notes,
    received_at: received ? receivedAt : null,
    outcome: r.outcome || null,
    outcome_label: r.outcome ? (OUTCOME_TEXT[r.outcome] || r.outcome) : null,
    outcome_note: r.outcome_note || null,
    cancel_reason: r.status === "cancelled" ? (r.cancel_reason || null) : null,
    review_reasons: r.status === "needs_review" ? reasons : [],
    can_cancel: !r.return_label_id && (r.status === "needs_review" || stale),
  };
}

// ─── GET: list ─────────────────────────────────────────────────────────
async function handleList(caller) {
  const who = await resolveClient(caller);
  const rules = pickupRules();
  if (!who.allClients && !who.client) {
    return json({ ok: true, mode: "no_client", enabled: false, isAdmin: caller.isAdmin, rules, requests: [] });
  }
  const since = new Date(Date.now() - LIST_DAYS * 86400000).toISOString();
  const f = who.allClients ? "" : `&client_id=eq.${who.client.id}`;
  const rows = await sb(`pickup_requests?created_at=gte.${enc(since)}${f}&select=*&order=created_at.desc&limit=300`);
  const rec = await receivedMap((rows || []).map((r) => r.tracking));
  const mode = who.allClients ? "admin_all" : (who.client.return_pickup_mode || "off");
  return json({
    ok: true,
    isAdmin: caller.isAdmin,
    mode,
    enabled: who.allClients ? false : (mode !== "off" || caller.isAdmin),
    client: who.client ? { id: who.client.id, name: clientLabel(who.client) } : null,
    rules,
    requests: (rows || []).map((r) =>
      publicRequest(r, r.tracking ? rec.get(String(r.tracking).toUpperCase()) || null : null, who.allClients)),
  });
}

// ─── GET: label PDF (owner only) ──────────────────────────────────────
async function handleLabel(caller, url) {
  const id = String(url.searchParams.get("id") || "");
  if (!UUID_RE.test(id)) return json({ ok: false, error: "Invalid request id" }, 400);
  const who = await resolveClient(caller);
  const rows = await sb(`pickup_requests?id=eq.${id}&select=id,client_id,return_label_id,status,tracking,request_code&limit=1`);
  const r = rows && rows[0];
  if (!r || (!who.allClients && (!who.client || r.client_id !== who.client.id))) return json({ ok: false, error: "Request not found" }, 404);
  if (!r.return_label_id || !["scheduled", "label_sent", "pickup_failed"].includes(r.status)) {
    return json({ ok: false, error: "This request has no label yet." }, 404);
  }
  const lab = await sb(`return_labels?id=eq.${r.return_label_id}&select=label_url,status,tracking&limit=1`);
  const l = lab && lab[0];
  if (!l || !l.label_url || l.status === "voided") return json({ ok: false, error: "The label is not available." }, 404);
  const b64 = await fetchLabelPdfBase64(l.label_url);
  if (!b64) return json({ ok: false, error: "Could not download the label right now. Try again in a minute." }, 502);
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="return-label-${(l.tracking || r.request_code).replace(/[^A-Za-z0-9_-]/g, "")}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}

// ─── POST: create ──────────────────────────────────────────────────────
async function handleCreate(caller, body) {
  const who = await resolveClient(caller);
  if (who.allClients) return json({ ok: false, error: "Pick a client in “Viewing as” first — the warehouse account is not a client." }, 400);
  if (!who.client) return json({ ok: false, error: "No client is linked to this login." }, 404);
  const client = who.client;
  const mode = client.return_pickup_mode || "off";
  if (mode === "off" && !caller.isAdmin) {
    return json({ ok: false, error: "Return pickups are not enabled for your account yet. Write to warehouse@fr-logistics.net." }, 403);
  }

  const now = new Date();
  const { errors, flags, clean } = validateRequest(body || {}, now);
  if (Object.keys(errors).length) return json({ ok: false, error: "Please fix the highlighted fields.", errors }, 422);

  // Idempotency: the form sends one token per open form.
  const token = UUID_RE.test(String((body && body.client_token) || "")) ? String(body.client_token) : null;
  if (token) {
    const prev = await sb(`pickup_requests?client_id=eq.${client.id}&client_token=eq.${token}&select=*&limit=1`);
    if (prev && prev[0]) return json({ ok: true, duplicate_submit: true, request: publicRequest(prev[0]) });
  }

  const allFlags = [...flags, ...(await duplicateFlags(client.id, clean.ship_from, now))];
  if (mode !== "auto") allFlags.unshift({ code: "manual_review", message: "Requests from your account are confirmed by our team." });
  const auto = allFlags.length === 0;

  const row = {
    client_id: client.id,
    client: clientValue(client),
    submitted_by: caller.email,
    submitted_via: caller.isAdmin ? "internal" : "portal",
    client_token: token,
    notify_emails: clean.notify_emails,
    reference: clean.reference,
    order_ref: clean.order_ref,
    ship_from: clean.ship_from,
    items: clean.items,
    weight_lb: clean.weight_lb,
    length_in: clean.length_in, width_in: clean.width_in, height_in: clean.height_in,
    method: clean.method,
    pickup_date: clean.pickup_date, window_start: clean.window_start, window_end: clean.window_end,
    email_customer: clean.email_customer,
    disposition: clean.disposition, disposition_order_ref: clean.disposition_order_ref, disposition_notes: clean.disposition_notes,
    status: auto ? "processing" : "needs_review",
    review_reasons: allFlags.map(({ code, message, detail }) => ({ code, message, ...(detail ? { detail } : {}) })),
  };

  let request;
  try {
    request = (await sb("pickup_requests", { method: "POST", body: row, prefer: "return=representation" }))[0];
  } catch (e) {
    if (token && (e.status === 409 || (e.pg && e.pg.code === "23505"))) {
      const prev = await sb(`pickup_requests?client_id=eq.${client.id}&client_token=eq.${token}&select=*&limit=1`);
      if (prev && prev[0]) return json({ ok: true, duplicate_submit: true, request: publicRequest(prev[0]) });
    }
    throw e;
  }

  if (!auto) {
    await Promise.all([
      notifyStaff(request, "Needs review", allFlags.map((f) => f.detail ? `${f.message} (${f.detail})` : f.message)),
      notifyClientReceived(request, allFlags.map((f) => f.message)),
    ]);
    return json({ ok: true, request: publicRequest(request) }, 201);
  }

  // AUTO: same core the warehouse uses — label + pickup + emails.
  const sf = clean.ship_from;
  const result = await createReturnLabel({
    client: request.client,
    client_id: client.id,
    carrier: "ups",
    ship_from: sf,
    weight_oz: Math.round(clean.weight_lb * 16 * 10) / 10,
    dims: { length: clean.length_in, width: clean.width_in, height: clean.height_in },
    service_code: "ups_ground",
    schedule_pickup: clean.method === "pickup",
    pickup_window: clean.method === "pickup"
      ? { start_at: `${clean.pickup_date}T${clean.window_start}:00`, end_at: `${clean.pickup_date}T${clean.window_end}:00` }
      : null,
    notes: requestNotes(request),
    pickup_request_id: request.id,
  }, {
    actor: `portal:${caller.email}`,
    contactEmail: caller.isAdmin ? (client.email || null) : caller.email,
  });

  const fresh = (await sb(`pickup_requests?id=eq.${request.id}&select=*&limit=1`))[0] || request;

  if (result.status !== 200) {
    // 409 (window/dims) or 502 (UPS refused): make sure it sits in review
    // and that both sides know.
    let r2 = fresh;
    if (fresh.status === "processing") {
      const reasons = Array.isArray(fresh.review_reasons) ? fresh.review_reasons : [];
      r2 = (await sb(`pickup_requests?id=eq.${request.id}`, {
        method: "PATCH", prefer: "return=representation",
        body: {
          status: "needs_review", return_label_id: null,
          last_error: (result.body && (result.body.message || result.body.detail || result.body.error)) || "label not created",
          review_reasons: [...reasons, { code: result.body && result.body.error === "label creation failed" ? "label_failed" : String((result.body && result.body.error) || "label_failed"),
            message: (result.body && result.body.message) || "The label could not be created automatically." }],
        },
      }))[0] || fresh;
    }
    await Promise.all([
      notifyStaff(r2, "Automatic label failed — needs review", [
        r2.last_error, result.body && result.body.detail ? String(result.body.detail).slice(0, 400) : null,
      ]),
      notifyClientReceived(r2, publicRequest(r2).review_reasons),
    ]);
    return json({ ok: true, request: publicRequest(r2) }, 201);
  }

  return json({ ok: true, request: publicRequest(fresh) }, 201);
}

// ─── POST: cancel (only before a label exists) ────────────────────────
async function handleCancel(caller, body) {
  const id = String((body && body.id) || "");
  if (!UUID_RE.test(id)) return json({ ok: false, error: "Invalid request id" }, 400);
  const who = await resolveClient(caller);
  const rows = await sb(`pickup_requests?id=eq.${id}&select=*&limit=1`);
  const r = rows && rows[0];
  if (!r || (!who.allClients && (!who.client || r.client_id !== who.client.id))) return json({ ok: false, error: "Request not found" }, 404);
  if (!publicRequest(r).can_cancel) {
    return json({ ok: false, error: "This request already has a label. Reply to the confirmation email or write to warehouse@fr-logistics.net to cancel it." }, 409);
  }
  const updated = (await sb(`pickup_requests?id=eq.${id}`, {
    method: "PATCH", prefer: "return=representation",
    body: { status: "cancelled", cancelled_at: new Date().toISOString(), cancelled_by: caller.email, cancel_reason: "Cancelled by the client" },
  }))[0];
  await notifyStaff(updated, "Cancelled by the client", []);
  return json({ ok: true, request: publicRequest(updated) });
}

// ─── Handler ───────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (!SUPABASE_URL || !SUPABASE_KEY) return json({ ok: false, error: "Server is not configured" }, 500);
  const url = new URL(req.url);
  let body = null;
  if (req.method === "POST") {
    try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid JSON body" }, 400); }
  }
  const caller = callerOf(req, url, body);
  if (caller.error) return json({ ok: false, error: caller.error[1], auth: "login_required" }, caller.error[0]);

  try {
    if (req.method === "GET") {
      if ((url.searchParams.get("action") || "") === "label") return await handleLabel(caller, url);
      return await handleList(caller);
    }
    if (req.method === "POST") {
      const action = String(body.action || "");
      if (action === "create") return await handleCreate(caller, body);
      if (action === "cancel") return await handleCancel(caller, body);
      return json({ ok: false, error: `Unknown action: ${action || "(none)"}` }, 400);
    }
    return json({ ok: false, error: "Method not allowed" }, 405);
  } catch (e) {
    console.error("[portal-pickup-requests]", e);
    return json({ ok: false, error: "Something went wrong on our side. Please try again or write to warehouse@fr-logistics.net." }, 500);
  }
}
