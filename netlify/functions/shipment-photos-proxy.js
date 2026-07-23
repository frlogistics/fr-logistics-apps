// netlify/functions/shipment-photos-proxy.js
// FR-Logistics · uploads Inbound/Outbound condition photos to Supabase Storage
// and (optionally) attaches the resulting URLs to a shipments_general row.
//
// Security: the service-role key stays server-side, exactly like the other proxies.
//
// POST body:
//   { tracking, photo_data_urls:[dataUrl,...], attach?:true }
// Returns:
//   { tracking, photo_urls:[...] }
//
// Env vars (same as your other functions):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = "shipment-photos";

const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(body),
  };
}

function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const meta = dataUrl.slice(5, comma);
  const contentType = meta.split(";")[0] || "image/jpeg";
  return { bytes: Buffer.from(dataUrl.slice(comma + 1), "base64"), contentType };
}

async function uploadDataUrl(dataUrl, path) {
  const { bytes, contentType } = dataUrlToBytes(dataUrl);
  const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: { ...H, "Content-Type": contentType, "x-upsert": "true" },
    body: bytes,
  });
  if (!r.ok) throw new Error(`storage ${r.status}: ${await r.text()}`);
  return `${SB_URL}/storage/v1/object/public/${BUCKET}/${path}`;
}

// Storage object keys must not contain spaces or odd characters.
function safeKey(s) {
  return String(s || "unknown").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
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

  const tracking = (p.tracking || "").trim();
  const photos = Array.isArray(p.photo_data_urls) ? p.photo_data_urls.slice(0, 6) : [];
  if (!tracking) return json(400, { error: "tracking is required" });
  if (!photos.length) return json(400, { error: "no photos supplied" });

  try {
    const folder = safeKey(tracking);
    const stamp = Date.now();
    const photo_urls = [];
    for (let i = 0; i < photos.length; i++) {
      photo_urls.push(await uploadDataUrl(photos[i], `${folder}/photo_${stamp}_${i}.jpg`));
    }

    // Attach to the shipment row if it already exists (match on tracking).
    if (p.attach !== false) {
      const upd = await fetch(
        `${SB_URL}/rest/v1/shipments_general?tracking=eq.${encodeURIComponent(tracking)}`,
        {
          method: "PATCH",
          headers: { ...H, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ photo_urls }),
        }
      );
      // A missing row is not fatal — the photos are stored and the URLs returned,
      // so the caller can attach them when it saves the shipment.
      if (!upd.ok && upd.status !== 404) {
        console.warn("attach failed", upd.status, await upd.text());
      }
    }

    return json(200, { tracking, photo_urls });
  } catch (e) {
    return json(500, { error: String(e.message || e) });
  }
};
