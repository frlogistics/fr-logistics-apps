// netlify/functions/dropship-manifests.js
//
// FR-Logistics · Outbound Manifest API
// Commit 1: read-only actions (list, get, current_open)
// Commits 2+ will add: auto_assign, seal, release, email, public
//
// Style: CommonJS, fetch direct to Supabase REST API (no SDK).
// Pattern matches dropshipments.js, daily-summary.js, wa-clients.js etc.
//
// Endpoints (all GET):
//   ?action=list[&carrier=...&status=...&limit=50]
//   ?action=get&manifest_id=MAN-...
//   ?action=current_open&carrier=MailAmericas

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

const sbHeaders = {
  apikey: SUPA_KEY,
  Authorization: "Bearer " + SUPA_KEY,
  "Content-Type": "application/json",
};

const RESP_HEADERS = { "Content-Type": "application/json" };

function resp(status, body) {
  return {
    statusCode: status,
    headers: RESP_HEADERS,
    body: JSON.stringify(body),
  };
}

const err = (msg, status) => resp(status || 400, { error: msg });

// ─── Supabase helpers ─────────────────────────────────────────────────
async function sbGet(path) {
  const r = await fetch(SUPA_URL + "/rest/v1/" + path, { headers: sbHeaders });
  if (!r.ok) {
    const t = await r.text();
    throw new Error("supabase " + r.status + ": " + t.slice(0, 200));
  }
  return r.json();
}

// ─── Action: list manifests ──────────────────────────────────────────
async function actionList(params) {
  const carrier = params.carrier || "";
  const status = params.status || "";
  const limit = Math.min(parseInt(params.limit || "50", 10), 200);

  const filters = [];
  if (carrier) filters.push("outbound_carrier=eq." + encodeURIComponent(carrier));
  if (status) filters.push("status=eq." + encodeURIComponent(status));

  const qs = [
    "select=manifest_id,outbound_carrier,status,package_count,created_at,sealed_at,sealed_by,released_at,released_by,pdf_url,csv_url,email_sent_at,email_sent_to,public_token",
    "order=created_at.desc",
    "limit=" + limit,
  ].concat(filters).join("&");

  const rows = await sbGet("dropship_manifests?" + qs);
  return resp(200, { manifests: rows });
}

// ─── Action: get manifest by manifest_id, with packages ──────────────
async function actionGet(params) {
  const manifest_id = params.manifest_id;
  if (!manifest_id) return err("manifest_id required");

  const manifestRows = await sbGet(
    "dropship_manifests?manifest_id=eq." + encodeURIComponent(manifest_id) + "&limit=1"
  );
  if (!manifestRows.length) return err("manifest not found", 404);
  const manifest = manifestRows[0];

  const packages = await sbGet(
    "dropshipments?manifest_id=eq." + encodeURIComponent(manifest_id) +
    "&select=id,tracking_number,carrier,outbound_carrier,outbound_platform,outbound_tracking,client_id,content,qty_boxes,status,physical_received_at,shipped_at,received_by,shipped_by" +
    "&order=shipped_at.desc.nullslast"
  );

  return resp(200, { manifest, packages });
}

// ─── Action: current open manifest for a given carrier ───────────────
async function actionCurrentOpen(params) {
  const carrier = params.carrier;
  if (!carrier) return err("carrier required");

  const rows = await sbGet(
    "dropship_manifests?outbound_carrier=eq." + encodeURIComponent(carrier) +
    "&status=eq.open&limit=1"
  );

  if (!rows.length) {
    return resp(200, { manifest: null, packages: [] });
  }
  const manifest = rows[0];

  const packages = await sbGet(
    "dropshipments?manifest_id=eq." + encodeURIComponent(manifest.manifest_id) +
    "&select=id,tracking_number,carrier,outbound_carrier,outbound_platform,outbound_tracking,client_id,content,qty_boxes,status,shipped_at,shipped_by" +
    "&order=shipped_at.desc.nullslast"
  );

  return resp(200, { manifest, packages });
}

// ─── Handler (CommonJS, matches the rest of this codebase) ──────────
exports.handler = async (event) => {
  if (!SUPA_URL || !SUPA_KEY) {
    return err("server misconfigured: SUPABASE env vars missing", 500);
  }

  const method = event.httpMethod;
  const params = event.queryStringParameters || {};
  const action = params.action || "";

  try {
    if (method === "GET") {
      if (action === "list")         return await actionList(params);
      if (action === "get")          return await actionGet(params);
      if (action === "current_open") return await actionCurrentOpen(params);
      return err("unknown action: " + (action || "(none)"));
    }

    // Write actions (auto_assign, seal, release, email, public) come in commits 2+.
    if (method === "POST") {
      return err("write actions not implemented in commit 1", 501);
    }

    return err("method not allowed: " + method, 405);
  } catch (e) {
    console.error("[dropship-manifests]", e);
    return err((e && e.message) || "internal error", 500);
  }
};
