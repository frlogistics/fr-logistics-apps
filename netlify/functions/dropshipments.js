// netlify/functions/dropshipments.js
// Dropshipments · read/list + state machine transitions + orphan registration.
//
// Day 4: when a package transitions to `received` or `shipped`, we also insert
// a row into shipments_general (Inbound/Outbound Drop-Shipment) so the
// Billing Generator (billing.html → billing-inbound.js) can count it.
// Sync is forward-only (revert does not delete) and idempotent (duplicate
// trackings are swallowed silently).
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
//   action=label            → received          → labeled    (sets labeled_at)
//   action=ship             → labeled           → shipped    (sets shipped_at, shipped_by)
//   action=revert           → received/labeled/shipped → previous status (clears ts/by)
//   action=exception        → pending/received/labeled → exception (reason: body.reason)
//   action=resolve          → exception         → pending   (clears exception_reason)
//   action=create_orphan    → new row with status='orphan'  (body: tracking_number, client_id, operator)
//   action=link_outbound    → set outbound_tracking + transition received→labeled
//                             (body: id, outbound_tracking, operator, optional force:true)
//   action=unlink_outbound  → clear outbound_tracking (status unchanged)

const SUPABASE_URL  = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY  = Netlify.env.get("SUPABASE_SERVICE_KEY");
const SB_BUCKET     = "dropship-labels";

const SB = () => ({ "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" });
async function sbSelect(t, q = "") { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}${q}`, { headers: SB() }); if (!r.ok) throw new Error(`sbSelect ${t}: ${await r.text()}`); return r.json(); }
async function sbInsert(t, d) { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}`, { method: "POST", headers: { ...SB(), "Prefer": "return=representation" }, body: JSON.stringify(d) }); if (!r.ok) throw new Error(`sbInsert ${t}: ${await r.text()}`); return r.json(); }
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
    // ── GET: stats (KPI strip counts + dashboard KPIs) ────────────────────
    // Returns both:
    //   - status counts (pending, received, labeled, shipped, orphan, exception, total)
    //   - extended KPIs for the kpi-dash widget:
    //       shipped_today, shipped_this_month, oldest_pending_hours,
    //       received_today, orphans_aging (>6h)
    // Backward compatible — old callers ignore the new fields.
    if (req.method === "GET" && action === "stats") {
      const clientFilter = url.searchParams.get("client_id");
      const clientFilterParam = clientFilter ? `&client_id=eq.${clientFilter}` : "";

      // Primary fetch: status + key timestamps for ALL rows
      const rows = await sbSelect("dropshipments",
        `?select=status,physical_received_at,shipped_at${clientFilterParam}`
      );
      const counts = { pending: 0, received: 0, labeled: 0, shipped: 0, orphan: 0, exception: 0, total: rows.length };
      for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;

      // Extended KPIs — computed in-memory from the same fetch
      const now    = new Date();
      const today  = now.toISOString().slice(0, 10);                   // YYYY-MM-DD UTC
      const monthStart = today.slice(0, 7) + "-01";                    // YYYY-MM-01 UTC
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
        // Track oldest pending (status='pending' rows by their email_received_at if available;
        // since we didn't fetch that, we approximate using physical_received_at — pending
        // rows usually don't have it set, so this heuristic is for bonus warning only)
        if (r.status === "orphan" && r.physical_received_at) {
          const ts = new Date(r.physical_received_at);
          if (ts < sixHoursAgo) orphans_aging += 1;
        }
      }

      // Oldest pending: separate small query for accuracy (uses email_received_at)
      const pendingRows = await sbSelect("dropshipments",
        `?status=eq.pending&select=email_received_at&order=email_received_at.asc.nullslast&limit=1${clientFilterParam}`
      );
      if (pendingRows.length && pendingRows[0].email_received_at) {
        oldest_pending_at = pendingRows[0].email_received_at;
      }

      // Compute oldest_pending_hours from oldest_pending_at
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
    // Searches BOTH inbound (tracking_number) and outbound (outbound_tracking)
    // so operators can scan either the inbound carrier label OR the outbound
    // shipping label they just printed.
    //
    // Returns match_field: "tracking_number" | "outbound_tracking" so the UI
    // can tell the user how the match was found ("Found via outbound tracking").
    if (req.method === "GET" && action === "lookup") {
      const tracking = (url.searchParams.get("tracking") || "").trim();
      if (!tracking) return jRes({ error: "tracking required" }, 400);
      const enc = encodeURIComponent(tracking);
      const configMap = await loadConfigMap();
      // PostgREST doesn't natively support OR across two eq filters in a clean
      // way, so we use the `or=(...)` syntax: matches if EITHER field equals.
      const filter = `or=(tracking_number.eq.${enc},outbound_tracking.eq.${enc})`;
      const rows = await sbSelect("dropshipments", `?${filter}&select=${SELECT_WITH_CLIENT}&limit=5`);
      attachConfigs(rows, configMap);
      // Annotate each row with how it matched (informational, used by the UI toast).
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

        // Verify the client exists and is configured for dropshipments.
        const cfg = await sbSelect("dropship_client_configs", `?client_id=eq.${clientId}&select=client_id,client_code,display_name&limit=1`);
        if (!cfg.length) return jRes({ error: "client_id not configured for dropshipments" }, 400);

        // Idempotency: if a row with same (client_id, tracking) already exists, return conflict.
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

      // ── link_outbound: assign an outbound_tracking + transition to labeled ──
      // Used by the post-print "Link outbound trackings" modal. The operator
      // scans the carrier label barcode after printing; this writes the
      // outbound_tracking value and (if currently 'received') promotes the
      // row to 'labeled'.
      //
      // Body: { id, outbound_tracking, operator }
      // Optional body: { force: true }   → allow re-link if outbound is already set
      //
      // Returns 409 if the outbound_tracking is already used by another row.
      if (act === "link_outbound") {
        const id          = body.id;
        const outbound    = (body.outbound_tracking || "").trim();
        const force       = body.force === true;
        if (!id) return jRes({ error: "id required" }, 400);
        if (!outbound) return jRes({ error: "outbound_tracking required" }, 400);

        // ── Validation (Day 4: prevent accidental garbage inputs) ──
        // Length: 6-64 chars (tightened from 4 to block typos like "test1")
        if (outbound.length < 6 || outbound.length > 64) {
          return jRes({ error: "outbound_tracking must be 6-64 characters" }, 400);
        }
        // Format: alphanumeric only. Real carrier barcodes never contain
        // spaces, punctuation, or symbols — blocking them here catches
        // test strings ("test 123"), copy-paste errors with stray chars,
        // and emoji scans.
        if (!/^[A-Za-z0-9]+$/.test(outbound)) {
          return jRes({
            error: "outbound_tracking must contain only letters and digits (no spaces or symbols)"
          }, 400);
        }

        // Load the row and validate state.
        const cur = await sbSelect("dropshipments", `?id=eq.${id}&select=id,status,outbound_tracking,tracking_number&limit=1`);
        if (!cur.length) return jRes({ error: "not found" }, 404);
        const current = cur[0];

        // Reject if operator scanned the inbound tracking by mistake.
        // This is the most common human error: the inbound (TBA...) and the
        // outbound label are usually side-by-side on the package, and it's
        // easy to scan the wrong one. Catching it here surfaces a clear hint
        // instead of silently poisoning the row with the inbound as outbound.
        if (outbound === current.tracking_number) {
          return jRes({
            error: "outbound_tracking cannot be the same as the inbound tracking_number",
            hint: "looks like you scanned the inbound barcode — scan the OUTBOUND label (carrier barcode) instead"
          }, 400);
        }

        // Only allow link from received or labeled (re-link case).
        if (current.status !== "received" && current.status !== "labeled") {
          return jRes({
            error: `cannot link outbound from status '${current.status}'`,
            allowed_from: ["received", "labeled"]
          }, 409);
        }

        // Reject re-linking unless ?force=true (operator confirmed override).
        if (current.outbound_tracking && current.outbound_tracking !== outbound && !force) {
          return jRes({
            error: "this package already has a different outbound_tracking",
            current_outbound: current.outbound_tracking,
            hint: "send force:true in body to overwrite"
          }, 409);
        }

        // Reject if this outbound_tracking is already used by another row.
        // (Belt-and-suspenders; the partial UNIQUE INDEX in DB also enforces this.)
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
        // If currently received, promote to labeled (single-step link+transition).
        if (current.status === "received") {
          patch.status = "labeled";
          patch.labeled_at = now;
        }
        // For 're-link' on already-labeled rows, we keep status as labeled and
        // just overwrite the outbound_tracking. labeled_at stays as-is.

        try {
          const updated = await sbPatch("dropshipments", `id=eq.${id}`, patch);
          return jRes({
            ok: true,
            action: "link_outbound",
            row: updated[0],
            transitioned: current.status === "received"
          });
        } catch (e) {
          // PostgreSQL unique violation surfaces here if two clients race
          if (String(e.message).includes("23505") || String(e.message).includes("duplicate")) {
            return jRes({ error: "outbound_tracking conflict (race condition)", detail: e.message }, 409);
          }
          throw e;
        }
      }

      // ── unlink_outbound: clear outbound_tracking (reset for re-scan) ────
      // Used when the operator needs to undo a wrong link. Does NOT change
      // status — the row stays labeled if it was labeled.
      // Body: { id, operator }
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
      // Extra fields (client_id, outbound_tracking, carrier, order_id, content)
      // are needed for the shipments_general sync that happens after receive/ship
      // (Day 4 — Billing Generator compatibility).
      const cur = await sbSelect("dropshipments", `?id=eq.${id}&select=id,status,label_url,tracking_number,outbound_tracking,client_id,carrier,order_id,content,outbound_carrier&limit=1`);
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
      if (!rule) return jRes({ error: `unknown action '${act}'`, allowed: [...Object.keys(LEGAL), "create_orphan", "link_outbound", "unlink_outbound"] }, 400);
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
        // When an orphan is manually received, clear the alerted flag so the
        // record is eligible for a fresh alert if it ever returns to orphan.
        if (act === "receive" && current.status === "orphan") {
          patch.orphan_alerted_at = null;
        }
      }

      const updated = await sbPatch("dropshipments", `id=eq.${id}`, patch);

      // ── Sync to shipments_general (Day 4: Billing Generator compatibility) ──
      // Forward transitions only: receive creates the Inbound row,
      // ship creates the Outbound row. Revert does NOT delete — if a package
      // was wrongly shipped, fix it manually in shipments_general afterwards.
      //
      // Non-fatal: failures here are logged but don't bubble up. The primary
      // dropshipments update succeeded, and the billing sync can be reconciled
      // later if needed (idempotent — re-running the action is safe).
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
                  notes:     `Order: ${current.order_id || "—"}${current.content ? ` · ${current.content}` : ""}`
                }
              : {
                  tracking:  current.outbound_tracking,
                  direction: "Outbound",
                  type:      "Outbound (Drop-Shipment)",
                  carrier:   current.outbound_carrier || cfg.outbound_carrier || "MailAmericas",
                  client:    cfg.client_name_billing,
                  notes:     `Order: ${current.order_id || "—"}`
                };

            if (!sgRow.tracking) {
              console.warn(`[dropshipments.${act}] no tracking to sync (id=${id}) — skipping shipments_general sync`);
            } else {
              try {
                await sbInsert("shipments_general", sgRow);
                console.log(`[dropshipments.${act}] synced to shipments_general: ${sgRow.direction} ${sgRow.tracking}`);
              } catch (e) {
                // Unique constraint on tracking means this row was already synced.
                // Treat as success (idempotent behavior — same as the backfill SQL).
                if (String(e.message).includes("23505") || String(e.message).toLowerCase().includes("duplicate")) {
                  console.log(`[dropshipments.${act}] already in shipments_general: ${sgRow.tracking}`);
                } else {
                  throw e;
                }
              }
            }
          }
        } catch (e) {
          // Non-fatal: dropshipments update already succeeded. Log and move on.
          console.error(`[dropshipments.${act}] shipments_general sync failed (non-fatal):`, e.message);
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

export const config = { path: "/.netlify/functions/dropshipments" };
