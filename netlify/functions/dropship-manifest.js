// netlify/functions/dropship-manifests.js
//
// FR-Logistics · Outbound Manifest API (v2 — Commit 2)
//
// Style: Netlify Functions v2 (ESM). Matches dropshipments.js pattern exactly.
// Storage: Supabase Postgres + Netlify Blobs (fr-manifests store) + Resend SMTP.
//
// GET endpoints:
//   ?action=list[&carrier=...&status=...&limit=50]
//   ?action=get&manifest_id=MAN-...
//   ?action=current_open&carrier=MailAmericas
//   ?action=download_pdf&manifest_id=MAN-...
//   ?action=download_csv&manifest_id=MAN-...
//
// POST endpoints (JSON body):
//   action=auto_assign     → assign a shipped package to the open manifest
//                            Body: { tracking_number, outbound_carrier, operator }
//                            Internal-use: called by dropshipments.js after ship.
//
//   action=seal            → seal the open manifest, generate PDF + CSV,
//                            upload to Netlify Blobs, open a fresh empty manifest.
//                            Body: { manifest_id, sealed_by }
//                            Returns: { sealed_manifest_id, pdf_url, csv_url, package_count, next_open }

import { getStore }      from "@netlify/blobs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import QRCode             from "qrcode";

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY");

// Public-facing base URL for the QR code link (commit 4 will serve /m/{token}).
const PUBLIC_BASE_URL = Netlify.env.get("PUBLIC_BASE_URL") || "https://apps.fr-logistics.net";
// Site URL used for internal function-to-function calls (e.g. seal → email).
const SITE_URL = Netlify.env.get("URL") || PUBLIC_BASE_URL;

const SB = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
});

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
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
async function sbRpc(fn, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: SB(),
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`sbRpc ${fn}: ${r.status} ${(await r.text()).slice(0, 240)}`);
  return r.json();
}

// ─── Action: list manifests ──────────────────────────────────────────
async function actionList(url) {
  const carrier = url.searchParams.get("carrier") || "";
  const status  = url.searchParams.get("status")  || "";
  const limit   = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);

  const filters = [];
  if (carrier) filters.push(`outbound_carrier=eq.${encodeURIComponent(carrier)}`);
  if (status)  filters.push(`status=eq.${encodeURIComponent(status)}`);

  const qs = [
    "select=manifest_id,outbound_carrier,status,package_count,created_at,sealed_at,sealed_by,released_at,released_by,pdf_url,csv_url,email_sent_at,email_sent_to,public_token",
    "order=created_at.desc",
    `limit=${limit}`,
    ...filters,
  ].join("&");

  const rows = await sbSelect("dropship_manifests", "?" + qs);
  return jRes({ manifests: rows });
}

// ─── Action: get manifest by manifest_id, with packages ──────────────
async function actionGet(url) {
  const manifest_id = url.searchParams.get("manifest_id");
  if (!manifest_id) return jRes({ error: "manifest_id required" }, 400);

  const manifestRows = await sbSelect(
    "dropship_manifests",
    `?manifest_id=eq.${encodeURIComponent(manifest_id)}&limit=1`
  );
  if (!manifestRows.length) return jRes({ error: "manifest not found" }, 404);
  const manifest = manifestRows[0];

  const packages = await sbSelect(
    "dropshipments",
    `?manifest_id=eq.${encodeURIComponent(manifest_id)}` +
      `&select=id,tracking_number,carrier,outbound_carrier,outbound_platform,outbound_tracking,client_id,content,qty_boxes,order_id,status,physical_received_at,shipped_at,received_by,shipped_by` +
      `&order=shipped_at.desc.nullslast`
  );
  return jRes({ manifest, packages });
}

// ─── Action: current open manifest for a given carrier ───────────────
async function actionCurrentOpen(url) {
  const carrier = url.searchParams.get("carrier");
  if (!carrier) return jRes({ error: "carrier required" }, 400);

  const rows = await sbSelect(
    "dropship_manifests",
    `?outbound_carrier=eq.${encodeURIComponent(carrier)}&status=eq.open&limit=1`
  );
  if (!rows.length) return jRes({ manifest: null, packages: [] });

  const manifest = rows[0];
  const packages = await sbSelect(
    "dropshipments",
    `?manifest_id=eq.${encodeURIComponent(manifest.manifest_id)}` +
      `&select=id,tracking_number,carrier,outbound_carrier,outbound_platform,outbound_tracking,client_id,content,qty_boxes,order_id,status,shipped_at,shipped_by` +
      `&order=shipped_at.desc.nullslast`
  );
  return jRes({ manifest, packages });
}

// ─── Action: auto_assign (called from dropshipments.js after ship) ──
// Body: { tracking_number, outbound_carrier, operator }
// Returns: { manifest_id, package_count, was_created }
async function actionAutoAssign(body) {
  const tracking = (body.tracking_number || "").trim();
  const carrier  = (body.outbound_carrier || "").trim();
  const operator = (body.operator || "system").trim().slice(0, 60);

  if (!tracking) return jRes({ error: "tracking_number required" }, 400);
  if (!carrier)  return jRes({ error: "outbound_carrier required" }, 400);

  // 1) Find the dropshipments row by inbound tracking_number
  const rows = await sbSelect(
    "dropshipments",
    `?tracking_number=eq.${encodeURIComponent(tracking)}&select=id,manifest_id,status,outbound_carrier&limit=1`
  );
  if (!rows.length) return jRes({ error: "package not found", tracking_number: tracking }, 404);

  const pkg = rows[0];
  if (pkg.status !== "shipped") {
    return jRes({
      error: `package is not in shipped status (current: ${pkg.status})`,
      hint: "auto_assign should only be called from the ship action",
    }, 409);
  }

  // 2) Idempotency: if already assigned, return current state
  if (pkg.manifest_id) {
    return jRes({
      ok: true,
      already_assigned: true,
      manifest_id: pkg.manifest_id,
      package_id: pkg.id,
    });
  }

  // 3) Get or create the open manifest for this carrier
  const result = await sbRpc("get_or_create_open_manifest", {
    p_carrier:  carrier,
    p_operator: operator,
  });
  const manifest = Array.isArray(result) ? result[0] : result;
  if (!manifest || !manifest.manifest_id) {
    return jRes({ error: "failed to get or create open manifest" }, 500);
  }

  // 4) Assign the package + increment count
  await sbPatch("dropshipments", `id=eq.${pkg.id}`, { manifest_id: manifest.manifest_id });
  await sbRpc("manifest_increment_count", { p_manifest_id: manifest.manifest_id });

  return jRes({
    ok: true,
    manifest_id:    manifest.manifest_id,
    was_created:    manifest.was_created,
    public_token:   manifest.public_token,
    package_id:     pkg.id,
  });
}

// ─── PDF generation ──────────────────────────────────────────────────
async function generateManifestPdf(manifest, packages, clientNamesById) {
  const pdf      = await PDFDocument.create();
  pdf.setTitle(`Manifest ${manifest.manifest_id}`);
  pdf.setAuthor("FR-Logistics Miami");
  pdf.setCreator("apps.fr-logistics.net");

  const page     = pdf.addPage([612, 792]); // Letter portrait
  const fontReg  = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const fontMono = await pdf.embedFont(StandardFonts.Courier);

  const NAVY  = rgb(0.039, 0.145, 0.251);
  const TEAL  = rgb(0.000, 0.706, 0.651);
  const TEXT  = rgb(0.059, 0.090, 0.165);
  const MUTE  = rgb(0.392, 0.455, 0.545);
  const RULE  = rgb(0.886, 0.910, 0.941);

  // Header
  page.drawText("FR-LOGISTICS MIAMI", { x: 40, y: 750, size: 14, font: fontBold, color: NAVY });
  page.drawText("Outbound Shipping Manifest", { x: 40, y: 732, size: 10, font: fontReg, color: MUTE });
  page.drawLine({ start: { x: 40, y: 720 }, end: { x: 572, y: 720 }, thickness: 1.5, color: TEAL });

  // QR code (top-right)
  const publicUrl = `${PUBLIC_BASE_URL}/m/${manifest.public_token}`;
  const qrPngBytes = await QRCode.toBuffer(publicUrl, {
    type: "png",
    margin: 1,
    width: 220,
    color: { dark: "#0A2540", light: "#FFFFFF" },
  });
  const qrImg = await pdf.embedPng(qrPngBytes);
  const qrSize = 90;
  page.drawImage(qrImg, { x: 572 - qrSize, y: 750 - qrSize + 10, width: qrSize, height: qrSize });
  page.drawText(`/m/${manifest.public_token}`, {
    x: 572 - qrSize, y: 750 - qrSize - 2, size: 7, font: fontMono, color: MUTE,
  });

  // Manifest header block
  let y = 690;
  const drawKv = (label, val, bold = false) => {
    page.drawText(label, { x: 40,  y, size: 8.5, font: fontReg,  color: MUTE });
    page.drawText(val,   { x: 130, y, size: 10,  font: bold ? fontBold : fontReg, color: TEXT });
    y -= 16;
  };
  drawKv("MANIFEST ID",  manifest.manifest_id, true);
  drawKv("CARRIER",      manifest.outbound_carrier);
  drawKv("PACKAGES",     String(manifest.package_count));
  drawKv("SEALED AT",    new Date(manifest.sealed_at || Date.now()).toLocaleString("en-US", { timeZone: "America/New_York" }) + " (Miami)");
  drawKv("SEALED BY",    manifest.sealed_by || "—");

  // Table header
  y -= 8;
  page.drawLine({ start: { x: 40, y }, end: { x: 572, y }, thickness: 0.5, color: RULE });
  y -= 14;
  const cols = [
    { x: 40,  w: 100, lbl: "OUTBOUND" },
    { x: 145, w: 110, lbl: "INBOUND" },
    { x: 260, w: 70,  lbl: "ORDER #" },
    { x: 335, w: 195, lbl: "CONTENT" },
    { x: 535, w: 35,  lbl: "QTY" },
  ];
  for (const c of cols) {
    page.drawText(c.lbl, { x: c.x, y, size: 8, font: fontBold, color: MUTE });
  }
  y -= 6;
  page.drawLine({ start: { x: 40, y }, end: { x: 572, y }, thickness: 0.5, color: RULE });

  // Rows
  const truncate = (s, max) => {
    if (!s) return "—";
    const str = String(s);
    return str.length <= max ? str : str.slice(0, max - 1) + "…";
  };

  y -= 14;
  for (const p of packages) {
    if (y < 110) {
      page.drawText(`… ${packages.length - packages.indexOf(p)} more package(s) — see CSV`, {
        x: 40, y, size: 8, font: fontReg, color: MUTE,
      });
      break;
    }
    page.drawText(truncate(p.outbound_tracking, 16), { x: 40,  y, size: 8.5, font: fontMono, color: TEXT });
    page.drawText(truncate(p.tracking_number,   16), { x: 145, y, size: 8.5, font: fontMono, color: TEXT });
    page.drawText(truncate(p.order_id,           14), { x: 260, y, size: 8.5, font: fontMono, color: TEXT });
    page.drawText(truncate(p.content,            34), { x: 335, y, size: 8.5, font: fontReg,  color: TEXT });
    page.drawText(String(p.qty_boxes || 1),          { x: 540, y, size: 8.5, font: fontReg,  color: TEXT });
    y -= 12;
  }

  // Signature block
  page.drawLine({ start: { x: 40, y: 100 }, end: { x: 572, y: 100 }, thickness: 0.5, color: RULE });
  page.drawText("Released by FR-Logistics", { x: 40, y: 84, size: 8, font: fontBold, color: NAVY });
  page.drawText(`Operator: ${manifest.sealed_by || "—"}`, { x: 40, y: 70, size: 9, font: fontReg, color: TEXT });
  page.drawText("Signature: _______________________", { x: 40, y: 50, size: 9, font: fontReg, color: MUTE });

  page.drawText(`Received by ${manifest.outbound_carrier}`, { x: 320, y: 84, size: 8, font: fontBold, color: NAVY });
  page.drawText("Driver: _______________________", { x: 320, y: 70, size: 9, font: fontReg, color: MUTE });
  page.drawText("Signature: _______________________", { x: 320, y: 50, size: 9, font: fontReg, color: MUTE });

  page.drawText(`${manifest.manifest_id} · page 1 of 1 · scan QR for live status`, {
    x: 40, y: 28, size: 7, font: fontReg, color: MUTE,
  });

  return await pdf.save();
}

// ─── CSV generation ──────────────────────────────────────────────────
function generateManifestCsv(manifest, packages, clientNamesById) {
  const headers = [
    "manifest_id", "manifest_date", "dropshipment_id",
    "inbound_tracking", "inbound_carrier",
    "outbound_tracking", "outbound_carrier", "outbound_platform",
    "client_id", "client_name",
    "content", "qty_boxes", "order_id",
    "shipped_by", "shipped_at"
  ];
  const escape = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const rows = [headers.join(",")];
  const sealedDate = (manifest.sealed_at || new Date().toISOString()).slice(0, 10);
  for (const p of packages) {
    rows.push([
      manifest.manifest_id,
      sealedDate,
      p.id || "",
      p.tracking_number || "",
      p.carrier || "",
      p.outbound_tracking || "",
      p.outbound_carrier || "",
      p.outbound_platform || "",
      p.client_id || "",
      clientNamesById?.[p.client_id] || "",
      p.content || "",
      p.qty_boxes || 1,
      p.order_id || "",
      p.shipped_by || "",
      p.shipped_at || "",
    ].map(escape).join(","));
  }
  return rows.join("\n");
}

// ─── Action: seal ────────────────────────────────────────────────────
async function actionSeal(body) {
  const manifest_id = (body.manifest_id || "").trim();
  const sealed_by   = (body.sealed_by   || "").trim().slice(0, 60) || "warehouse";
  if (!manifest_id) return jRes({ error: "manifest_id required" }, 400);

  // 1) Atomic seal
  let sealResult;
  try {
    const r = await sbRpc("seal_manifest", { p_manifest_id: manifest_id, p_sealed_by: sealed_by });
    sealResult = Array.isArray(r) ? r[0] : r;
  } catch (e) {
    const msg = e.message || String(e);
    if (msg.includes("cannot seal an empty manifest")) {
      return jRes({ error: "cannot seal an empty manifest", detail: msg }, 409);
    }
    if (msg.includes("not open") || msg.includes("already sealed")) {
      return jRes({ error: "manifest is not open (already sealed?)", detail: msg }, 409);
    }
    if (msg.includes("manifest not found")) {
      return jRes({ error: "manifest not found", detail: msg }, 404);
    }
    throw e;
  }

  // 2) Reload manifest (now sealed) + packages
  const manifestRows = await sbSelect(
    "dropship_manifests",
    `?manifest_id=eq.${encodeURIComponent(manifest_id)}&limit=1`
  );
  const manifest = manifestRows[0];

  const packages = await sbSelect(
    "dropshipments",
    `?manifest_id=eq.${encodeURIComponent(manifest_id)}` +
      `&select=id,tracking_number,carrier,outbound_carrier,outbound_platform,outbound_tracking,client_id,content,qty_boxes,order_id,shipped_at,shipped_by` +
      `&order=shipped_at.asc.nullslast`
  );

  // Pull client display names for the CSV
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

  // 3) Build artifacts
  let pdfBytes, csvText;
  try {
    pdfBytes = await generateManifestPdf(manifest, packages, clientNamesById);
    csvText  = generateManifestCsv(manifest, packages, clientNamesById);
  } catch (e) {
    console.error("[manifests.seal] artifact generation failed:", e);
    return jRes({
      error: "manifest sealed but artifacts failed to generate",
      detail: e.message,
      sealed_manifest_id: manifest_id,
    }, 500);
  }

  // 4) Upload to Netlify Blobs
  const store  = getStore({ name: "fr-manifests", consistency: "strong" });
  const pdfKey = `${manifest_id}.pdf`;
  const csvKey = `${manifest_id}.csv`;
  await store.set(pdfKey, pdfBytes,                               { metadata: { manifest_id, type: "pdf" } });
  await store.set(csvKey, new TextEncoder().encode(csvText),       { metadata: { manifest_id, type: "csv" } });

  const pdfUrl = `/.netlify/functions/dropship-manifests?action=download_pdf&manifest_id=${encodeURIComponent(manifest_id)}`;
  const csvUrl = `/.netlify/functions/dropship-manifests?action=download_csv&manifest_id=${encodeURIComponent(manifest_id)}`;

  // 5) Persist URLs on the sealed manifest
  await sbPatch("dropship_manifests", `manifest_id=eq.${encodeURIComponent(manifest_id)}`, {
    pdf_url: pdfUrl,
    csv_url: csvUrl,
  });

  // 6) Auto-send the handoff email (Commit 3, mode A: automatic).
  // Non-fatal: if the email fails, the seal still succeeded and the UI
  // shows a "Retry email" button. We DON'T await this on the critical path
  // for too long — but we do await it because the UI wants the result.
  let emailResult = null;
  let emailError  = null;
  try {
    const emailRes = await fetch(`${SITE_URL}/.netlify/functions/dropship-manifest-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "send", manifest_id }),
    });
    const emailJson = await emailRes.json().catch(() => ({}));
    if (emailRes.ok) {
      emailResult = emailJson;
      console.log(`[manifests.seal] email sent to ${emailJson.sent_to} (id=${emailJson.message_id})`);
    } else {
      emailError = emailJson;
      console.error(`[manifests.seal] email send failed (non-fatal):`, emailRes.status, emailJson);
    }
  } catch (e) {
    emailError = { error: e.message || String(e) };
    console.error(`[manifests.seal] email send threw (non-fatal):`, e.message);
  }

  return jRes({
    ok: true,
    sealed_manifest_id:    manifest_id,
    sealed_at:             sealResult.sealed_at,
    package_count:         sealResult.package_count,
    public_token:          sealResult.public_token,
    pdf_url:               pdfUrl,
    csv_url:               csvUrl,
    next_open_manifest_id: sealResult.next_open_manifest_id,
    next_open_token:       sealResult.next_open_token,
    email:                 emailResult ? { ok: true, ...emailResult } : { ok: false, error: emailError },
  });
}

// ─── Download PDF / CSV from Netlify Blobs ───────────────────────────
async function actionDownload(url, kind) {
  const manifest_id = url.searchParams.get("manifest_id");
  if (!manifest_id) return jRes({ error: "manifest_id required" }, 400);

  const store = getStore({ name: "fr-manifests", consistency: "strong" });
  const key   = `${manifest_id}.${kind === "pdf" ? "pdf" : "csv"}`;

  const blob = await store.get(key, { type: "arrayBuffer" });
  if (!blob) return jRes({ error: `${kind} not found for manifest ${manifest_id}` }, 404);

  const headers = {
    "Cache-Control": "private, max-age=60",
    "Access-Control-Allow-Origin": "*",
  };
  if (kind === "pdf") {
    headers["Content-Type"]        = "application/pdf";
    headers["Content-Disposition"] = `inline; filename="${manifest_id}.pdf"`;
  } else {
    headers["Content-Type"]        = "text/csv; charset=utf-8";
    headers["Content-Disposition"] = `attachment; filename="${manifest_id}.csv"`;
  }
  return new Response(blob, { status: 200, headers });
}

// ─── Handler ─────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return jRes({ error: "server misconfigured: SUPABASE env vars missing" }, 500);
  }

  const url    = new URL(req.url);
  const action = url.searchParams.get("action") || "";

  try {
    if (req.method === "GET") {
      if (action === "list")          return await actionList(url);
      if (action === "get")           return await actionGet(url);
      if (action === "current_open")  return await actionCurrentOpen(url);
      if (action === "download_pdf")  return await actionDownload(url, "pdf");
      if (action === "download_csv")  return await actionDownload(url, "csv");
      return jRes({ error: `unknown GET action: ${action || "(none)"}` }, 400);
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const act  = body.action || "";

      if (act === "auto_assign") return await actionAutoAssign(body);
      if (act === "seal")        return await actionSeal(body);
      // release + email come in commit 3
      return jRes({ error: `unknown POST action: ${act || "(none)"}` }, 400);
    }

    return jRes({ error: `method not allowed: ${req.method}` }, 405);
  } catch (e) {
    console.error("[dropship-manifests]", e);
    return jRes({ error: e.message || "internal error" }, 500);
  }
}
