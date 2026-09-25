// netlify/edge-functions/page-gate.js
// ─────────────────────────────────────────────────────────────────────────────
// Adds <script src="/fr-auth.js"></script> to every HTML page of
// apps.fr-logistics.net as it is served, so all 37 pages get the staff login
// without editing each file. fr-auth.js shows the sign-in screen when there is
// no session and attaches the token to every call to /.netlify/functions/*.
//
// The data itself is protected by auth-gate.js (functions answer 401/403
// without a staff session). This file is the page side: it gives people a
// login screen instead of a page full of errors.
//
// Pages that must stay public, or that carry their own login, are excluded
// below (emails.html has its own gate and token handling).
// ─────────────────────────────────────────────────────────────────────────────

const TAG = '<script src="/fr-auth.js"></script>';

export default async (request, context) => {
  const response = await context.next();
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/html")) return response;

  const html = await response.text();
  if (html.includes("/fr-auth.js")) {
    return new Response(html, { status: response.status, headers: response.headers });
  }

  // Right after the opening <head> (not <header>), so it runs before any page
  // script. Falls back to the very top of the document.
  const m = /<head(\s[^>]*)?>/i.exec(html);
  const out = m
    ? html.slice(0, m.index + m[0].length) + TAG + html.slice(m.index + m[0].length)
    : TAG + html;

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("Cache-Control", "no-cache");
  return new Response(out, { status: response.status, statusText: response.statusText, headers });
};

export const config = {
  path: "/*",
  excludedPath: [
    "/.netlify/*",   // functions — guarded by auth-gate.js
    "/fr-auth.js",
    "/emails.html",  // has its own login gate
    "/sw.js",
    "/manifest.json",
    "/*.js",
    "/*.json",
    "/*.png",
    "/*.jpg",
    "/*.svg",
    "/*.ico",
    "/*.css",
  ],
};
