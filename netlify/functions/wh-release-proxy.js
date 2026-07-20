// netlify/functions/wh-release-proxy.js
// FR-Logistics · Warehouse Release (Local Pickup) proxy
// Mirrors the security model of shipments-proxy: the service-role key lives
// only in Netlify env vars and never reaches the browser.
//
// Flow (single POST from the app):
//   1. Call RPC next_warehouse_release_id() -> "WHR-2026-0001"
//   2. Upload signature PNG (required), cargo photos, and the POD PDF to the
//      'warehouse-releases' storage bucket.
//      NOTE: the app sends signature/photos as data URLs. The POD PDF is
//      re-generated client-side for the operator; here we store the images and
//      the row. If you prefer to also archive the PDF, send photo/pdf bytes.
//   3. Insert the row into public.warehouse_releases.
//   4. Return { release_id, signature_url, photo_urls }.
//
// Required env vars (set in Netlify dashboard, same as the other proxies):
//   SUPABASE_URL            = https://rijbschnchjiuggrhfrx.supabase.co
//   SUPABASE_SERVICE_KEY    = <service_role key>

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = "warehouse-releases";

const H = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(body),
  };
}

async function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const meta = dataUrl.slice(5, comma);              // e.g. image/png;base64
  const contentType = meta.split(";")[0] || "application/octet-stream";
  const b64 = dataUrl.slice(comma + 1);
  return { bytes: Buffer.from(b64, "base64"), contentType };
}

async function uploadDataUrl(dataUrl, path) {
  const { bytes, contentType } = await dataUrlToBytes(dataUrl);
  const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: { ...H, "Content-Type": contentType, "x-upsert": "true" },
    body: bytes,
  });
  if (!r.ok) throw new Error(`storage ${r.status}: ${await r.text()}`);
  return `${SB_URL}/storage/v1/object/public/${BUCKET}/${path}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    };
  }
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  if (!SB_URL || !SB_KEY) return json(500, { error: "Server not configured (missing SUPABASE env vars)" });

  let p;
  try { p = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Bad JSON" }); }

  // ── Mode B: attach a POD PDF to an existing release (second call from the browser) ──
  // The browser generates the PDF *after* it knows the real WHR id, then sends it here.
  if (p.attach_pod && p.release_id && p.pod_pdf_data_url) {
    try {
      const pod_pdf_url = await uploadDataUrl(p.pod_pdf_data_url, `${p.release_id}/POD_${p.release_id}.pdf`);
      const upd = await fetch(
        `${SB_URL}/rest/v1/warehouse_releases?release_id=eq.${encodeURIComponent(p.release_id)}`,
        {
          method: "PATCH",
          headers: { ...H, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ pod_pdf_url }),
        }
      );
      if (!upd.ok) throw new Error(`patch ${upd.status}: ${await upd.text()}`);
      return json(200, { release_id: p.release_id, pod_pdf_url });
    } catch (e) {
      return json(500, { error: String(e.message || e) });
    }
  }

  if (!p.client) return json(400, { error: "client is required" });
  if (!p.picked_up_by) return json(400, { error: "picked_up_by is required" });
  if (!p.signature_data_url) return json(400, { error: "signature is required" });

  try {
    // 1. Generate release id
    const idR = await fetch(`${SB_URL}/rest/v1/rpc/next_warehouse_release_id`, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!idR.ok) throw new Error(`rpc ${idR.status}: ${await idR.text()}`);
    const releaseId = await idR.json();
    if (!releaseId || typeof releaseId !== "string") throw new Error("could not generate release id");

    const stamp = Date.now();

    // 2. Upload signature (required)
    const signature_url = await uploadDataUrl(p.signature_data_url, `${releaseId}/signature_${stamp}.png`);

    // 3. Upload photos (optional)
    const photo_urls = [];
    const photos = Array.isArray(p.photo_data_urls) ? p.photo_data_urls.slice(0, 4) : [];
    for (let i = 0; i < photos.length; i++) {
      photo_urls.push(await uploadDataUrl(photos[i], `${releaseId}/cargo_${stamp}_${i}.jpg`));
    }

    // 3b. Upload POD PDF (optional — sent by the browser so the QR can point to it)
    let pod_pdf_url = null;
    if (p.pod_pdf_data_url) {
      pod_pdf_url = await uploadDataUrl(p.pod_pdf_data_url, `${releaseId}/POD_${releaseId}.pdf`);
    }

    // 4. Insert row
    const row = {
      release_id: releaseId,
      client: p.client,
      client_id: p.client_id || null,
      reference: p.reference || null,
      cargo_type: p.cargo_type || "cartons",
      qty_units: p.qty_units || 1,
      pallet_ids: Array.isArray(p.pallet_ids) ? p.pallet_ids : [],
      weight_lb: p.weight_lb ?? null,
      picked_up_by: p.picked_up_by,
      pickup_company: p.pickup_company || null,
      id_document: p.id_document || null,
      vehicle_plate: p.vehicle_plate || null,
      signature_url,
      photo_urls,
      pod_pdf_url,
      operator: p.operator || null,
      notes: p.notes || null,
    };
    const ins = await fetch(`${SB_URL}/rest/v1/warehouse_releases`, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(row),
    });
    if (!ins.ok) throw new Error(`insert ${ins.status}: ${await ins.text()}`);
    const [saved] = await ins.json();

    return json(200, {
      release_id: releaseId,
      signature_url,
      photo_urls,
      pod_pdf_url,
      id: saved?.id || null,
    });
  } catch (e) {
    return json(500, { error: String(e.message || e) });
  }
};
