// netlify/functions/billing-mark-invoiced.js
// PURPOSE: Finalize an invoice by creating a billing_runs entry and marking
//          all unbilled shipments_general rows of the client+period as invoiced.
//
// NEW (Sprint 1 — billed_orders):
// - Accepts client_id (UUID) and prefers it over name-based ILIKE matching
// - Inserts a row in billed_orders for each ShipStation order_id passed in
// - Returns shipstation_marked count for verification
//
// POST body:
// {
//   client:           "LN Store, LLC",
//   client_id:        "82fa726f-929b-41d7-97ab-947ebfe740ab",   // NEW (preferred)
//   client_code:      "LN",
//   period_start:     "2026-04-01",
//   period_end:       "2026-04-30",
//   total_usd:        78.00,
//   package_count:    13,
//   line_items:       [{service, qty, rate, total}],
//   operator:         "Joe",
//   invoice_number:   "INV-2026-04-LN",
//   shipstation_orders: [                                        // NEW
//     { order_id: "12345", source: "shipstation_pp", carrier_cost: 5.20 },
//     ...
//   ]
// }
//
// Behavior:
// - Auto-generates invoice_number if not provided: INV-{YYYY}-{MM}-{CLIENT_CODE}
// - Rejects if invoice_number already exists (409)
// - Creates billing_runs row, UPDATEs unbilled shipments_general rows
// - INSERTs billed_orders rows for each ShipStation order_id (non-fatal on error)
// - Returns { ok, invoice_number, billing_id, marked_count, shipstation_marked, total_usd }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

function sbHeaders(extra = {}) {
  return {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

async function sbInsert(table, data) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: sbHeaders({ 'Prefer': 'return=representation' }),
    body: JSON.stringify(data)
  });
  if (!r.ok) {
    const err = new Error(`sbInsert ${table}: ${await r.text()}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

async function sbSelect(table, query = '') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`sbSelect ${table}: ${await r.text()}`);
  return r.json();
}

async function sbPatch(table, filter, data) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: sbHeaders({ 'Prefer': 'return=representation' }),
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(`sbPatch ${table}: ${await r.text()}`);
  return r.json();
}

function autoInvoiceNumber(cadence, periodEnd, clientCode) {
  // weekly / biweekly / custom -> INV-YYYY-MM-DD-CODE
  // monthly                    -> INV-YYYY-MM-CODE
  const [year, month, day] = (periodEnd || '').split('-');
  const code = (clientCode || 'UNK').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cadence === 'weekly' || cadence === 'biweekly' || cadence === 'custom') {
    return `INV-${year}-${month}-${day}-${code}`;
  }
  return `INV-${year}-${month}-${code}`;
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const client            = (body.client || '').trim();
  const clientId          = (body.client_id || '').trim();         // NEW
  const clientCode        = (body.client_code || '').trim();
  const periodStart       = (body.period_start || '').trim();
  const periodEnd         = (body.period_end || '').trim();
  const totalUsd          = Number(body.total_usd);
  const packageCount      = Number(body.package_count || 0);
  const lineItems         = body.line_items || null;
  const operator          = (body.operator || '').trim() || null;
  const notes             = (body.notes || '').trim() || null;
  let   invoiceNumber     = (body.invoice_number || '').trim();
  const shipstationOrders = Array.isArray(body.shipstation_orders) ? body.shipstation_orders : [];  // NEW

  // ── Validate ────────────────────────────────────────────────────────────
  if (!client) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'client required' }) };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart)) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'period_start must be YYYY-MM-DD' }) };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'period_end must be YYYY-MM-DD' }) };
  }
  if (!Number.isFinite(totalUsd) || totalUsd < 0) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'total_usd must be a non-negative number' }) };
  }

  // Auto-generate invoice_number if not provided (cadence-aware)
  if (!invoiceNumber) {
    const matches = await sbSelect(
      'fr_clients',
      `?or=(name.eq.${encodeURIComponent(client)},store_name.eq.${encodeURIComponent(client)})&select=billing_cadence&limit=1`
    );
    const cadence = matches[0]?.billing_cadence || 'monthly';
    invoiceNumber = autoInvoiceNumber(cadence, periodEnd, clientCode);
  }

  // ── Check uniqueness of invoice_number ──────────────────────────────────
  const existing = await sbSelect('billing_runs', `?invoice_number=eq.${encodeURIComponent(invoiceNumber)}&select=id,invoice_number,client,generated_at&limit=1`);
  if (existing.length) {
    return {
      statusCode: 409,
      headers: cors,
      body: JSON.stringify({
        error: 'invoice_number already exists',
        existing: existing[0],
        hint: 'choose a different invoice_number or delete the existing billing_run in Supabase'
      })
    };
  }

  try {
    // ── Step 1: Create billing_runs row ───────────────────────────────────
    const [run] = await sbInsert('billing_runs', {
      invoice_number:  invoiceNumber,
      client,
      client_id:       clientId || null,   // NEW: persist UUID for FK integrity
      client_code:     clientCode || null,
      period_start:    periodStart,
      period_end:      periodEnd,
      total_usd:       totalUsd,
      package_count:   packageCount,
      line_items_json: lineItems,
      generated_by:    operator,
      notes
    });

    if (!run?.id) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'billing_run creation returned no id' }) };
    }

    // ── Step 2: Mark unbilled shipments_general rows ──────────────────────
    // PREFERRED: client_id=eq.UUID (consistent with fr_clients FK).
    // FALLBACK:  client=ilike.*name*  (when older callers don't pass client_id).
    const filter = clientId
      ? [
          `client_id=eq.${clientId}`,
          `created_at=gte.${periodStart}T00:00:00`,
          `created_at=lte.${periodEnd}T23:59:59`,
          `billed_at=is.null`
        ].join('&')
      : [
          `client=ilike.*${encodeURIComponent(client)}*`,
          `created_at=gte.${periodStart}T00:00:00`,
          `created_at=lte.${periodEnd}T23:59:59`,
          `billed_at=is.null`
        ].join('&');

    const marked = await sbPatch('shipments_general', filter, {
      billed_at:  new Date().toISOString(),
      billing_id: run.id
    });

    // ── Step 3: NEW — Track ShipStation orders in billed_orders ───────────
    // Non-fatal: if this fails, the invoice is still valid. We log for visibility.
    let shipstationMarked = 0;
    if (shipstationOrders.length > 0 && clientId) {
      try {
        const rows = shipstationOrders
          .filter(o => o && o.order_id)
          .map(o => ({
            order_id:     String(o.order_id),
            client_id:    clientId,
            billing_id:   run.id,
            source:       o.source || 'shipstation_pp',
            carrier_cost: Number(o.carrier_cost) || 0
          }));
        if (rows.length > 0) {
          const inserted = await sbInsert('billed_orders', rows);
          shipstationMarked = Array.isArray(inserted) ? inserted.length : 0;
        }
      } catch (err) {
        console.warn(`billed_orders insert failed: ${err.message}`);
      }
    }

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        ok:                 true,
        invoice_number:     run.invoice_number,
        billing_id:         run.id,
        marked_count:       marked.length,
        shipstation_marked: shipstationMarked,   // NEW
        total_usd:          totalUsd,
        period:             { start: periodStart, end: periodEnd },
        client
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: err.message, stack: err.stack })
    };
  }
};
