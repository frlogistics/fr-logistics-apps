// netlify/functions/dropshipments.js
// Dropshipments · read/list + state machine transitions + orphan registration.
//
// Day 4: when a package transitions to `received` or `shipped`, we also insert
// a row into shipments_general (Inbound/Outbound Drop-Shipment) so the
// Billing Generator (billing.html → billing-inbound.js) can count it.
// Sync is forward-only (revert does not delete) and idempotent (duplicate
// trackings are swallowed silently).
//
// Day 5 (Manifests): when a package transitions to `shipped`, we ALSO assign
// it to the open manifest of its outbound_carrier (creating the manifest if
// none exists). When a `shipped` package is reverted, we clear manifest_id
// and decrement package_count — the manifest must still be 'open' (sealed
// manifests cannot lose packages because the artifact has been generated).
// All manifest sync is non-fatal: failures are logged, primary update wins.
//
// Day 6 (Receive guard — Option 2): an orphan can ONLY transition to `received`
// once it actually has a matched email/label. A physically-received package with
// no email_message_id AND no label_url stays in `orphan` until the Gmail sync
// (or a manual Process Orphan) attaches the documents. This prevents a package
// with no printable label from leaking into the dispatch flow. The guard lives
// here (single source of truth) so scan, batch, and drawer all behave the same.
//
// GET endpoints:
//   ?action=list                         → list (with fr_clients join + config merge)
//   ?action=list&status=pending          → filter by status
//   ?action=list&client_id={uuid}        → filter by client
//   ?action=get&id={uuid}                → single row with full detail
//   ?action=lookup&tracking={num}        → find row by tracking_number (all clients)
//   ?action=label&id={uuid}              → returns signed URL for PDF (5 min TTL)
//   ?action=stats                        → counts by status + extended KPIs
//                                           (shipped_today, shipped_this_month,
//                                            received_today, orphans_aging,
//                                            oldest_pending_hours)
//   ?action=clients                      → active dropshipment clients
//
// POST endpoints (JSON body: { action, id, operator, ... }):
//   action=receive          → pending/exception → received   (sets physical_received_at, received_by)
//                             orphan → received ONLY if it has email_message_id OR label_url
//   action=label            → received          → labeled    (sets labeled_at)
//   action=ship             → labeled           → shipped    (sets shipped_at, shipped_by, manifest_id)
//   action=revert           → received/labeled/shipped → previous status (clears ts/by/manifest_id)
//   action=exception        → pending/received/labeled → exception (reason: body.reason)
//   action=resolve          → exception         → pending   (clears exception_reason)
//   action=create_orphan    → new row with status='orphan'  (body: tracking_number, client_id, operator)
//   action=link_outbound    → set outbound_tracking + transition received→labeled
//                             (body: id, outbound_tracking, operator, optional force:true)
//   action=unlink_outbound  → clear outbound_tracking (status unchanged)
//   action=process_orphan   → upload PDF + fill outbound/order/content + transition orphan→received
//                             (body: id, outbound_tracking, outbound_carrier, order_id, content,
//                              label_filename, pdf_base64, operator)
//   action=delete_orphan    → permanently delete an orphan row (status='orphan' only)
//                             (body: id, operator) — for cleaning up bad scans

const SUPABASE_URL  = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY  = Netlify.env.get("SUPABASE_SERVICE_KEY");
const SB_BUCKET     = "dropship-labels";

const SB = () => ({ "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" });
async function sbSelect(t, q = "") { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}${q}`, { headers: SB() }); if (!r.ok) throw new Error(`sbSelect ${t}: ${await r.text()}`); return r.json(); }
async function sbInsert(t, d) { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}`, { method: "POST", headers: { ...SB(), "Prefer": "return=representation" }, body: JSON.stringify(d) }); if (!r.ok) throw new Error(`sbInsert ${t}: ${await r.text()}`); return r.json(); }
async function sbPatch(t, f, d) { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}?${f}`, { method: "PATCH", headers: { ...SB(), "Prefer": "return=representation" }, body: JSON.stringify(d) }); if (!r.ok) throw new Error(`sbPatch ${t}: ${await r.text()}`); return r.json(); }
async function sbRpc(fn, args) { const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: SB(), body: JSON.stringify(args) }); if (!r.ok) throw new Error(`sbRpc ${fn}: ${await r.text()}`); return r.json(); }
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

// Upload a binary blob to Supabase Storage. Used by process_orphan to push the
// PDF that the client emailed. Path is the in-bucket path (e.g. "LN/123.pdf").
// Uses upsert=true so re-processing an orphan overwrites cleanly.
async function sbStorageUpload(path, bytes, contentType = "application/pdf") {
  const url = `${SUPABASE_URL}/storage/v1/object/${SB_BUCKET}/${path}`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": contentType,
      "x-upsert": "true"
    },
    body: bytes
  });
  if (!r.ok) throw new Error(`sbStorageUpload: ${r.status} ${await r.text()}`);
  return r.json().catch(() => ({ ok: true }));
}

// Response helpers
const CORS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,Authorization" };
const jRes = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: CORS });

// ─── Query builders ──────────────────────────────────────────────────────────
const SELECT_CORE = "id,client_id,tracking_number,order_id,carrier,content,qty_boxes,notes,label_url,label_filename,outbound_carrier,outbound_platform,outbound_tracking,status,email_received_at,physical_received_at,labeled_at,shipped_at,received_by,shipped_by,exception_reason,manifest_id,created_at,updated_at";

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

// ─── Manifest sync helpers (Day 5) ──────────────────────────────────────────
// All non-fatal: if anything throws here, the caller logs and continues.

// Assign a freshly-shipped package to its open manifest. Idempotent.
// Uses the Postgres function get_or_create_open_manifest(carrier, operator)
// which is race-safe via the partial unique index.
async function assignToOpenManifest({ packageId, outboundCarrier, operator }) {
  if (!packageId || !outboundCarrier) {
    throw new Error(`assignToOpenManifest: packageId and outboundCarrier required`);
  }

  // Idempotency: if already assigned, do nothing.
  const cur = await sbSelect("dropshipments", `?id=eq.${packageId}&select=manifest_id&limit=1`);
  if (cur[0]?.manifest_id) {
    return { already_assigned: true, manifest_id: cur[0].manifest_id };
  }

  // Get or create the open manifest atomically (race-safe at DB level)
  const result = await sbRpc("get_or_create_open_manifest", {
    p_carrier:  outboundCarrier,
    p_operator: operator || "system",
  });
  const m = Array.isArray(result) ? result[0] : result;
  if (!m?.manifest_id) throw new Error("get_or_create_open_manifest returned no manifest");

  // Assign + increment count
  await sbPatch("dropshipments", `id=eq.${packageId}`, { manifest_id: m.manifest_id });
  await sbRpc("manifest_increment_count", { p_manifest_id: m.manifest_id });

  return {
    already_assigned: false,
    manifest_id:      m.manifest_id,
    was_created:      m.was_created,
  };
}

// On revert from shipped → labeled: clear manifest_id and decrement count,
// but ONLY if the manifest is still open. If sealed, we hard-reject the revert
// at the LEGAL transition layer above this function (see ship→revert handler).
async function unassignFromManifest({ packageId, manifestId }) {
  if (!packageId || !manifestId) return { skipped: true };

  // Check the manifest status — only open manifests can shrink.
  const mRows = await sbSelect("dropship_manifests",
    `?manifest_id=eq.${encodeURIComponent(manifestId)}&select=status&limit=1`
  );
  if (!mRows.length) {
    // Manifest disappeared (extremely rare, e.g. manual DB cleanup) — just clear the FK.
    await sbPatch("dropshipments", `id=eq.${packageId}`, { manifest_id: null });
    return { manifest_missing: true };
  }
  if (mRows[0].status !== "open") {
    // This is the "sealed manifest blocks revert" case. The caller should
    // have rejected the revert already; if we get here, something bypassed
    // the guard. Fail loud.
    throw new Error(`cannot unassign from manifest ${manifestId} (status=${mRows[0].status})`);
  }

  await sbPatch("dropshipments", `id=eq.${packageId}`, { manifest_id: null });
  await sbRpc("manifest_decrement_count", { p_manifest_id: manifestId });
  return { unassigned: true };
}

// ─── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "list";

  try {
    // ── GET: stats (KPI strip counts + dashboard KPIs) ────────────────────
    if (req.method === "GET" && action === "stats") {
      const clientFilter = url.searchParams.get("client_id");
      const clientFilterParam = clientFilter ? `&client_id=eq.${clientFilter}` : "";

      const rows = await sbSelect("dropshipments",
        `?select=status,physical_received_at,shipped_at${clientFilterParam}`
      );
      const counts = { pending: 0, received: 0, labeled: 0, shipped: 0, orphan: 0, exception: 0, total: rows.length };
      for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;

      const now    = new Date();
      const today  = now.toISOString().slice(0, 10);
      const monthStart = today.slice(0, 7) + "-01";
      const sixHoursAgo = new Date(now.getTime() - 6 * 3600 * 1000);

      let shipped_today = 0, shipped_this_month = 0, received_today = 0;
      let oldest_pending_at = null, orphans_aging = 0;

      for (const r of rows) {
        if (r.shipped_at) {
          const d = r.shipped_at.slice(0, 10);
          if (d === today)            shipped_today += 1;
          if (d >= monthStart)        shipped_this_month += 1;
        }
        if (r.physical_received_at) {
          const d = r.physical_received_at.slice(0, 10);
          if (d === today)            received_today += 1;
        }
        if (r.status === "orphan" && r.physical_received_at) {
          const ts = new Date(r.physical_received_at);
          if (ts < sixHoursAgo) orphans_aging += 1;
        }
      }

      const pendingRows = await sbSelect("dropshipments",
        `?status=eq.pending&select=email_received_at&order=email_received_at.asc.nullslast&limit=1${clientFilterParam}`
      );
      if (pendingRows.length && pendingRows[0].email_received_at) {
        oldest_pending_at = pendingRows[0].email_received_at;
      }

      let oldest_pending_hours = null;
      if (oldest_pending_at) {
        oldest_pending_hours = Math.round((now.getTime() - new Date(oldest_pending_at).getTime()) / 3600000);
      }

      return jRes({
        ...counts,
        shipped_today,
        shipped_this_month,
        received_today,
        orphans_aging,
        oldest_pending_at,
        oldest_pending_hours,
        as_of: now.toISOString()
      });
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

    // ── GET: lookup by tracking number (for scan bar) ─────────────────────
    if (req.method === "GET" && action === "lookup") {
      const tracking = (url.searchParams.get("tracking") || "").trim();
      if (!tracking) return jRes({ error: "tracking required" }, 400);
      const enc = encodeURIComponent(tracking);
      const configMap = await loadConfigMap();
      const filter = `or=(tracking_number.eq.${enc},outbound_tracking.eq.${enc})`;
      const rows = await sbSelect("dropshipments", `?${filter}&select=${SELECT_WITH_CLIENT}&limit=5`);
      attachConfigs(rows, configMap);
      const matches = rows.map(r => ({
        ...r,
        match_field: r.tracking_number === tracking ? "tracking_number"
                    : r.outbound_tracking === tracking ? "outbound_tracking"
                    : "unknown"
      }));
      return jRes({ rows: matches, count: matches.length, tracking });
    }

    // ── GET: signed URL for label PDF ─────────────────────────────────────
    if (req.method === "GET" && action === "label") {
      const id = url.searchParams.get("id");
      if (!id) return jRes({ error: "id required" }, 400);
      const rows = await sbSelect("dropshipments", `?id=eq.${id}&select=label_url&limit=1`);
      if (!rows.length) return jRes({ error: "not found" }, 404);
      const labelPath = rows[0].label_url;
      if (!labelPath) return jRes({ error: "no label for this record" }, 404);
      const pathInBucket = labelPath.startsWith(`${SB_BUCKET}/`) ? labelPath.slice(SB_BUCKET.length + 1) : labelPath;
      const signedUrl = await sbSignedUrl(pathInBucket, 300);
      return jRes({ url: signedUrl, expires_in: 300 });
    }

    // ── GET: list (default) ───────────────────────────────────────────────
    if (req.method === "GET") {
      const status    = url.searchParams.get("status");
      const clientId  = url.searchParams.get("client_id");
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

    // ── POST: status transitions + orphan registration ───────────────────
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const act = body.action;
      const operator = (body.operator || "").trim().slice(0, 60) || "warehouse";

      if (!act) return jRes({ error: "action required" }, 400);

      // ── create_orphan: INSERT a new row for an un-emailed tracking ──────
      if (act === "create_orphan") {
        const tracking = (body.tracking_number || "").trim();
        const clientId = (body.client_id || "").trim();
        const notes    = (body.notes || "").trim().slice(0, 500) || null;
        if (!tracking) return jRes({ error: "tracking_number required" }, 400);
        if (!clientId) return jRes({ error: "client_id required" }, 400);

        const cfg = await sbSelect("dropship_client_configs", `?client_id=eq.${clientId}&select=client_id,client_code,display_name&limit=1`);
        if (!cfg.length) return jRes({ error: "client_id not configured for dropshipments" }, 400);

        const existing = await sbSelect("dropshipments", `?client_id=eq.${clientId}&tracking_number=eq.${encodeURIComponent(tracking)}&select=id,status&limit=1`);
        if (existing.length) {
          return jRes({ error: "tracking already exists for this client", existing: existing[0] }, 409);
        }

        const now = new Date().toISOString();
        const inserted = await sbInsert("dropshipments", [{
          client_id:            clientId,
          tracking_number:      tracking,
          status:               "orphan",
          qty_boxes:            1,
          notes:                notes,
          physical_received_at: now,
          received_by:          operator
        }]);
        return jRes({ ok: true, action: "create_orphan", row: inserted[0] });
      }

      // ── delete_orphan: hard-delete an orphan row ──────────────────────
      if (act === "delete_orphan") {
        const id = body.id;
        if (!id) return jRes({ error: "id required" }, 400);

        const cur = await sbSelect("dropshipments",
          `?id=eq.${id}&select=id,status,tracking_number,client_id&limit=1`
        );
        if (!cur.length) return jRes({ error: "not found" }, 404);
        if (cur[0].status !== "orphan") {
          return jRes({
            error: `delete_orphan only valid for status='orphan' (current: '${cur[0].status}')`,
            hint: "non-orphan rows must be reverted or exception-flagged — never deleted"
          }, 409);
        }

        const r = await fetch(`${SUPABASE_URL}/rest/v1/dropshipments?id=eq.${id}`, {
          method: "DELETE",
          headers: SB()
        });
        if (!r.ok) {
          const detail = await r.text();
          return jRes({ error: "delete failed", detail }, 500);
        }

        console.log(`[dropshipments.delete_orphan] ${operator} deleted orphan ${cur[0].tracking_number} (id=${id})`);
        return jRes({ ok: true, action: "delete_orphan", deleted: cur[0] });
      }

      // ── process_orphan: complete an orphan record manually ──────────────
      if (act === "process_orphan") {
        const id              = body.id;
        const outbound        = (body.outbound_tracking || "").trim();
        const outboundCarrier = (body.outbound_carrier || "").trim();
        const outboundPlatform= (body.outbound_platform || "").trim() || null;
        const orderId         = (body.order_id || "").trim() || null;
        const content         = (body.content || "").trim() || null;
        const qtyBoxes        = parseInt(body.qty_boxes || "1", 10) || 1;
        const labelFilename   = (body.label_filename || "").trim() || null;
        const pdfBase64       = body.pdf_base64 || null;
        const notes           = (body.notes || "").trim().slice(0, 500) || null;

        if (!id) return jRes({ error: "id required" }, 400);
        if (!outbound) return jRes({ error: "outbound_tracking required" }, 400);
        if (outbound.length < 6 || outbound.length > 64) {
          return jRes({ error: "outbound_tracking must be 6-64 characters" }, 400);
        }
        if (!/^[A-Za-z0-9-]+$/.test(outbound)) {
          return jRes({ error: "outbound_tracking must contain only letters, digits, and hyphens" }, 400);
        }
        if (!outboundCarrier) return jRes({ error: "outbound_carrier required" }, 400);
        if (!pdfBase64) return jRes({ error: "pdf_base64 required" }, 400);

        const cur = await sbSelect("dropshipments",
          `?id=eq.${id}&select=id,status,client_id,tracking_number,outbound_tracking,physical_received_at,received_by&limit=1`
        );
        if (!cur.length) return jRes({ error: "not found" }, 404);
        const current = cur[0];

        if (current.status !== "orphan") {
          return jRes({
            error: `process_orphan only valid for status='orphan' (current: '${current.status}')`,
            hint: "use link_outbound for received/labeled rows instead"
          }, 409);
        }

        if (outbound === current.tracking_number) {
          return jRes({
            error: "outbound_tracking cannot be the same as the inbound tracking_number",
            hint: "the outbound is the tracking shown on the carrier label sent by the client (e.g. MailAmericas number)"
          }, 400);
        }

        const dupes = await sbSelect("dropshipments",
          `?outbound_tracking=eq.${encodeURIComponent(outbound)}&select=id,tracking_number,status&limit=2`
        );
        const conflicting = dupes.find(d => d.id !== id);
        if (conflicting) {
          return jRes({
            error: "outbound_tracking is already linked to another package",
            conflict: { id: conflicting.id, tracking_number: conflicting.tracking_number, status: conflicting.status }
          }, 409);
        }

        const cfgRows = await sbSelect("dropship_client_configs",
          `?client_id=eq.${current.client_id}&select=client_code,client_name_billing,outbound_carrier&limit=1`
        );
        if (!cfgRows.length) return jRes({ error: "client config not found" }, 400);
        const clientCode = (cfgRows[0].client_code || "MISC").trim();

        let pdfBytes;
        try {
          const cleanB64 = pdfBase64.includes(",") ? pdfBase64.split(",")[1] : pdfBase64;
          const binStr = atob(cleanB64);
          pdfBytes = new Uint8Array(binStr.length);
          for (let i = 0; i < binStr.length; i++) pdfBytes[i] = binStr.charCodeAt(i);
        } catch (e) {
          return jRes({ error: "invalid pdf_base64 encoding", detail: e.message }, 400);
        }

        const storagePath = `${clientCode}/${outbound}.pdf`;
        try {
          await sbStorageUpload(storagePath, pdfBytes, "application/pdf");
        } catch (e) {
          return jRes({ error: "PDF upload failed", detail: e.message }, 500);
        }

        const now = new Date().toISOString();
        const patch = {
          status:                "received",
          outbound_tracking:     outbound,
          outbound_carrier:      outboundCarrier,
          outbound_platform:     outboundPlatform,
          order_id:              orderId,
          content:               content,
          qty_boxes:             qtyBoxes,
          label_url:             storagePath,
          label_filename:        labelFilename || `${outbound}.pdf`,
          received_by:           operator,
          physical_received_at:  current.physical_received_at || now,
          orphan_alerted_at:     null
        };
        if (notes) patch.notes = notes;

        let updated;
        try {
          updated = await sbPatch("dropshipments", `id=eq.${id}`, patch);
        } catch (e) {
          if (String(e.message).includes("orphan_alerted_at")) {
            delete patch.orphan_alerted_at;
            updated = await sbPatch("dropshipments", `id=eq.${id}`, patch);
          } else {
            throw e;
          }
        }
        const updatedRow = updated[0];

        // ── Sync to shipments_general so Billing Generator counts the inbound ──
        try {
          const cfg = cfgRows[0];
          if (cfg?.client_name_billing) {
         const sgRow = {
            tracking:  current.tracking_number,
            direction: "Inbound",
            type:      "Inbound (Drop-Shipment)",
            carrier:   "Other",
            client:    cfg.client_name_billing,
            client_id: current.client_id,
            notes:     `Order: ${orderId || "—"}${content ? ` · ${content}` : ""} · processed from orphan`
          };
            try {
              await sbInsert("shipments_general", sgRow);
              console.log(`[dropshipments.process_orphan] synced to shipments_general: Inbound ${sgRow.tracking}`);
            } catch (e) {
              if (String(e.message).includes("23505") || String(e.message).toLowerCase().includes("duplicate")) {
                console.log(`[dropshipments.process_orphan] already in shipments_general: ${sgRow.tracking}`);
              } else {
                throw e;
              }
            }
          } else {
            console.warn(`[dropshipments.process_orphan] no client_name_billing — skipping sync`);
          }
        } catch (e) {
          console.error(`[dropshipments.process_orphan] shipments_general sync failed:`, e.message);
        }

        return jRes({
          ok: true,
          action: "process_orphan",
          row: updatedRow,
          label_path: storagePath,
          transitioned: "orphan → received"
        });
      }

      // ── link_outbound: assign an outbound_tracking + transition to labeled ──
      if (act === "link_outbound") {
        const id          = body.id;
        const outbound    = (body.outbound_tracking || "").trim();
        const force       = body.force === true;
        if (!id) return jRes({ error: "id required" }, 400);
        if (!outbound) return jRes({ error: "outbound_tracking required" }, 400);

        if (outbound.length < 6 || outbound.length > 64) {
          return jRes({ error: "outbound_tracking must be 6-64 characters" }, 400);
        }
        if (!/^[A-Za-z0-9]+$/.test(outbound)) {
          return jRes({
            error: "outbound_tracking must contain only letters and digits (no spaces or symbols)"
          }, 400);
        }

        const cur = await sbSelect("dropshipments", `?id=eq.${id}&select=id,status,outbound_tracking,tracking_number&limit=1`);
        if (!cur.length) return jRes({ error: "not found" }, 404);
        const current = cur[0];

        if (outbound === current.tracking_number) {
          return jRes({
            error: "outbound_tracking cannot be the same as the inbound tracking_number",
            hint: "looks like you scanned the inbound barcode — scan the OUTBOUND label (carrier barcode) instead"
          }, 400);
        }

        if (current.status !== "received" && current.status !== "labeled") {
          return jRes({
            error: `cannot link outbound from status '${current.status}'`,
            allowed_from: ["received", "labeled"]
          }, 409);
        }

        if (current.outbound_tracking && current.outbound_tracking !== outbound && !force) {
          return jRes({
            error: "this package already has a different outbound_tracking",
            current_outbound: current.outbound_tracking,
            hint: "send force:true in body to overwrite"
          }, 409);
        }

        const dupes = await sbSelect("dropshipments",
          `?outbound_tracking=eq.${encodeURIComponent(outbound)}&select=id,tracking_number,status&limit=2`
        );
        const conflicting = dupes.find(d => d.id !== id);
        if (conflicting) {
          return jRes({
            error: "outbound_tracking is already linked to another package",
            conflict: { id: conflicting.id, tracking_number: conflicting.tracking_number, status: conflicting.status }
          }, 409);
        }

        const now = new Date().toISOString();
        const patch = {
          outbound_tracking: outbound
        };
        if (current.status === "received") {
          patch.status = "labeled";
          patch.labeled_at = now;
        }

        try {
          const updated = await sbPatch("dropshipments", `id=eq.${id}`, patch);
          return jRes({
            ok: true,
            action: "link_outbound",
            row: updated[0],
            transitioned: current.status === "received"
          });
        } catch (e) {
          if (String(e.message).includes("23505") || String(e.message).includes("duplicate")) {
            return jRes({ error: "outbound_tracking conflict (race condition)", detail: e.message }, 409);
          }
          throw e;
        }
      }

      // ── unlink_outbound: clear outbound_tracking (reset for re-scan) ────
      if (act === "unlink_outbound") {
        const id = body.id;
        if (!id) return jRes({ error: "id required" }, 400);
        const cur = await sbSelect("dropshipments", `?id=eq.${id}&select=id,status,outbound_tracking&limit=1`);
        if (!cur.length) return jRes({ error: "not found" }, 404);
        const updated = await sbPatch("dropshipments", `id=eq.${id}`, { outbound_tracking: null });
        return jRes({ ok: true, action: "unlink_outbound", row: updated[0], previous_outbound: cur[0].outbound_tracking });
      }

      // ── State machine transitions (receive/label/ship/revert/exception/resolve) ──
      const id = body.id;
      if (!id) return jRes({ error: "id required" }, 400);

      // Load the current row to validate the transition.
      // manifest_id added (Day 5) so revert can decide whether to clear it.
      // email_message_id + label_url added (Day 6) for the receive guard.
      const cur = await sbSelect("dropshipments", `?id=eq.${id}&select=id,status,label_url,email_message_id,tracking_number,outbound_tracking,client_id,carrier,order_id,content,outbound_carrier,manifest_id&limit=1`);
      if (!cur.length) return jRes({ error: "not found" }, 404);
      const current = cur[0];

      // Allowed transitions: (from, to) pairs
      const LEGAL = {
        receive:    { from: ["pending", "exception", "orphan"], to: "received",  ts: "physical_received_at", by: "received_by" },
        label:      { from: ["received"],                        to: "labeled",   ts: "labeled_at",           by: null },
        ship:       { from: ["labeled"],                         to: "shipped",   ts: "shipped_at",           by: "shipped_by" },
        revert:     { from: ["received", "labeled", "shipped"],  to: null,        ts: null,                   by: null },
        exception:  { from: ["pending", "received", "labeled"],  to: "exception", ts: null,                   by: null },
        resolve:    { from: ["exception"],                       to: "pending",   ts: null,                   by: null }
      };

      const rule = LEGAL[act];
      if (!rule) return jRes({ error: `unknown action '${act}'`, allowed: [...Object.keys(LEGAL), "create_orphan", "link_outbound", "unlink_outbound", "process_orphan", "delete_orphan"] }, 400);
      if (!rule.from.includes(current.status)) {
        return jRes({ error: `cannot ${act} from status '${current.status}'`, allowed_from: rule.from }, 409);
      }

      // ── Day 6: Receive guard (Option 2) ───────────────────────────────────
      // An orphan can only be promoted to `received` once it actually carries
      // its documents (the matched email and/or the printable label). Without
      // them, `received` would be a lie — the package can't be printed or
      // dispatched. We block the transition and keep it in `orphan` until the
      // Gmail sync attaches the email, or the operator runs Process Orphan
      // (which uploads the PDF). This makes `received` a hard guarantee:
      // every received package has a label.
      //
      // Note: this is scoped to orphan→received only. pending→received and
      // exception→received are unaffected (those rows came from a parsed email
      // and already have email_message_id + label_url set by the sync).
      if (act === "receive" && current.status === "orphan") {
        const hasEmail = !!current.email_message_id;
        const hasLabel = !!current.label_url;
        if (!hasEmail && !hasLabel) {
          return jRes({
            error: "orphan has no email/label yet",
            code: "ORPHAN_NO_DOCS",
            hint: "Recibido físico, pero sin email ni label todavía. Queda en Orphans hasta que el sync de Gmail lo empareje, o usa 'Process orphan' para subir el PDF manualmente.",
            tracking_number: current.tracking_number
          }, 409);
        }
      }

      // ── Revert from shipped: pre-flight check that the manifest is still open ──
      // Decision (chat 2026-05-08): if a package is in a SEALED manifest, we
      // hard-reject the revert. The manifest is legal evidence (signed by the
      // carrier driver). To "undo" a shipped package post-seal, the operator
      // must coordinate manually with the carrier and create a new exception
      // record — this isn't something the UI should let happen with a click.
      if (act === "revert" && current.status === "shipped" && current.manifest_id) {
        const mRows = await sbSelect("dropship_manifests",
          `?manifest_id=eq.${encodeURIComponent(current.manifest_id)}&select=manifest_id,status,sealed_at&limit=1`
        );
        if (mRows.length && mRows[0].status !== "open") {
          return jRes({
            error: "cannot revert a shipped package that's in a sealed manifest",
            manifest_id: mRows[0].manifest_id,
            manifest_status: mRows[0].status,
            sealed_at: mRows[0].sealed_at,
            hint: "the manifest has been sealed (carrier handoff). To dispute, mark this package as 'exception' instead."
          }, 409);
        }
      }

      // Build the patch payload.
      const patch = {};

      if (act === "revert") {
        const REVERT_TO = { received: "pending", labeled: "received", shipped: "labeled" };
        const CLEAR_TS  = { received: "physical_received_at", labeled: "labeled_at", shipped: "shipped_at" };
        const CLEAR_BY  = { received: "received_by", labeled: null, shipped: "shipped_by" };
        patch.status = REVERT_TO[current.status];
        patch[CLEAR_TS[current.status]] = null;
        if (CLEAR_BY[current.status]) patch[CLEAR_BY[current.status]] = null;
        // If reverting from shipped, also clear manifest_id (handled below in
        // the post-update block since we need the OLD manifest_id reference).
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
        if (act === "receive" && current.status === "orphan") {
          patch.orphan_alerted_at = null;
        }
      }

      const updated = await sbPatch("dropshipments", `id=eq.${id}`, patch);

      // ── Sync to shipments_general (Day 4: Billing Generator compatibility) ──
      if (act === "receive" || act === "ship") {
        try {
          const cfgRows = await sbSelect("dropship_client_configs",
            `?client_id=eq.${current.client_id}&select=client_name_billing,outbound_carrier&limit=1`
          );
          const cfg = cfgRows[0];

          if (!cfg?.client_name_billing) {
            console.warn(`[dropshipments.${act}] no client_name_billing configured for client_id=${current.client_id} — skipping shipments_general sync`);
          } else {
            const sgRow = act === "receive"
              ? {
                  tracking:  current.tracking_number,
                  direction: "Inbound",
                  type:      "Inbound (Drop-Shipment)",
                  carrier:   current.carrier || "Other",
                  client:    cfg.client_name_billing,
                  client_id: current.client_id,
                  notes:     `Order: ${current.order_id || "—"}${current.content ? ` · ${current.content}` : ""}`
                }
              : {
                  tracking:  current.outbound_tracking,
                  direction: "Outbound",
                  type:      "Outbound (Drop-Shipment)",
                  carrier:   current.outbound_carrier || cfg.outbound_carrier || "MailAmericas",
                  client:    cfg.client_name_billing,
                  client_id: current.client_id,
                  notes:     `Order: ${current.order_id || "—"}`
                };
            if (!sgRow.tracking) {
              console.warn(`[dropshipments.${act}] no tracking to sync (id=${id}) — skipping shipments_general sync`);
            } else {
              try {
                await sbInsert("shipments_general", sgRow);
                console.log(`[dropshipments.${act}] synced to shipments_general: ${sgRow.direction} ${sgRow.tracking}`);
              } catch (e) {
                if (String(e.message).includes("23505") || String(e.message).toLowerCase().includes("duplicate")) {
                  console.log(`[dropshipments.${act}] already in shipments_general: ${sgRow.tracking}`);
                } else {
                  throw e;
                }
              }
            }
          }
        } catch (e) {
          console.error(`[dropshipments.${act}] shipments_general sync failed (non-fatal):`, e.message);
        }
      }

      // ── Day 5: Manifest sync (auto-assign on ship, cleanup on revert) ──
      // Non-fatal: the primary status update already succeeded.
      if (act === "ship") {
        try {
          // Resolve the carrier — same fallback chain used by the shipments_general sync.
          const cfgRows = await sbSelect("dropship_client_configs",
            `?client_id=eq.${current.client_id}&select=outbound_carrier&limit=1`
          );
          const carrier = current.outbound_carrier || cfgRows[0]?.outbound_carrier || "MailAmericas";

          const result = await assignToOpenManifest({
            packageId:       current.id,
            outboundCarrier: carrier,
            operator,
          });
          console.log(`[dropshipments.ship] manifest assigned: ${result.manifest_id} (was_created=${result.was_created || false}, already_assigned=${result.already_assigned || false})`);
        } catch (e) {
          console.error(`[dropshipments.ship] manifest auto-assign failed (non-fatal):`, e.message);
        }
      }

      // Revert from shipped: clear manifest_id and decrement count.
      // The pre-flight check above already rejected if manifest was sealed.
      if (act === "revert" && current.status === "shipped" && current.manifest_id) {
        try {
          const result = await unassignFromManifest({
            packageId:  current.id,
            manifestId: current.manifest_id,
          });
          console.log(`[dropshipments.revert] manifest unassign:`, result);
        } catch (e) {
          console.error(`[dropshipments.revert] manifest unassign failed (non-fatal):`, e.message);
        }
      }

      return jRes({ ok: true, action: act, row: updated[0] });
    }

    return jRes({ error: "Method not allowed" }, 405);
  } catch (e) {
    console.error("[dropshipments]", e);
    return jRes({ error: e.message }, 500);
  }
}
