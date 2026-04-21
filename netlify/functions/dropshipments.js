// netlify/functions/dropshipments.js
// Dropshipments · read/list + state machine transitions.
//
// GET endpoints:
//   ?action=list                         → list (with fr_clients join + config merge)
//   ?action=list&status=pending          → filter by status
//   ?action=list&client_id={uuid}        → filter by client
//   ?action=get&id={uuid}                → single row with full detail
//   ?action=label&id={uuid}              → returns signed URL for PDF (5 min TTL)
//   ?action=stats                        → counts by status
//   ?action=clients                      → active dropshipment clients
//
// POST endpoints (JSON body: { action, id, operator, ... }):
//   action=receive   → pending/exception → received   (sets physical_received_at, received_by)
//   action=label     → received          → labeled    (sets labeled_at)
//   action=ship      → labeled           → shipped    (sets shipped_at, shipped_by)
//   action=revert    → received/labeled/shipped → previous status (clears ts/by)
//   action=exception → pending/received/labeled → exception (reason: body.reason)
//   action=resolve   → exception         → pending   (clears exception_reason)

const SUPABASE_URL  = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY  = Netlify.env.get("SUPABASE_SERVICE_KEY");
const SB_BUCKET     = "dropship-labels";

const SB = () => ({ "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" });
async function sbSelect(t, q = "") { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}${q}`, { headers: SB() }); if (!r.ok) throw new Error(`sbSelect ${t}: ${await r.text()}`); return r.json(); }
async function sbPatch(t, f, d) { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}?${f}`, { method: "PATCH", headers: { ...SB(), "Prefer": "return=representation" }, body: JSON.stringify(d) }); if (!r.ok) throw new Error(`sbPatch ${t}: ${await r.text()}`); return r.json(); }
async function sbSignedUrl(path, expiresIn = 300) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${SB_BUCKET}/${path}`, {
    method: "POST",
    headers: SB(),
    body: JSON.stringify({ expiresIn })
  });
  if (!r.ok) throw new Error(`sbSignedUrl: ${await r.text()}`);
  const j = await r.json();
  return `${SUPABASE_URL}/storage/v1${j.signedURL || j.signedUrl || j.url}`;
}

// Response helpers
const CORS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,Authorization" };
const jRes = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: CORS });

// ─── Query builders ──────────────────────────────────────────────────────────
const SELECT_CORE = "id,client_id,tracking_number,order_id,carrier,content,qty_boxes,notes,label_url,label_filename,outbound_carrier,outbound_platform,outbound_tracking,status,email_received_at,physical_received_at,labeled_at,shipped_at,received_by,shipped_by,exception_reason,created_at,updated_at";

// We only embed fr_clients (the one FK that exists on dropshipments).
// dropship_client_configs is merged in application code below via client_id.
const SELECT_WITH_CLIENT = `${SELECT_CORE},client:fr_clients(id,name,company,store_name)`;

// Fetch all client configs once, build a map by client_id.
async function loadConfigMap() {
  const configs = await sbSelect("dropship_client_configs", "?select=client_id,client_code,display_name,rate_per_package,outbound_carrier,outbound_platform");
  const map = {};
  for (const c of configs) map[c.client_id] = c;
  return map;
}

// Attach `config` to each row using the pre-built map.
function attachConfigs(rows, configMap) {
  for (const r of rows) r.config = configMap[r.client_id] || null;
  return rows;
}

// ─── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "list";

  try {
    // ── GET: stats (KPI strip counts) ─────────────────────────────────────
    if (req.method === "GET" && action === "stats") {
      const clientFilter = url.searchParams.get("client_id");
      const base = "dropshipments?select=status";
      const q = clientFilter ? `${base}&client_id=eq.${clientFilter}` : base;
      const rows = await sbSelect("", q);
      const counts = { pending: 0, received: 0, labeled: 0, shipped: 0, orphan: 0, exception: 0, total: rows.length };
      for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
      return jRes(counts);
    }

    // ── GET: clients (for selector dropdown) ──────────────────────────────
    if (req.method === "GET" && action === "clients") {
      const configs = await sbSelect("dropship_client_configs",
        "?active=eq.true&select=client_id,client_code,display_name,rate_per_package,outbound_carrier,outbound_platform&order=display_name.asc"
      );
      return jRes({ clients: configs });
    }

    // ── GET: single record ────────────────────────────────────────────────
    if (req.method === "GET" && action === "get") {
      const id = url.searchParams.get("id");
      if (!id) return jRes({ error: "id required" }, 400);
      const [rows, configMap] = await Promise.all([
        sbSelect("dropshipments", `?id=eq.${id}&select=${SELECT_WITH_CLIENT}&limit=1`),
        loadConfigMap()
      ]);
      if (!rows.length) return jRes({ error: "not found" }, 404);
      attachConfigs(rows, configMap);
      return jRes({ row: rows[0] });
    }

    // ── GET: signed URL for label PDF ─────────────────────────────────────
    if (req.method === "GET" && action === "label") {
      const id = url.searchParams.get("id");
      if (!id) return jRes({ error: "id required" }, 400);
      const rows = await sbSelect("dropshipments", `?id=eq.${id}&select=label_url&limit=1`);
      if (!rows.length) return jRes({ error: "not found" }, 404);
      const labelPath = rows[0].label_url;
      if (!labelPath) return jRes({ error: "no label for this record" }, 404);
      // label_url is stored as "LN/TRACKING.pdf" (without bucket prefix)
      // sign it for 5 minutes
      const pathInBucket = labelPath.startsWith(`${SB_BUCKET}/`) ? labelPath.slice(SB_BUCKET.length + 1) : labelPath;
      const signedUrl = await sbSignedUrl(pathInBucket, 300);
      return jRes({ url: signedUrl, expires_in: 300 });
    }

    // ── GET: list (default) ───────────────────────────────────────────────
    if (req.method === "GET") {
      const status    = url.searchParams.get("status");      // optional filter
      const clientId  = url.searchParams.get("client_id");   // optional filter
      const limit     = parseInt(url.searchParams.get("limit") || "200", 10);
      const order     = url.searchParams.get("order") || "email_received_at.desc.nullslast";

      let q = `?select=${SELECT_WITH_CLIENT}&order=${order}&limit=${limit}`;
      if (status) q += `&status=eq.${status}`;
      if (clientId) q += `&client_id=eq.${clientId}`;

      const [rows, configMap] = await Promise.all([
        sbSelect("dropshipments", q),
        loadConfigMap()
      ]);
      attachConfigs(rows, configMap);
      return jRes({ rows, count: rows.length });
    }

    // ── POST: status transitions ──────────────────────────────────────────
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const act = body.action;
      const id = body.id;
      const operator = (body.operator || "").trim().slice(0, 60) || "warehouse";

      if (!act || !id) return jRes({ error: "action and id required" }, 400);

      // Load the current row to validate the transition.
      const cur = await sbSelect("dropshipments", `?id=eq.${id}&select=id,status,label_url,tracking_number&limit=1`);
      if (!cur.length) return jRes({ error: "not found" }, 404);
      const current = cur[0];

      // Allowed transitions: (from, to) pairs
      const LEGAL = {
        receive:    { from: ["pending", "exception"],       to: "received",  ts: "physical_received_at", by: "received_by" },
        label:      { from: ["received"],                    to: "labeled",   ts: "labeled_at",           by: null },
        ship:       { from: ["labeled"],                     to: "shipped",   ts: "shipped_at",           by: "shipped_by" },
        revert:     { from: ["received", "labeled", "shipped"], to: null,     ts: null,                   by: null }, // special: computed below
        exception:  { from: ["pending", "received", "labeled"], to: "exception", ts: null,                 by: null },
        resolve:    { from: ["exception"],                   to: "pending",   ts: null,                   by: null }
      };

      const rule = LEGAL[act];
      if (!rule) return jRes({ error: `unknown action '${act}'`, allowed: Object.keys(LEGAL) }, 400);
      if (!rule.from.includes(current.status)) {
        return jRes({ error: `cannot ${act} from status '${current.status}'`, allowed_from: rule.from }, 409);
      }

      // Build the patch payload.
      const patch = {};

      if (act === "revert") {
        // Revert to the previous status, clearing that step's timestamp.
        const REVERT_TO = { received: "pending", labeled: "received", shipped: "labeled" };
        const CLEAR_TS  = { received: "physical_received_at", labeled: "labeled_at", shipped: "shipped_at" };
        const CLEAR_BY  = { received: "received_by", labeled: null, shipped: "shipped_by" };
        patch.status = REVERT_TO[current.status];
        patch[CLEAR_TS[current.status]] = null;
        if (CLEAR_BY[current.status]) patch[CLEAR_BY[current.status]] = null;
      } else if (act === "exception") {
        patch.status = rule.to;
        patch.exception_reason = (body.reason || "").trim().slice(0, 500) || null;
      } else if (act === "resolve") {
        patch.status = rule.to;
        patch.exception_reason = null;
      } else {
        // receive, label, ship
        patch.status = rule.to;
        if (rule.ts) patch[rule.ts] = new Date().toISOString();
        if (rule.by) patch[rule.by] = operator;
      }

      const updated = await sbPatch("dropshipments", `id=eq.${id}`, patch);
      return jRes({ ok: true, action: act, row: updated[0] });
    }

    return jRes({ error: "Method not allowed" }, 405);
  } catch (e) {
    console.error("[dropshipments]", e);
    return jRes({ error: e.message }, 500);
  }
}

export const config = { path: "/.netlify/functions/dropshipments" };
