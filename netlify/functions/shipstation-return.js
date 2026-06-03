// netlify/functions/shipstation-return.js
//
// FR-Logistics · Return Labels API
// Generic return-label + carrier-pickup creation for ANY client.
//
// Style: Netlify Functions v2 (ESM) — matches dropship-manifests.js /
// dropshipments.js. Uses Netlify.env.get() and new Response().
// NOTE: do NOT add `export const config = { path }` — Netlify rejects it
// for non-scheduled functions in this site.
//
// ────────────────────────────────────────────────────────────────────
// ⚠ PREREQUISITE (must confirm before this works):
//   UPS account must be connected INSIDE ShipStation (Settings → Carriers).
//   Without it, /labels cannot rate/generate with your UPS account.
//
// API: ShipStation API V2 (api.shipstation.com) — supports native
//   return_label flag + /v2/pickups endpoint (label-based pickups).
// ────────────────────────────────────────────────────────────────────

import { getStore } from "@netlify/blobs";

const SS_BASE      = "https://api.shipstation.com/v2";
// NOTE: distinct env var from the V1 KPI dashboard function (which uses
// SS_API_KEY + SS_API_SECRET). V2 uses a single API-Key header.
const SS_API_KEY   = Netlify.env.get("SS_V2_API_KEY");
const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY");

// UPS carrier connected inside ShipStation (account WE6433, negotiated rates ON).
// carrier_id confirmed in Settings → Shipping → Carriers.
const UPS_CARRIER_ID = "se-605521";

// Fixed destination: FR-Logistics warehouse (Ship To for all returns)
const WAREHOUSE_SHIP_TO = {
  name:          "FR-Logistics Miami",
  company_name:  "FR-Logistics Miami",
  phone:         "3052403172",
  address_line1: "10893 NW 17th St",
  address_line2: "Unit 121",
  city_locality: "Miami",
  state_province:"FL",
  postal_code:   "33172",
  country_code:  "US",
};

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const jRes = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

// ─── Supabase REST helpers (match existing function pattern) ──────────
async function sbInsert(table, row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`supabase insert failed: ${await r.text()}`);
  return (await r.json())[0];
}

async function sbPatch(table, filter, patch) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`supabase patch failed: ${await r.text()}`);
  return await r.json();
}

// ─── ShipStation V2 fetch helper ──────────────────────────────────────
async function ss(path, method = "GET", body = null) {
  const opts = {
    method,
    headers: { "API-Key": SS_API_KEY, "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${SS_BASE}${path}`, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`ShipStation ${method} ${path} → ${r.status}: ${JSON.stringify(data)}`);
  return data;
}

// ─── Email notification (Resend) ──────────────────────────────────────
const RESEND_KEY  = Netlify.env.get("RESEND_API_KEY");
const FROM_EMAIL  = "FR-Logistics Returns <warehouse@fr-logistics.net>";
const WAREHOUSE_CC = "warehouse@fr-logistics.net";

// Fetch the label PDF bytes and return base64 (for attachment)
async function fetchLabelPdfBase64(pdfUrl) {
  try {
    const r = await fetch(pdfUrl, { headers: { "API-Key": SS_API_KEY } });
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    // base64 encode
    let binary = "";
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  } catch (e) {
    return null;
  }
}

function returnEmailHtml({ clientName, contactName, tracking, pickupConfirm, pickupWindow, service }) {
  const pickupBlock = pickupConfirm
    ? `<tr><td style="padding:6px 0;color:#475569">UPS Pickup Confirmation</td>
         <td style="padding:6px 0;font-weight:700;color:#0f172a">${pickupConfirm}</td></tr>
       ${pickupWindow ? `<tr><td style="padding:6px 0;color:#475569">Pickup Window</td>
         <td style="padding:6px 0;color:#0f172a">${pickupWindow.start_at?.slice(0,16).replace("T"," ")} – ${pickupWindow.end_at?.slice(11,16)}</td></tr>` : ""}`
    : `<tr><td style="padding:6px 0;color:#475569">Pickup</td>
         <td style="padding:6px 0;color:#0f172a">Not scheduled — please drop off at any UPS location.</td></tr>`;
  return `<!doctype html><html><body style="margin:0;font-family:Arial,Helvetica,sans-serif;background:#f6f7fb;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
    <div style="background:#0F1D35;color:#fff;padding:18px 22px">
      <div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#16a3b5;font-weight:700">FR-Logistics Miami</div>
      <div style="font-size:20px;font-weight:800;margin-top:4px">Your Return Shipping Label</div>
    </div>
    <div style="padding:22px">
      <p style="color:#0f172a;font-size:14px;margin:0 0 14px">Hello ${contactName || "there"},</p>
      <p style="color:#475569;font-size:14px;line-height:1.5;margin:0 0 16px">
        Your UPS return label is attached to this email as a PDF. Print it, attach it to your package, and either hand it to the UPS driver at the scheduled pickup or drop it off at any UPS location.
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;border-top:1px solid #e2e8f0">
        <tr><td style="padding:6px 0;color:#475569;width:45%">Tracking Number</td>
            <td style="padding:6px 0;font-weight:700;color:#0f172a">${tracking}</td></tr>
        <tr><td style="padding:6px 0;color:#475569">Service</td>
            <td style="padding:6px 0;color:#0f172a">${service || "UPS Ground"}</td></tr>
        ${pickupBlock}
      </table>
      <div style="margin-top:18px;padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;color:#475569">
        The package will be returned to FR-Logistics Miami, 10893 NW 17th St, Unit 121, Miami, FL 33172.
      </div>
      <p style="color:#94a3b8;font-size:12px;margin:18px 0 0">If you have any questions, reply to this email.</p>
    </div>
  </div></body></html>`;
}

async function sendReturnEmail({ toEmail, clientName, contactName, tracking, pickupConfirm, pickupWindow, service, pdfBase64 }) {
  if (!RESEND_KEY) return { sent: false, reason: "RESEND_API_KEY missing" };
  const recipients = [];
  if (toEmail) recipients.push(toEmail);
  recipients.push(WAREHOUSE_CC);  // always copy warehouse

  const payload = {
    from: FROM_EMAIL,
    to: recipients,
    subject: `Return label — ${tracking}${pickupConfirm ? " · Pickup " + pickupConfirm : ""}`,
    html: returnEmailHtml({ clientName, contactName, tracking, pickupConfirm, pickupWindow, service }),
  };
  if (pdfBase64) {
    payload.attachments = [{ filename: `return-label-${tracking}.pdf`, content: pdfBase64 }];
  }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) return { sent: false, reason: `resend ${r.status}: ${await r.text()}` };
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

// ─── ACTION: create_return — label + pickup + persist ─────────────────
async function actionCreateReturn(body) {
  const {
    client,            // 'MXS Overseas Ltd'
    client_id,         // optional uuid
    ship_from,         // {name, company, line1, city, state, zip, phone, email}
    weight_oz,
    dims,              // {length, width, height}
    service_code,      // e.g. 'ups_ground'
    pickup_window,     // {start_at, end_at}  ISO 8601
    schedule_pickup,   // boolean
    notes,
  } = body;

  // --- validation (UPS requires company on ship-from) -------------------
  if (!client)              return jRes({ error: "client required" }, 400);
  if (!ship_from?.line1)    return jRes({ error: "ship_from address required" }, 400);
  if (!ship_from?.company)  return jRes({ error: "ship_from.company required (UPS rule)" }, 400);
  if (!weight_oz)           return jRes({ error: "weight required" }, 400);

  // --- 1) seed pending row so nothing is lost on partial failure --------
  const seed = await sbInsert("return_labels", {
    client,
    client_id:     client_id || null,
    status:        "pending_pickup",
    ship_from_json: ship_from,
    weight_oz,
    dims_json:     dims || null,
    carrier:       "UPS",
    service:       service_code || null,
    pickup_window: pickup_window || null,
    notes:         notes || null,
  });

  // --- 2) create the label (V2 native return flag) ----------------------
  // carrier_id resolved (se-605521). service_code defaults to ups_ground;
  // confirm exact code via GET ?action=carriers (lists each carrier's services).
  const labelPayload = {
    shipment: {
      carrier_id:   UPS_CARRIER_ID,                 // route to your UPS (WE6433)
      service_code: service_code || "ups_ground",
      ship_from: {
        name:          ship_from.name,
        company_name:  ship_from.company,
        phone:         ship_from.phone || "0000000000",
        address_line1: ship_from.line1,
        city_locality: ship_from.city,
        state_province:ship_from.state,
        postal_code:   ship_from.zip,
        country_code:  "US",
      },
      ship_to: WAREHOUSE_SHIP_TO,
      packages: [{
        weight: { value: weight_oz, unit: "ounce" },
        ...(dims ? { dimensions: { ...dims, unit: "inch" } } : {}),
      }],
    },
    is_return_label: true,
  };

  let label;
  try {
    label = await ss("/labels", "POST", labelPayload);
  } catch (e) {
    await sbPatch("return_labels", `id=eq.${seed.id}`, { status: "label_failed", notes: e.message });
    return jRes({ error: "label creation failed", detail: e.message, return_id: seed.id }, 502);
  }

  // store label PDF in Netlify Blobs (pattern from manifests)
  let label_url = label.label_download?.pdf || null;
  // (optional: fetch the PDF bytes and cache in Blobs like manifests do)

  await sbPatch("return_labels", `id=eq.${seed.id}`, {
    status:       "in_transit",
    label_id:     label.label_id,
    tracking:     label.tracking_number,
    carrier_cost: label.shipment_cost?.amount ?? null,
    label_url,
  });

  // --- 3) schedule pickup (label-based) ---------------------------------
  let pickup = null;
  let pickupError = null;
  if (schedule_pickup && pickup_window) {
    try {
      pickup = await ss("/pickups", "POST", {
        label_ids: [label.label_id],
        pickup_window,
        contact_details: {
          name:  ship_from.name,
          email: ship_from.email || "warehouse@fr-logistics.net",
          phone: ship_from.phone || "0000000000",
        },
        pickup_address: {
          name:          ship_from.name,
          company_name:  ship_from.company,
          phone:         ship_from.phone || "0000000000",
          address_line1: ship_from.line1,
          city_locality: ship_from.city,
          state_province:ship_from.state,
          postal_code:   ship_from.zip,
          country_code:  "US",
        },
      });
      await sbPatch("return_labels", `id=eq.${seed.id}`, {
        pickup_confirm:   pickup.confirmation_number || pickup.pickup_id,
        pickup_scheduled: true,
      });
    } catch (e) {
      // non-fatal: label already created; pickup can be retried
      pickupError = e.message;
      // Extract the human-readable message from ShipStation's error JSON if present
      try {
        const m = e.message.match(/"message":"([^"]+)"/);
        if (m) pickupError = m[1];
      } catch(_) {}
      await sbPatch("return_labels", `id=eq.${seed.id}`, {
        notes: `${notes || ""} | pickup_failed: ${e.message}`,
      });
    }
  }

  // --- 4) email notification (client final + warehouse copy, PDF attached) ---
  let emailResult = { sent: false, reason: "not attempted" };
  try {
    const pickupConfirm = pickup ? (pickup.confirmation_number || pickup.pickup_id) : null;
    const pdfBase64 = label_url ? await fetchLabelPdfBase64(label_url) : null;
    emailResult = await sendReturnEmail({
      toEmail:      ship_from.email || null,
      clientName:   client,
      contactName:  ship_from.name || ship_from.company,
      tracking:     label.tracking_number,
      pickupConfirm,
      pickupWindow: pickup_window,
      service:      service_code,
      pdfBase64,
    });
  } catch (e) {
    emailResult = { sent: false, reason: e.message };
  }

  return jRes({
    ok:             true,
    return_id:      seed.id,
    tracking:       label.tracking_number,
    carrier_cost:   label.shipment_cost?.amount ?? null,
    label_url,
    pickup_confirm: pickup?.confirmation_number || pickup?.pickup_id || null,
    pickup_error:   pickupError,   // null if no pickup requested or it succeeded
    email_sent:     emailResult.sent,
    email_error:    emailResult.sent ? null : emailResult.reason,
  });
}

// ─── ACTION: carriers — connection test + discover UPS carrier_id ─────
// Call this FIRST (GET ?action=carriers) to confirm UPS is connected and
// to grab the carrier_id (se-xxxxx) you'll need for label/service codes.
async function actionCarriers() {
  const data = await ss("/carriers", "GET");
  const list = (data.carriers || []).map((c) => ({
    carrier_id:        c.carrier_id,
    friendly_name:     c.friendly_name,
    carrier_code:      c.carrier_code,
    primary:           c.primary,
    has_funded_account:c.has_multi_package_supporting_services ?? null,
    services:          (c.services || []).map((s) => ({ code: s.service_code, name: s.name })),
  }));
  const ups = list.find((c) => /ups/i.test(c.carrier_code || c.friendly_name || ""));
  return jRes({
    ok: true,
    ups_connected: !!ups,
    ups,                       // null if UPS not connected → must connect in ShipStation
    all_carriers: list,
  });
}

// ─── ACTION: list — open returns (for the UI dashboard) ───────────────
async function actionList(url) {
  const status = url.searchParams.get("status") || "";
  const filter = status ? `&status=eq.${encodeURIComponent(status)}` : "";
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/return_labels?select=*${filter}&order=created_at.desc`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  return jRes(await r.json());
}

// ─── Handler ──────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (!SS_API_KEY)                       return jRes({ error: "SS_V2_API_KEY missing" }, 500);
  if (!SUPABASE_URL || !SUPABASE_KEY)    return jRes({ error: "SUPABASE env vars missing" }, 500);

  try {
    if (req.method === "GET") {
      const url = new URL(req.url);
      const action = url.searchParams.get("action") || "";
      if (action === "carriers") return await actionCarriers();
      if (action === "list")     return await actionList(url);
      return jRes({ error: `unknown GET action: ${action || "(none)"}` }, 400);
    }
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if ((body.action || "") === "create_return") return await actionCreateReturn(body);
      return jRes({ error: `unknown POST action: ${body.action || "(none)"}` }, 400);
    }
    return jRes({ error: `method not allowed: ${req.method}` }, 405);
  } catch (e) {
    console.error("[shipstation-return]", e);
    return jRes({ error: e.message || "internal error" }, 500);
  }
}
