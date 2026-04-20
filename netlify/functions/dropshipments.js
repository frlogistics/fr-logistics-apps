// netlify/functions/dropshipments.js
// Dropshipments · read/list endpoint + signed URL generator for label PDFs.
//
// Day 1 endpoints:
//   GET  ?action=list                  → list all dropshipments (with joined client info)
//   GET  ?action=list&status=pending   → filter by status
//   GET  ?action=get&id={uuid}         → single row
//   GET  ?action=label&id={uuid}       → returns signed URL for the PDF (5 min TTL)
//   GET  ?action=stats                 → counts by status (for KPI strip)
//   GET  ?action=clients               → list active dropshipment clients (for selector)
//
// Day 2+ (placeholder, not implemented yet):
//   POST body.action=receive / label / ship / exception / resolve

const SUPABASE_URL  = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY  = Netlify.env.get("SUPABASE_SERVICE_KEY");
const SB_BUCKET     = "dropship-labels";

const SB = () => ({ "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" });
async function sbSelect(t, q = "") { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}${q}`, { headers: SB() }); if (!r.ok) throw new Error(`sbSelect ${t}: ${await r.text()}`); return r.json(); }
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
// Rows come with client info joined via PostgREST's foreign-table syntax.
const SELECT_CORE = "id,client_id,tracking_number,order_id,carrier,content,qty_boxes,notes,label_url,label_filename,outbound_carrier,outbound_platform,outbound_tracking,status,email_received_at,physical_received_at,labeled_at,shipped_at,received_by,shipped_by,exception_reason,created_at,updated_at";

// Supabase PostgREST supports joining foreign tables via ?select=...,fr_clients(...)
// We use the relationship name (the FK) to pull client display fields.
const SELECT_WITH_CLIENT = `${SELECT_CORE},client:fr_clients(id,name,company,store_name),config:dropship_client_configs(client_code,display_name,rate_per_package,outbound_carrier,outbound_platform)`;

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
      const rows = await sbSelect("dropshipments",
        `?id=eq.${id}&select=${SELECT_WITH_CLIENT}&limit=1`
      );
      if (!rows.length) return jRes({ error: "not found" }, 404);
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

      const rows = await sbSelect("dropshipments", q);
      return jRes({ rows, count: rows.length });
    }

    // ── POST: placeholder for Day 2 mutations ─────────────────────────────
    if (req.method === "POST") {
      return jRes({
        error: "Mutations not yet implemented. Planned for Day 2.",
        planned_actions: ["receive", "label", "ship", "exception", "resolve"]
      }, 501);
    }

    return jRes({ error: "Method not allowed" }, 405);
  } catch (e) {
    console.error("[dropshipments]", e);
    return jRes({ error: e.message }, 500);
  }
}

export const config = { path: "/.netlify/functions/dropshipments" };
