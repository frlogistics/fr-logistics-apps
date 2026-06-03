// netlify/functions/billing-returns.js
//
// FR-Logistics · Billing — Returns aggregator
// Reads return_labels for a client + period and returns billable totals:
//   · pickupCount       → number of scheduled UPS pickups   (× carrier_pickup rate)
//   · returnCarrierCost → sum of carrier_cost (raw)          (× (1 + markup%) pass-through)
//   · labelCount        → number of return labels created
// Splits unbilled (billed_at IS NULL) vs already-billed, mirroring billing-inbound.
//
// Style: ESM, Netlify.env.get(), new Response() — matches shipstation-return.js.
//
// Query params:
//   client_id  (preferred)  — uuid, matches return_labels.client_id
//   client     (fallback)   — display name, matches return_labels.client
//   start, end              — ISO dates (YYYY-MM-DD), inclusive
//
// Response:
//   {
//     labelCount, pickupCount, returnCarrierCost,
//     billed: { labelCount, pickupCount, returnCarrierCost, invoices:[...] } | null,
//     returnIds: [uuid,...]   // unbilled ids, for mark-as-invoiced
//   }

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY");

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

async function sbSelect(qs) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/return_labels?${qs}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${await r.text()}`);
  return r.json();
}

function summarize(rows) {
  let pickupCount = 0;
  let returnCarrierCost = 0;
  rows.forEach((r) => {
    if (r.pickup_scheduled) pickupCount += 1;
    returnCarrierCost += parseFloat(r.carrier_cost || 0);
  });
  return {
    labelCount: rows.length,
    pickupCount,
    returnCarrierCost: Math.round(returnCarrierCost * 100) / 100,
  };
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!SUPABASE_URL || !SUPABASE_KEY) return jRes({ error: "SUPABASE env vars missing" }, 500);

  try {
    const url = new URL(req.url);
    const clientId = url.searchParams.get("client_id");
    const client   = url.searchParams.get("client");
    const start    = url.searchParams.get("start");
    const end      = url.searchParams.get("end");

    if (!start || !end) return jRes({ error: "start and end required" }, 400);
    if (!clientId && !client) return jRes({ error: "client_id or client required" }, 400);

    // Build the client filter (prefer client_id)
    const clientFilter = clientId
      ? `client_id=eq.${encodeURIComponent(clientId)}`
      : `client=eq.${encodeURIComponent(client)}`;

    // Period filter on created_at (the label-creation moment), inclusive of end day.
    // created_at is timestamptz; compare against date boundaries.
    const periodFilter =
      `created_at=gte.${start}T00:00:00&created_at=lte.${end}T23:59:59`;

    // Exclude cancelled/failed labels from billing
    const statusFilter = `status=neq.label_failed`;

    // 1) Unbilled rows (billed_at IS NULL)
    const unbilledRows = await sbSelect(
      `select=id,carrier_cost,pickup_scheduled,status,billed_at,invoice_id` +
      `&${clientFilter}&${periodFilter}&${statusFilter}&billed_at=is.null`
    );

    // 2) Already-billed rows in the same period (for the warning banner)
    const billedRows = await sbSelect(
      `select=id,carrier_cost,pickup_scheduled,invoice_id` +
      `&${clientFilter}&${periodFilter}&${statusFilter}&billed_at=not.is.null`
    );

    const unbilled = summarize(unbilledRows);
    const billed   = billedRows.length ? summarize(billedRows) : null;

    return jRes({
      ...unbilled,
      returnIds: unbilledRows.map((r) => r.id),
      billed: billed
        ? { ...billed, invoices: [...new Set(billedRows.map((r) => r.invoice_id).filter(Boolean))] }
        : null,
    });
  } catch (e) {
    console.error("[billing-returns]", e);
    return jRes({ error: e.message || "internal error" }, 500);
  }
}
