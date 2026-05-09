// netlify/functions/dropship-manifest-email.js
//
// FR-Logistics · Outbound Manifest Email Handoff (Commit 3)
//
// Sends the sealed manifest to the carrier pickup contact.
// Visual style matches daily-ops-report.js (gradient header, white card sections,
// stat boxes). Attaches PDF + CSV from Netlify Blobs.
//
// POST endpoints (JSON body):
//   action=send       → send the manifest email (called automatically post-seal,
//                       or manually via the "Retry email" button on the UI)
//                       Body: { manifest_id, sent_by? }
//
//   action=preview    → render the email HTML without sending (UI preview)
//                       Body: { manifest_id }
//
// All email failures are non-fatal at the protocol level: they return a clear
// error JSON so the UI can surface "Retry email" without breaking the seal.

import { getStore } from "@netlify/blobs";

const SUPABASE_URL  = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY  = Netlify.env.get("SUPABASE_SERVICE_KEY");
const RESEND_KEY    = Netlify.env.get("RESEND_API_KEY");
const SITE_URL      = Netlify.env.get("URL") || "https://apps.fr-logistics.net";

const FROM_EMAIL    = "FR-Logistics Manifests <manifests@fr-logistics.net>";
const REPLY_TO      = "josefuentes@fr-logistics.net";

const SB = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
});

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};
const jRes = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: CORS });

// ─── Supabase helpers ────────────────────────────────────────────────
async function sbSelect(t, q = "") {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}${q}`, { headers: SB() });
  if (!r.ok) throw new Error(`sbSelect ${t}: ${r.status} ${(await r.text()).slice(0, 240)}`);
  return r.json();
}
async function sbPatch(t, f, d) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}?${f}`, {
    method: "PATCH",
    headers: { ...SB(), Prefer: "return=representation" },
    body: JSON.stringify(d),
  });
  if (!r.ok) throw new Error(`sbPatch ${t}: ${r.status} ${(await r.text()).slice(0, 240)}`);
  return r.json();
}

// ─── Build email HTML (matches daily-ops-report.js visual style) ─────
function buildEmailHtml({ manifest, packages, carrier, sealedDateLabel, publicUrl }) {
  // Group packages by client for summary
  const byClient = {};
  for (const p of packages) {
    const key = p.client_name || p.client_id || "Unknown";
    if (!byClient[key]) byClient[key] = 0;
    byClient[key] += 1;
  }
  const clientRows = Object.entries(byClient)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `
      <tr>
        <td style="padding:9px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#0f172a">${escapeHtml(name)}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:700;color:#16a3b5;font-size:13px">${count}</td>
      </tr>`).join("");

  const totalPkgs = packages.length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Manifest ${escapeHtml(manifest.manifest_id)}</title>
</head>
<body style="margin:0;padding:24px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#f1f5f9;color:#0f172a;line-height:1.5">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto">

  <!-- Gradient Header Card -->
  <tr><td style="padding-bottom:16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="background:linear-gradient(135deg,#0a2540 0%,#16a3b5 60%,#1fa463 100%);border-radius:14px;overflow:hidden">
      <tr><td style="padding:28px 32px">
        <div style="font-size:22px;font-weight:800;color:#fff;letter-spacing:.2px;margin-bottom:6px">
          📦 FR-Logistics Manifest
        </div>
        <div style="font-size:14px;color:rgba(255,255,255,.92);font-weight:600">
          ${escapeHtml(sealedDateLabel)}
        </div>
        <div style="font-size:12px;color:rgba(255,255,255,.78);margin-top:4px">
          Warehouse WH01 · Doral, FL 33172
        </div>
      </td></tr>
    </table>
  </td></tr>

  <!-- Manifest Details Card -->
  <tr><td style="padding-bottom:16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="background:#fff;border-radius:14px;border:1px solid #e2e8f0">
      <tr><td style="padding:22px 28px">
        <div style="font-size:15px;font-weight:700;color:#0f172a;margin-bottom:14px">
          🚚 Manifest Details
        </div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="font-size:12px;color:#64748b;padding:6px 0;width:140px">MANIFEST ID</td>
            <td style="font-size:14px;color:#0f172a;font-weight:700;font-family:'SF Mono',Menlo,Consolas,monospace">${escapeHtml(manifest.manifest_id)}</td>
          </tr>
          <tr>
            <td style="font-size:12px;color:#64748b;padding:6px 0">CARRIER</td>
            <td style="font-size:14px;color:#0f172a;font-weight:600">${escapeHtml(manifest.outbound_carrier)}</td>
          </tr>
          <tr>
            <td style="font-size:12px;color:#64748b;padding:6px 0">SEALED AT</td>
            <td style="font-size:14px;color:#0f172a">${escapeHtml(sealedDateLabel)}</td>
          </tr>
          <tr>
            <td style="font-size:12px;color:#64748b;padding:6px 0">SEALED BY</td>
            <td style="font-size:14px;color:#0f172a">${escapeHtml(manifest.sealed_by || "—")}</td>
          </tr>
        </table>
      </td></tr>
    </table>
  </td></tr>

  <!-- Stats Card (matches daily-ops-report style) -->
  <tr><td style="padding-bottom:16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="background:#fff;border-radius:14px;border:1px solid #e2e8f0">
      <tr><td style="padding:22px 28px">
        <div style="font-size:15px;font-weight:700;color:#0f172a;margin-bottom:16px">
          📊 Packages Summary
        </div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="width:33.33%;padding-right:8px">
              <div style="background:#e8f7ee;border:1px solid #bbe7c7;border-radius:10px;padding:18px 12px;text-align:center">
                <div style="font-size:32px;font-weight:800;color:#1fa463;line-height:1;margin-bottom:6px">${totalPkgs}</div>
                <div style="font-size:11px;font-weight:700;color:#0f172a;letter-spacing:.5px">PACKAGES</div>
              </div>
            </td>
            <td style="width:33.33%;padding:0 4px">
              <div style="background:#fff7e8;border:1px solid #ffd789;border-radius:10px;padding:18px 12px;text-align:center">
                <div style="font-size:32px;font-weight:800;color:#d97706;line-height:1;margin-bottom:6px">${Object.keys(byClient).length}</div>
                <div style="font-size:11px;font-weight:700;color:#0f172a;letter-spacing:.5px">CLIENTS</div>
              </div>
            </td>
            <td style="width:33.33%;padding-left:8px">
              <div style="background:#eef2f7;border:1px solid #cbd5e1;border-radius:10px;padding:18px 12px;text-align:center">
                <div style="font-size:32px;font-weight:800;color:#0a2540;line-height:1;margin-bottom:6px">1</div>
                <div style="font-size:11px;font-weight:700;color:#0f172a;letter-spacing:.5px">CARRIER</div>
              </div>
            </td>
          </tr>
        </table>

        ${clientRows ? `
        <div style="margin-top:22px;font-size:13px;font-weight:700;color:#0f172a;margin-bottom:8px">By Client</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
          <tr>
            <td style="padding:9px 12px;background:#f8fafc;font-size:11px;font-weight:700;color:#64748b;letter-spacing:.4px">CLIENT</td>
            <td style="padding:9px 12px;background:#f8fafc;font-size:11px;font-weight:700;color:#64748b;text-align:right;letter-spacing:.4px">PACKAGES</td>
          </tr>
          ${clientRows}
        </table>
        ` : ""}
      </td></tr>
    </table>
  </td></tr>

  <!-- Verification Card with QR link -->
  <tr><td style="padding-bottom:16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="background:#fff;border-radius:14px;border:1px solid #e2e8f0">
      <tr><td style="padding:22px 28px">
        <div style="font-size:15px;font-weight:700;color:#0f172a;margin-bottom:10px">
          🔗 Live Manifest Verification
        </div>
        <p style="font-size:13px;color:#475569;margin:0 0 14px;line-height:1.6">
          Scan the QR code on the attached PDF or click the link below to view the live status of this manifest, including delivery confirmations as packages arrive.
        </p>
        <a href="${escapeHtml(publicUrl)}" style="display:inline-block;background:#16a3b5;color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:10px 22px;border-radius:8px">
          View Live Manifest →
        </a>
        <div style="margin-top:10px;font-size:11px;color:#94a3b8;font-family:'SF Mono',Menlo,Consolas,monospace">
          ${escapeHtml(publicUrl)}
        </div>
      </td></tr>
    </table>
  </td></tr>

  <!-- Pickup Instructions -->
  <tr><td style="padding-bottom:16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="background:#fff;border-radius:14px;border:1px solid #e2e8f0">
      <tr><td style="padding:22px 28px">
        <div style="font-size:15px;font-weight:700;color:#0f172a;margin-bottom:10px">
          📋 Pickup Instructions
        </div>
        <ul style="margin:0;padding-left:20px;font-size:13px;color:#475569;line-height:1.7">
          <li>Please print the attached PDF and bring it for signature on pickup.</li>
          <li>The CSV file contains all package details for your scanning system.</li>
          <li>Pickup address: <strong style="color:#0f172a">10893 NW 17th St, Unit 121, Miami, FL 33172</strong></li>
          <li>Operating hours: Mon–Fri, 9:00 AM – 5:00 PM EST</li>
          <li>Reply to this email with any discrepancies before signing.</li>
        </ul>
      </td></tr>
    </table>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:18px 8px 0;text-align:center">
    <div style="font-size:11px;color:#94a3b8;margin-bottom:4px">
      FR-Logistics Miami · 10893 NW 17th St, Unit 121, Miami, FL 33172
    </div>
    <div style="font-size:11px;color:#94a3b8">
      <a href="https://fr-logistics.net" style="color:#16a3b5;text-decoration:none">fr-logistics.net</a>
      &nbsp;·&nbsp;
      Reply to: <a href="mailto:${REPLY_TO}" style="color:#16a3b5;text-decoration:none">${REPLY_TO}</a>
    </div>
  </td></tr>

</table>

</body>
</html>`;
}

function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Plain-text fallback (matters for spam scoring + accessibility) ──
function buildEmailText({ manifest, packages, sealedDateLabel, publicUrl }) {
  const byClient = {};
  for (const p of packages) {
    const key = p.client_name || p.client_id || "Unknown";
    byClient[key] = (byClient[key] || 0) + 1;
  }
  const clientLines = Object.entries(byClient)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `  ${name}: ${count}`)
    .join("\n");

  return [
    `FR-LOGISTICS MANIFEST — ${sealedDateLabel}`,
    `Warehouse WH01 · Doral, FL 33172`,
    ``,
    `MANIFEST ID:  ${manifest.manifest_id}`,
    `CARRIER:      ${manifest.outbound_carrier}`,
    `SEALED AT:    ${sealedDateLabel}`,
    `SEALED BY:    ${manifest.sealed_by || "—"}`,
    `PACKAGES:     ${packages.length}`,
    ``,
    `BY CLIENT:`,
    clientLines || "  (none)",
    ``,
    `LIVE VERIFICATION: ${publicUrl}`,
    ``,
    `PICKUP INSTRUCTIONS:`,
    `  - Please print the attached PDF for signature on pickup.`,
    `  - The CSV file contains all package details.`,
    `  - Address: 10893 NW 17th St, Unit 121, Miami, FL 33172`,
    `  - Hours: Mon-Fri, 9:00 AM - 5:00 PM EST`,
    `  - Reply to this email with discrepancies before signing.`,
    ``,
    `FR-Logistics Miami · fr-logistics.net`,
    `Reply to: ${REPLY_TO}`,
  ].join("\n");
}

// ─── Format date in Miami timezone ────────────────────────────────────
function formatSealedDate(isoTs) {
  const d = isoTs ? new Date(isoTs) : new Date();
  return d.toLocaleString("en-US", {
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

// ─── Load manifest + packages + carrier pickup contact ────────────────
async function loadManifestContext(manifest_id) {
  const manifestRows = await sbSelect(
    "dropship_manifests",
    `?manifest_id=eq.${encodeURIComponent(manifest_id)}&limit=1`
  );
  if (!manifestRows.length) {
    const err = new Error("manifest not found");
    err.status = 404;
    throw err;
  }
  const manifest = manifestRows[0];

  if (manifest.status === "open") {
    const err = new Error("cannot send email for an open manifest — seal it first");
    err.status = 409;
    throw err;
  }

  const packages = await sbSelect(
    "dropshipments",
    `?manifest_id=eq.${encodeURIComponent(manifest_id)}` +
      `&select=id,tracking_number,outbound_tracking,client_id,content,qty_boxes,order_id,shipped_at,shipped_by` +
      `&order=shipped_at.asc.nullslast`
  );

  // Resolve client display names
  const clientIds = [...new Set(packages.map(p => p.client_id).filter(Boolean))];
  let clientNamesById = {};
  if (clientIds.length) {
    const idsList = clientIds.map(encodeURIComponent).join(",");
    const cfgs = await sbSelect(
      "dropship_client_configs",
      `?client_id=in.(${idsList})&select=client_id,display_name`
    );
    clientNamesById = Object.fromEntries(cfgs.map(c => [c.client_id, c.display_name]));
  }
  for (const p of packages) {
    p.client_name = clientNamesById[p.client_id] || "Unknown";
  }

  // Resolve carrier pickup_email
  const carrierRows = await sbSelect(
    "outbound_carriers",
    `?name=eq.${encodeURIComponent(manifest.outbound_carrier)}&select=name,pickup_email&limit=1`
  );
  const pickupEmail = carrierRows[0]?.pickup_email || "warehouse@fr-logistics.net";

  return { manifest, packages, pickupEmail };
}

// ─── Load PDF + CSV from Netlify Blobs ────────────────────────────────
async function loadAttachments(manifest_id) {
  const store = getStore({ name: "fr-manifests", consistency: "strong" });
  const pdfKey = `${manifest_id}.pdf`;
  const csvKey = `${manifest_id}.csv`;

  const [pdfBuf, csvBuf] = await Promise.all([
    store.get(pdfKey, { type: "arrayBuffer" }),
    store.get(csvKey, { type: "arrayBuffer" }),
  ]);

  if (!pdfBuf) throw new Error(`PDF not found in fr-manifests store for ${manifest_id}`);
  if (!csvBuf) throw new Error(`CSV not found in fr-manifests store for ${manifest_id}`);

  // Resend expects base64 strings for attachments
  const toB64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  };

  return {
    pdf_base64: toB64(pdfBuf),
    csv_base64: toB64(csvBuf),
  };
}

// ─── Action: send (the main one) ──────────────────────────────────────
async function actionSend(body) {
  const manifest_id = (body.manifest_id || "").trim();
  if (!manifest_id) return jRes({ error: "manifest_id required" }, 400);

  if (!RESEND_KEY) {
    return jRes({ error: "RESEND_API_KEY not configured" }, 500);
  }

  // 1) Load context
  let manifest, packages, pickupEmail;
  try {
    const ctx = await loadManifestContext(manifest_id);
    ({ manifest, packages, pickupEmail } = ctx);
  } catch (e) {
    return jRes({ error: e.message }, e.status || 500);
  }

  if (!packages.length) {
    return jRes({ error: "manifest has no packages — nothing to send" }, 409);
  }

  // 2) Load attachments
  let attachments;
  try {
    attachments = await loadAttachments(manifest_id);
  } catch (e) {
    return jRes({
      error: "manifest artifacts not found in storage",
      detail: e.message,
      hint: "ensure the manifest was sealed correctly (PDF + CSV should be in fr-manifests store)",
    }, 500);
  }

  // 3) Build email
  const sealedDateLabel = formatSealedDate(manifest.sealed_at);
  const publicUrl       = `${SITE_URL}/m/${manifest.public_token}`;
  const html            = buildEmailHtml({ manifest, packages, sealedDateLabel, publicUrl });
  const text            = buildEmailText({ manifest, packages, sealedDateLabel, publicUrl });
  const subject         = `Manifest ${manifest.manifest_id} — ${packages.length} package${packages.length === 1 ? "" : "s"} — Pickup ready`;

  // 4) Send via Resend
  const resendBody = {
    from:     FROM_EMAIL,
    to:       [pickupEmail],
    reply_to: REPLY_TO,
    subject,
    html,
    text,
    attachments: [
      {
        filename: `${manifest.manifest_id}.pdf`,
        content:  attachments.pdf_base64,
      },
      {
        filename: `${manifest.manifest_id}.csv`,
        content:  attachments.csv_base64,
      },
    ],
  };

  const resendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(resendBody),
  });
  const resendData = await resendRes.json().catch(() => ({}));

  if (!resendRes.ok) {
    console.error("[manifest-email] Resend error:", resendRes.status, resendData);
    return jRes({
      error: "email provider rejected the message",
      detail: resendData,
      status: resendRes.status,
    }, 502);
  }

  // 5) Persist email log on the manifest row
  try {
    await sbPatch("dropship_manifests", `manifest_id=eq.${encodeURIComponent(manifest_id)}`, {
      email_sent_at:        new Date().toISOString(),
      email_sent_to:        pickupEmail,
      email_message_id:     resendData.id || null,
    });
  } catch (e) {
    console.error("[manifest-email] failed to persist email log (non-fatal):", e.message);
  }

  return jRes({
    ok:           true,
    manifest_id,
    sent_to:      pickupEmail,
    message_id:   resendData.id,
    package_count: packages.length,
  });
}

// ─── Action: preview (for the UI to show what will be sent) ───────────
async function actionPreview(body) {
  const manifest_id = (body.manifest_id || "").trim();
  if (!manifest_id) return jRes({ error: "manifest_id required" }, 400);

  let ctx;
  try {
    ctx = await loadManifestContext(manifest_id);
  } catch (e) {
    return jRes({ error: e.message }, e.status || 500);
  }

  const sealedDateLabel = formatSealedDate(ctx.manifest.sealed_at);
  const publicUrl       = `${SITE_URL}/m/${ctx.manifest.public_token}`;
  const html            = buildEmailHtml({
    manifest:        ctx.manifest,
    packages:        ctx.packages,
    sealedDateLabel,
    publicUrl,
  });

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ─── Handler ─────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return jRes({ error: "server misconfigured: SUPABASE env vars missing" }, 500);
  }

  if (req.method !== "POST") {
    return jRes({ error: "method not allowed (POST only)" }, 405);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const act  = body.action || "";

    if (act === "send")    return await actionSend(body);
    if (act === "preview") return await actionPreview(body);
    return jRes({ error: `unknown action: ${act || "(none)"}` }, 400);
  } catch (e) {
    console.error("[dropship-manifest-email]", e);
    return jRes({ error: e.message || "internal error" }, 500);
  }
}
