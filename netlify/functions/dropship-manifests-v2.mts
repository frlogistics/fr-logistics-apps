// netlify/functions/dropship-manifests.mts
//
// FR-Logistics · Outbound Manifest API
// Commit 1: read-only actions (list, get, current_open)
// Commits 2+ will add: auto_assign, seal, release, email, public
//
// Style: ESM TypeScript, fetch direct to Supabase REST API (no SDK).
// Pattern matches wa-clients.mts (the other .mts function in this codebase).
//
// Endpoints:
//   GET ?action=list[&carrier=...&status=...&limit=50]
//   GET ?action=get&manifest_id=MAN-...
//   GET ?action=current_open&carrier=MailAmericas

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL") || "";
const SUPABASE_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY") || "";

const sbHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const err = (msg: string, status = 400) => json({ error: msg }, status);

// ─── Supabase helpers ─────────────────────────────────────────────────
async function sbGet(path: string): Promise<any> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`supabase ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

// ─── Action: list manifests ──────────────────────────────────────────
async function actionList(url: URL) {
  const carrier = url.searchParams.get("carrier") || "";
  const status = url.searchParams.get("status") || "";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);

  const filters: string[] = [];
  if (carrier) filters.push(`outbound_carrier=eq.${encodeURIComponent(carrier)}`);
  if (status) filters.push(`status=eq.${encodeURIComponent(status)}`);

  const qs = [
    "select=manifest_id,outbound_carrier,status,package_count,created_at,sealed_at,sealed_by,released_at,released_by,pdf_url,csv_url,email_sent_at,email_sent_to,public_token",
    "order=created_at.desc",
    `limit=${limit}`,
    ...filters,
  ].join("&");

  const rows = await sbGet(`dropship_manifests?${qs}`);
  return json({ manifests: rows });
}

// ─── Action: get manifest by manifest_id, with packages ──────────────
async function actionGet(url: URL) {
  const manifest_id = url.searchParams.get("manifest_id");
  if (!manifest_id) return err("manifest_id required");

  const manifestRows = await sbGet(
    `dropship_manifests?manifest_id=eq.${encodeURIComponent(manifest_id)}&limit=1`
  );
  if (!manifestRows.length) return err("manifest not found", 404);
  const manifest = manifestRows[0];

  // Fetch all packages assigned to this manifest
  const packages = await sbGet(
    `dropshipments?manifest_id=eq.${encodeURIComponent(manifest_id)}` +
      `&select=id,tracking_number,carrier,outbound_carrier,outbound_platform,outbound_tracking,client_id,content,qty_boxes,status,physical_received_at,shipped_at,received_by,shipped_by` +
      `&order=shipped_at.desc.nullslast`
  );

  return json({ manifest, packages });
}

// ─── Action: current open manifest for a given carrier ───────────────
async function actionCurrentOpen(url: URL) {
  const carrier = url.searchParams.get("carrier");
  if (!carrier) return err("carrier required");

  const rows = await sbGet(
    `dropship_manifests?outbound_carrier=eq.${encodeURIComponent(carrier)}` +
      `&status=eq.open&limit=1`
  );

  if (!rows.length) {
    return json({ manifest: null, packages: [] });
  }
  const manifest = rows[0];

  const packages = await sbGet(
    `dropshipments?manifest_id=eq.${encodeURIComponent(manifest.manifest_id)}` +
      `&select=id,tracking_number,carrier,outbound_carrier,outbound_platform,outbound_tracking,client_id,content,qty_boxes,status,shipped_at,shipped_by` +
      `&order=shipped_at.desc.nullslast`
  );

  return json({ manifest, packages });
}

// ─── Router ───────────────────────────────────────────────────────────
export default async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return err("server misconfigured: SUPABASE env vars missing", 500);
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "";

  try {
    if (req.method === "GET") {
      switch (action) {
        case "list":         return await actionList(url);
        case "get":          return await actionGet(url);
        case "current_open": return await actionCurrentOpen(url);
        default:             return err(`unknown action: ${action || "(none)"}`);
      }
    }

    // Write actions (auto_assign, seal, release, email, public) come in commits 2+.
    // Reject for now to avoid silent no-ops if something tries to call them early.
    if (req.method === "POST") {
      return err("write actions not implemented in commit 1", 501);
    }

    return err(`method not allowed: ${req.method}`, 405);
  } catch (e: any) {
    console.error("[dropship-manifests]", e);
    return err(e?.message || "internal error", 500);
  }
};
