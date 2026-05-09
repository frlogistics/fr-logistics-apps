// netlify/functions/manifest-public.js
//
// FR-Logistics · Public Manifest Verification Page (Commit 4)
//
// Renders a standalone HTML page when someone visits /m/{token} —
// typically a MailAmericas driver scanning the QR on the printed manifest.
//
// Style: Netlify Functions v2 (ESM).
// Output: text/html (no JSON API here — full rendered page).
//
// URL pattern (configured in netlify.toml):
//   /m/{public_token}  →  /.netlify/functions/manifest-public?token={public_token}
//
// Decisions (per Jose, 2026-05-09):
//   - Public access, no auth required (token uniqueness = enough security)
//   - Show: manifest_id, sealed_at, carrier, count, status, outbound trackings,
//           content (resumen), sealed_by
//   - Hide: inbound trackings, client names, order_ids
//   - Track views (Opción B): every access logged via log_manifest_view RPC
//   - No digital signature (paper handoff is the legal evidence)

const SUPABASE_URL  = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY  = Netlify.env.get("SUPABASE_SERVICE_KEY");

const SB = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
});

// ─── Supabase helpers ────────────────────────────────────────────────
async function sbSelect(t, q = "") {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}${q}`, { headers: SB() });
  if (!r.ok) throw new Error(`sbSelect ${t}: ${r.status} ${(await r.text()).slice(0, 240)}`);
  return r.json();
}
async function sbRpc(fn, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: SB(),
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`sbRpc ${fn}: ${r.status} ${(await r.text()).slice(0, 240)}`);
  return r.json();
}

// ─── Escape helpers ──────────────────────────────────────────────────
function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function truncate(s, max) {
  if (!s) return "—";
  const str = String(s);
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}

// ─── Format date in Miami timezone ──────────────────────────────────
function formatMiamiDate(isoTs) {
  if (!isoTs) return "—";
  return new Date(isoTs).toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }) + " EST";
}
function formatMiamiDateShort(isoTs) {
  if (!isoTs) return "—";
  return new Date(isoTs).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ─── HTML response helper ────────────────────────────────────────────
function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Cache lightly so reloading a hundred times doesn't hammer the DB
      "Cache-Control": "public, max-age=30",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
    },
  });
}

// ─── Page: 404 not found ─────────────────────────────────────────────
function pageNotFound(token) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Manifest not found · FR-Logistics</title>
  ${baseStyles()}
</head>
<body>
  <div class="page">
    <div class="topbar">
      <div class="brand">FR-LOGISTICS</div>
      <div class="brand-sub">Manifest verification</div>
    </div>
    <main class="main">
      <div class="not-found-card">
        <div class="not-found-icon">🔍</div>
        <h1>Manifest not found</h1>
        <p>The token <code>${escapeHtml(token || "")}</code> doesn't match any manifest in our system.</p>
        <p class="hint">If you scanned this from a printed manifest, please verify the QR code is intact, or contact FR-Logistics directly.</p>
        <div class="contact-block">
          <div class="contact-line"><strong>FR-Logistics Miami</strong></div>
          <div class="contact-line">10893 NW 17th St, Unit 121, Miami, FL 33172</div>
          <div class="contact-line"><a href="mailto:josefuentes@fr-logistics.net">josefuentes@fr-logistics.net</a></div>
          <div class="contact-line"><a href="https://fr-logistics.net">fr-logistics.net</a></div>
        </div>
      </div>
    </main>
    ${baseFooter()}
  </div>
</body>
</html>`;
}

// ─── Page: 500 error ─────────────────────────────────────────────────
function pageError(msg) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Error · FR-Logistics Manifest</title>
  ${baseStyles()}
</head>
<body>
  <div class="page">
    <div class="topbar">
      <div class="brand">FR-LOGISTICS</div>
      <div class="brand-sub">Manifest verification</div>
    </div>
    <main class="main">
      <div class="not-found-card">
        <div class="not-found-icon">⚠️</div>
        <h1>Something went wrong</h1>
        <p>${escapeHtml(msg || "Unable to load this manifest right now.")}</p>
        <p class="hint">Please try again in a moment, or contact FR-Logistics if the issue persists.</p>
      </div>
    </main>
    ${baseFooter()}
  </div>
</body>
</html>`;
}

// ─── Page: manifest detail ───────────────────────────────────────────
function pageManifest({ manifest, packages }) {
  // Status pill
  const statusClass = `pill pill-${manifest.status}`;
  const statusLabel = manifest.status.toUpperCase();

  // Build packages table rows
  const pkgRows = packages.length === 0
    ? `<tr><td colspan="4" class="empty-row">No packages in this manifest.</td></tr>`
    : packages.map(p => `
      <tr>
        <td class="mono">${escapeHtml(p.outbound_tracking || "—")}</td>
        <td class="content-cell">${escapeHtml(truncate(p.content, 60))}</td>
        <td class="qty-cell">${p.qty_boxes || 1}</td>
        <td class="ts-cell">${formatMiamiDateShort(p.shipped_at)}</td>
      </tr>
    `).join("");

  // Action buttons (PDF/CSV download — public direct links)
  const downloadButtons = manifest.status !== "open" ? `
    <div class="action-row">
      <a href="/.netlify/functions/dropship-manifests?action=download_pdf&manifest_id=${encodeURIComponent(manifest.manifest_id)}"
         class="btn btn-primary"
         target="_blank"
         rel="noopener">📄 Download PDF</a>
      <a href="/.netlify/functions/dropship-manifests?action=download_csv&manifest_id=${encodeURIComponent(manifest.manifest_id)}"
         class="btn"
         target="_blank"
         rel="noopener">📊 Download CSV</a>
    </div>
  ` : `
    <div class="info-banner">
      <strong>This manifest is still open.</strong>
      Package list is preliminary and may change before pickup. Final PDF and CSV will be available once sealed by FR-Logistics operations.
    </div>
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Manifest ${escapeHtml(manifest.manifest_id)} · FR-Logistics</title>
  <meta name="robots" content="noindex,nofollow">
  ${baseStyles()}
</head>
<body>
  <div class="page">
    <div class="topbar">
      <div class="brand">FR-LOGISTICS</div>
      <div class="brand-sub">Manifest verification</div>
    </div>

    <main class="main">

      <!-- Header card with gradient -->
      <div class="hero-card">
        <div class="hero-icon">📦</div>
        <div class="hero-content">
          <div class="hero-pretitle">Outbound Shipping Manifest</div>
          <div class="hero-id mono">${escapeHtml(manifest.manifest_id)}</div>
          <div class="hero-sub">${escapeHtml(formatMiamiDate(manifest.sealed_at || manifest.created_at))}</div>
        </div>
        <div class="hero-status">
          <span class="${statusClass}">${escapeHtml(statusLabel)}</span>
        </div>
      </div>

      <!-- Stats grid -->
      <div class="stats-grid">
        <div class="stat-tile stat-green">
          <div class="stat-value">${manifest.package_count}</div>
          <div class="stat-label">PACKAGES</div>
        </div>
        <div class="stat-tile stat-orange">
          <div class="stat-value">1</div>
          <div class="stat-label">CARRIER</div>
        </div>
        <div class="stat-tile stat-blue">
          <div class="stat-value">${escapeHtml(manifest.outbound_carrier)}</div>
          <div class="stat-label">DESTINATION</div>
        </div>
      </div>

      <!-- Manifest details -->
      <div class="card">
        <div class="card-title">📋 Manifest Details</div>
        <table class="kv-table">
          <tr>
            <td class="kv-label">MANIFEST ID</td>
            <td class="kv-value mono"><strong>${escapeHtml(manifest.manifest_id)}</strong></td>
          </tr>
          <tr>
            <td class="kv-label">CARRIER</td>
            <td class="kv-value">${escapeHtml(manifest.outbound_carrier)}</td>
          </tr>
          <tr>
            <td class="kv-label">STATUS</td>
            <td class="kv-value"><span class="${statusClass}">${escapeHtml(statusLabel)}</span></td>
          </tr>
          ${manifest.sealed_at ? `
          <tr>
            <td class="kv-label">SEALED AT</td>
            <td class="kv-value">${escapeHtml(formatMiamiDate(manifest.sealed_at))}</td>
          </tr>
          <tr>
            <td class="kv-label">SEALED BY</td>
            <td class="kv-value">${escapeHtml(manifest.sealed_by || "—")}</td>
          </tr>
          ` : `
          <tr>
            <td class="kv-label">CREATED</td>
            <td class="kv-value">${escapeHtml(formatMiamiDate(manifest.created_at))}</td>
          </tr>
          `}
          <tr>
            <td class="kv-label">PACKAGES</td>
            <td class="kv-value"><strong>${manifest.package_count}</strong></td>
          </tr>
        </table>
      </div>

      ${downloadButtons}

      <!-- Packages table -->
      <div class="card">
        <div class="card-title">📦 Package List</div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>OUTBOUND TRACKING</th>
                <th>CONTENT</th>
                <th class="qty-cell">QTY</th>
                <th class="ts-cell">SHIPPED</th>
              </tr>
            </thead>
            <tbody>
              ${pkgRows}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Pickup instructions card -->
      <div class="card info-card">
        <div class="card-title">📋 Pickup Information</div>
        <ul class="info-list">
          <li>Pickup address: <strong>10893 NW 17th St, Unit 121, Miami, FL 33172</strong></li>
          <li>Operating hours: <strong>Mon–Fri, 9:00 AM – 5:00 PM EST</strong></li>
          <li>Please bring the printed manifest PDF for signature on pickup.</li>
          <li>Use the CSV file to import package data into your scanning system.</li>
          <li>Contact <a href="mailto:josefuentes@fr-logistics.net">josefuentes@fr-logistics.net</a> for any discrepancies.</li>
        </ul>
      </div>

    </main>

    ${baseFooter()}
  </div>
</body>
</html>`;
}

// ─── Shared CSS ───────────────────────────────────────────────────────
function baseStyles() {
  return `<style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --fr-navy: #0A2540;
      --fr-navy-2: #1B3A5B;
      --fr-teal: #00B4A6;
      --fr-teal-dark: #008F84;
      --fr-orange: #F97316;
      --bg: #f4f6f9;
      --card: #fff;
      --border: #e2e8f0;
      --text: #0F172A;
      --muted: #64748B;
      --shadow: 0 2px 8px rgba(0,0,0,.06);
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      min-height: 100vh;
    }
    .mono { font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; }

    .page { max-width: 760px; margin: 0 auto; padding: 0 16px 40px; }

    .topbar {
      background: var(--fr-navy);
      color: #fff;
      margin: 0 -16px;
      padding: 14px 24px;
      border-bottom: 3px solid var(--fr-teal);
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand {
      font-weight: 800;
      font-size: 16px;
      letter-spacing: 0.5px;
    }
    .brand-sub {
      color: rgba(255,255,255,0.75);
      font-size: 12px;
      font-weight: 500;
    }
    .brand-sub::before {
      content: "·";
      margin-right: 8px;
      color: rgba(255,255,255,0.5);
    }

    .main { padding-top: 24px; }

    /* Hero */
    .hero-card {
      background: linear-gradient(135deg, #0a2540 0%, #16a3b5 60%, #1fa463 100%);
      border-radius: 14px;
      padding: 24px 28px;
      margin-bottom: 20px;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 16px;
      box-shadow: var(--shadow);
    }
    .hero-icon { font-size: 36px; line-height: 1; }
    .hero-content { flex: 1; min-width: 0; }
    .hero-pretitle {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: rgba(255,255,255,0.8);
      margin-bottom: 4px;
    }
    .hero-id {
      font-size: 22px;
      font-weight: 800;
      margin-bottom: 4px;
      word-break: break-all;
    }
    .hero-sub {
      font-size: 13px;
      color: rgba(255,255,255,0.85);
      font-weight: 500;
    }
    .hero-status { flex-shrink: 0; }

    /* Stats grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      margin-bottom: 20px;
    }
    .stat-tile {
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 18px 12px;
      text-align: center;
    }
    .stat-green  { background: #e8f7ee; border-color: #bbe7c7; }
    .stat-orange { background: #fff7e8; border-color: #ffd789; }
    .stat-blue   { background: #eef2f7; border-color: #cbd5e1; }
    .stat-value {
      font-size: 28px;
      font-weight: 800;
      line-height: 1;
      margin-bottom: 6px;
      word-break: break-word;
    }
    .stat-green .stat-value  { color: #1fa463; }
    .stat-orange .stat-value { color: #d97706; font-size: 24px; }
    .stat-blue .stat-value   { color: #0a2540; font-size: 18px; }
    .stat-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.5px;
      color: var(--text);
    }

    /* Cards */
    .card {
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 22px 28px;
      margin-bottom: 16px;
      box-shadow: var(--shadow);
    }
    .card-title {
      font-size: 15px;
      font-weight: 800;
      color: var(--fr-navy);
      margin-bottom: 16px;
    }

    .info-card {
      background: #fafbfc;
      border-color: #e2e8f0;
    }
    .info-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .info-list li {
      padding: 6px 0;
      font-size: 13px;
      color: var(--text);
      line-height: 1.6;
      padding-left: 18px;
      position: relative;
    }
    .info-list li::before {
      content: "·";
      position: absolute;
      left: 6px;
      color: var(--fr-teal);
      font-weight: 700;
      font-size: 18px;
      line-height: 1;
    }
    .info-list a { color: var(--fr-teal-dark); }

    /* Banner */
    .info-banner {
      background: #fff7ed;
      border: 1px solid #fed7aa;
      border-radius: 10px;
      padding: 14px 18px;
      font-size: 13.5px;
      color: #9a3412;
      margin-bottom: 16px;
      line-height: 1.5;
    }

    /* Action buttons */
    .action-row {
      display: flex;
      gap: 10px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    .btn {
      background: #fff;
      border: 1px solid var(--border);
      padding: 11px 20px;
      border-radius: 8px;
      font-size: 13.5px;
      font-weight: 600;
      color: var(--text);
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      transition: all 0.15s;
    }
    .btn:hover {
      border-color: var(--fr-teal);
      color: var(--fr-teal);
    }
    .btn-primary {
      background: var(--fr-teal);
      color: #fff;
      border-color: var(--fr-teal);
    }
    .btn-primary:hover {
      background: var(--fr-teal-dark);
      border-color: var(--fr-teal-dark);
      color: #fff;
    }

    /* KV table */
    .kv-table {
      width: 100%;
      border-collapse: collapse;
    }
    .kv-table tr { border-bottom: 1px solid var(--border); }
    .kv-table tr:last-child { border-bottom: none; }
    .kv-label {
      padding: 10px 0;
      font-size: 11px;
      font-weight: 700;
      color: var(--muted);
      letter-spacing: 0.4px;
      width: 130px;
    }
    .kv-value {
      padding: 10px 0;
      font-size: 14px;
      color: var(--text);
    }

    /* Data table */
    .table-wrap {
      overflow-x: auto;
      margin: 0 -28px -22px;
    }
    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .data-table thead th {
      background: #f8fafc;
      text-align: left;
      padding: 10px 12px;
      font-size: 10.5px;
      font-weight: 700;
      color: var(--muted);
      letter-spacing: 0.5px;
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
    }
    .data-table tbody td {
      padding: 12px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    .data-table tbody tr:last-child td { border-bottom: none; }
    .data-table .qty-cell { text-align: center; width: 50px; }
    .data-table .ts-cell { text-align: right; color: var(--muted); font-size: 12px; width: 110px; }
    .content-cell { line-height: 1.4; }
    .empty-row { text-align: center; color: var(--muted); padding: 28px 12px !important; font-style: italic; }

    /* Status pills */
    .pill {
      display: inline-block;
      padding: 4px 11px;
      border-radius: 12px;
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.4px;
      white-space: nowrap;
    }
    .pill-open      { background: #dcfce7; color: #166534; }
    .pill-sealed    { background: #dbeafe; color: #1e40af; }
    .pill-released  { background: #ede9fe; color: #6d28d9; }
    .pill-void      { background: #fee2e2; color: #dc2626; }
    .pill-closed    { background: #f1f5f9; color: #475569; }

    /* Hero pill on dark gradient */
    .hero-card .pill {
      background: rgba(255,255,255,0.95);
      backdrop-filter: blur(8px);
    }

    /* Not-found / error card */
    .not-found-card {
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 40px 32px;
      text-align: center;
      box-shadow: var(--shadow);
      margin-top: 24px;
    }
    .not-found-icon {
      font-size: 48px;
      line-height: 1;
      margin-bottom: 16px;
      opacity: 0.7;
    }
    .not-found-card h1 {
      font-size: 22px;
      color: var(--fr-navy);
      margin-bottom: 14px;
      font-weight: 800;
    }
    .not-found-card p {
      font-size: 14px;
      color: var(--text);
      margin-bottom: 12px;
    }
    .not-found-card .hint {
      font-size: 13px;
      color: var(--muted);
    }
    .not-found-card code {
      font-family: ui-monospace, monospace;
      background: #f1f5f9;
      padding: 2px 8px;
      border-radius: 4px;
      color: var(--fr-navy);
      font-size: 12.5px;
    }
    .contact-block {
      margin-top: 28px;
      padding-top: 24px;
      border-top: 1px solid var(--border);
      font-size: 12.5px;
      color: var(--muted);
    }
    .contact-line {
      padding: 3px 0;
    }
    .contact-line a {
      color: var(--fr-teal-dark);
      text-decoration: none;
    }
    .contact-line a:hover { text-decoration: underline; }

    /* Footer */
    .footer {
      margin-top: 40px;
      padding: 20px 0;
      border-top: 1px solid var(--border);
      text-align: center;
      font-size: 11.5px;
      color: var(--muted);
    }
    .footer a {
      color: var(--fr-teal-dark);
      text-decoration: none;
    }
    .footer a:hover { text-decoration: underline; }

    /* Mobile responsive */
    @media (max-width: 640px) {
      .page { padding: 0 12px 32px; }
      .topbar { margin: 0 -12px; padding: 12px 16px; }
      .hero-card { padding: 20px; flex-wrap: wrap; }
      .hero-icon { font-size: 28px; }
      .hero-id { font-size: 18px; }
      .stats-grid { gap: 8px; }
      .stat-tile { padding: 14px 8px; }
      .stat-value { font-size: 22px; }
      .stat-orange .stat-value, .stat-blue .stat-value { font-size: 16px; }
      .card { padding: 18px 20px; }
      .table-wrap { margin: 0 -20px -18px; }
      .data-table .ts-cell { display: none; }
      .kv-label { width: 110px; font-size: 10px; }
      .kv-value { font-size: 13px; }
    }
  </style>`;
}

function baseFooter() {
  return `
    <footer class="footer">
      <div>FR-Logistics Miami · 10893 NW 17th St, Unit 121, Miami, FL 33172</div>
      <div style="margin-top:4px"><a href="https://fr-logistics.net">fr-logistics.net</a></div>
    </footer>
  `;
}

// ─── Get client IP from request ──────────────────────────────────────
function getClientIp(req) {
  const forwarded = req.headers.get("x-forwarded-for") || "";
  const ip = forwarded.split(",")[0].trim()
          || req.headers.get("x-nf-client-connection-ip")
          || req.headers.get("client-ip")
          || "";
  return ip || null;
}

// ─── Handler ─────────────────────────────────────────────────────────
export default async function handler(req) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return htmlResponse(pageError("Server is not configured. Please contact FR-Logistics."), 500);
  }

  const url    = new URL(req.url);
  const token  = (url.searchParams.get("token") || "").trim().toLowerCase();

  // Token format check — must be 8 alphanumeric (per generate_public_token RPC)
  if (!token || !/^[a-z0-9]{8}$/.test(token)) {
    return htmlResponse(pageNotFound(token), 404);
  }

  try {
    // Log the view + load manifest in one atomic RPC call
    const ip = getClientIp(req);
    const ua = req.headers.get("user-agent") || null;

    const result = await sbRpc("log_manifest_view", {
      p_token: token,
      p_ip:    ip,
      p_ua:    ua,
    });
    const rows = Array.isArray(result) ? result : [result];

    if (!rows.length || !rows[0]?.manifest_id) {
      return htmlResponse(pageNotFound(token), 404);
    }

    const manifestSummary = rows[0];

    // Load full manifest details (RPC only returns the safe subset we declared
    // in its return type; we need a couple more fields for the page render)
    const manifestRows = await sbSelect(
      "dropship_manifests",
      `?manifest_id=eq.${encodeURIComponent(manifestSummary.manifest_id)}&limit=1`
    );
    if (!manifestRows.length) {
      // Race: manifest deleted between RPC and select. Treat as not found.
      return htmlResponse(pageNotFound(token), 404);
    }
    const manifest = manifestRows[0];

    // Load packages — only the safe fields per Jose's decision matrix
    const packages = await sbSelect(
      "dropshipments",
      `?manifest_id=eq.${encodeURIComponent(manifest.manifest_id)}` +
        `&select=outbound_tracking,content,qty_boxes,shipped_at` +
        `&order=shipped_at.asc.nullslast`
    );

    return htmlResponse(pageManifest({ manifest, packages }), 200);

  } catch (e) {
    console.error("[manifest-public]", e);
    return htmlResponse(pageError("Unable to load this manifest."), 500);
  }
}
