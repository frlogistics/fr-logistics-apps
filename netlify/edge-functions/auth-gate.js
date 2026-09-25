// netlify/edge-functions/auth-gate.js
// ─────────────────────────────────────────────────────────────────────────────
// FR-Logistics — single access gate for EVERY Netlify Function on
// apps.fr-logistics.net. Replaces cors.js (same CORS behaviour, plus auth).
//
// WHY AT THE EDGE: there are ~100 functions and none of them checked who was
// calling. Fixing them one by one means 100 edits (and the GitHub web editor
// fails silently on replace). One gate in front of all of them covers the
// whole site with a single file, and new functions are protected by default.
//
// WHO GETS THROUGH (checked in this order):
//   1. OPTIONS preflight                        → always (CORS).
//   2. PUBLIC routes (webhooks, website chat,   → no login. Listed in
//      public manifest, SRJ app, EcoPack        isPublic() with the reason.
//      booking…)
//   3. INTERNAL calls between our own functions → Authorization: Bearer
//                                                 <SUPABASE_SERVICE_KEY>.
//   4. CLIENT PORTAL routes (portal-*)           → see CLIENT_PORTAL_ENFORCE.
//   5. Everything else = STAFF                   → a valid Supabase Auth
//      session whose email is in STAFF_EMAILS. Token from the Authorization
//      header (Bearer) or the fr_at cookie that /fr-auth.js keeps fresh.
//
// Client-portal users ALSO have Supabase Auth accounts, so "has a valid
// session" is not enough for staff routes — the allowlist is what keeps
// clients out. 401 = no/expired session, 403 = signed in but not allowed.
//
// No new environment variables (the site is at the 4 KB Lambda env limit).
// Token check uses the PUBLISHABLE key, which is public by design.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = "https://rijbschnchjiuggrhfrx.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_2iAxAlUmL5mzL_CXFDR4Mw_bSARmU90";

// Staff who can use the internal apps (portal, handheld, billing, CRM…).
const STAFF_EMAILS = new Set([
  "josefuentes@fr-logistics.net",
  "josefuentesjob@gmail.com",
  "warehouse@fr-logistics.net",
]);

// The one account the client-portal functions treat as admin (may view any
// client with ?as_client=<uuid>). Same constant the portal-* functions use.
const PORTAL_ADMIN_EMAIL = "warehouse@fr-logistics.net";

// PHASE 2 SWITCH. false = portal-* stay as they were (open, identity taken
// from ?portal_user=). true = a valid session is required and portal_user is
// FORCED to the signed-in email (clients can no longer read each other's
// data or pose as the admin). Turn on only AFTER the fr-logistics.net client
// portal sends the Authorization header on its API calls.
const CLIENT_PORTAL_ENFORCE = false;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function deny(status, error) {
  return new Response(JSON.stringify({ error, auth: status === 401 ? "login_required" : "forbidden" }), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// ── route classes ──────────────────────────────────────────────────────────
// Returns true when the request may pass without any login.
// `body` is the parsed JSON body for POSTs we had to inspect (else null).
function isPublic(fn, method, url, body) {
  switch (fn) {
    // Inbound webhooks: Meta and Calendly call these; each verifies its own
    // signature/verify-token inside the function.
    case "whatsapp-webhook":
    case "calendly-webhook":
    // Website chat widget on fr-logistics.net (rate-limited inside).
    case "web-chat":
    // Public manifest page /m/<token> (token checked inside).
    case "manifest-public":
    // Google Apps Script MXS_SheetSync.gs pulls this daily.
    case "mxs-sheet-data":
    // StrokeRunnerJourney iPhone app (separate product; not FR data).
    case "srj-home-data":
      return true;

    // TEMPORARY (phase 1b): called function-to-function without a token.
    // Remove from this list once the callers send the internal Bearer:
    //   inventory                    ← daily-ops-report, inventory-alert
    //   dropship-manifest-email      ← dropship-manifest(s)
    //   wa-agent-debounce-background ← whatsapp-webhook
    //   wa-leads-create              ← calendly-webhook
    case "inventory":
    case "dropship-manifest-email":
    case "wa-agent-debounce-background":
    case "wa-leads-create":
      return true;

    // Public price list shown on fr-logistics.net — only the DEFAULT card.
    case "billing-rates":
      return method === "GET" && (url.searchParams.get("client") || "").toUpperCase() === "DEFAULT";

    // Download links printed on the public manifest page.
    case "dropship-manifests":
      return method === "GET" && ["download_pdf", "download_csv"].includes(url.searchParams.get("action") || "");

    // EcoPack+ booking page on fr-logistics.net: see free slots and book.
    // Listing pickups (member names/phones) and changing status stay staff.
    case "ecopack":
      if (method === "GET") return url.searchParams.get("action") === "slots";
      if (method === "POST") return !!body && (body.action || body.status) === "book";
      return false;
  }
  return false;
}

// portal-* functions serve the client portal; these two are internal tools.
function isClientPortal(fn) {
  return fn.startsWith("portal-") && fn !== "portal-provision" && fn !== "portal-warehouse-orders";
}

// ── token handling ─────────────────────────────────────────────────────────
function readToken(request) {
  const auth = request.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (m) {
    const t = m[1].trim();
    // Pages that talk to Supabase directly sometimes send the anon/publishable
    // key as a bearer; that is not a user session.
    if (t && t !== SUPABASE_PUBLISHABLE_KEY && !t.startsWith("sb_publishable_")) return t;
  }
  const cookie = request.headers.get("cookie") || "";
  const c = /(?:^|;\s*)fr_at=([^;]+)/.exec(cookie);
  return c ? decodeURIComponent(c[1]) : null;
}

function serviceKey() {
  try { return Netlify.env.get("SUPABASE_SERVICE_KEY") || ""; } catch { return ""; }
}

// Small per-isolate cache so a page that fires 10 calls at once costs one
// lookup. Entries live 60 s; a revoked session stops working within a minute.
const CACHE = new Map();
const TTL_MS = 60 * 1000;

async function whoIs(token) {
  const hit = CACHE.get(token);
  if (hit && hit.exp > Date.now()) return hit.email;
  let email = null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
    });
    if (r.ok) {
      const u = await r.json();
      email = String((u && u.email) || "").toLowerCase() || null;
    }
  } catch {
    return undefined; // Supabase unreachable: don't cache, caller answers 503
  }
  if (CACHE.size > 500) CACHE.clear();
  CACHE.set(token, { exp: Date.now() + TTL_MS, email });
  return email;
}

// ── main ───────────────────────────────────────────────────────────────────
export default async (request, context) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Max-Age": "86400" } });
  }

  const url = new URL(request.url);
  const fn = (url.pathname.split("/")[3] || "").toLowerCase();

  // Nobody downstream may trust identity headers that came from outside.
  const headers = new Headers(request.headers);
  headers.delete("x-fr-user-email");
  headers.delete("x-fr-user-staff");

  // "Who am I?" for /fr-auth.js — answered here, no function involved.
  if (fn === "__whoami") {
    const token = readToken(request);
    const email = token ? await whoIs(token) : null;
    if (email === undefined) return deny(503, "Auth service unavailable");
    return new Response(JSON.stringify({ email, staff: !!email && STAFF_EMAILS.has(email) }), {
      status: email ? 200 : 401,
      headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  // Only a few POSTs need their body read to decide; read it once and
  // rebuild the request so the function still receives it.
  let bodyText = null;
  let body = null;
  const needsBody = request.method === "POST" && (fn === "ecopack" || (CLIENT_PORTAL_ENFORCE && isClientPortal(fn)));
  if (needsBody) {
    bodyText = await request.text();
    try { body = JSON.parse(bodyText || "{}"); } catch { body = null; }
  }
  // Bodies we did not read are streamed through untouched (photo uploads are
  // binary and can be large — never turn them into text).
  const forward = (u = url, h = headers, b = bodyText) => {
    const noBody = request.method === "GET" || request.method === "HEAD";
    const init = { method: request.method, headers: h, redirect: "manual" };
    if (!noBody) {
      if (b !== null) init.body = b;
      else if (request.body) { init.body = request.body; init.duplex = "half"; }
    }
    return new Request(u.toString(), init);
  };

  // 2. public
  if (isPublic(fn, request.method, url, body)) {
    return withCors(await context.next(forward()));
  }

  // 3. internal (function → function)
  const sk = serviceKey();
  const auth = (request.headers.get("authorization") || "").trim();
  if (sk && auth === `Bearer ${sk}`) {
    headers.set("x-fr-user-staff", "internal");
    return withCors(await context.next(forward()));
  }

  // 4. client portal
  if (isClientPortal(fn)) {
    if (!CLIENT_PORTAL_ENFORCE) return withCors(await context.next(forward()));

    const token = readToken(request);
    if (!token) return deny(401, "Not signed in");
    const email = await whoIs(token);
    if (email === undefined) return deny(503, "Auth service unavailable");
    if (!email) return deny(401, "Session expired — sign in again");

    const isAdmin = email === PORTAL_ADMIN_EMAIL;
    headers.set("x-fr-user-email", email);
    if (STAFF_EMAILS.has(email)) headers.set("x-fr-user-staff", "1");

    // Identity comes from the session, never from the request.
    const u = new URL(url.toString());
    u.searchParams.set("portal_user", email);
    if (!isAdmin) u.searchParams.delete("as_client");

    let b = bodyText;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      body.portal_user = email;
      if (!isAdmin) delete body.as_client;
      b = JSON.stringify(body);
      headers.delete("content-length");
    }
    return withCors(await context.next(forward(u, headers, b)));
  }

  // 5. staff
  const token = readToken(request);
  if (!token) return deny(401, "Not signed in");
  const email = await whoIs(token);
  if (email === undefined) return deny(503, "Auth service unavailable");
  if (!email) return deny(401, "Session expired — sign in again");
  if (!STAFF_EMAILS.has(email)) return deny(403, "This account is not authorized for FR-Logistics apps");

  headers.set("x-fr-user-email", email);
  headers.set("x-fr-user-staff", "1");
  return withCors(await context.next(forward(url, headers)));
};

export const config = { path: "/.netlify/functions/*" };
