// netlify/functions/billing-inbound.js
// PURPOSE: Count portal records by type for billing, separated by billing status
//
// Day 4: returns separate counts for unbilled (default) vs billed records
//        so the UI can show a banner warning when a period already has
//        invoiced packages.
//
// Response shape:
//   {
//     count, rmaCount, dropShipCount                          // UNBILLED only (backwards compatible — these are what gets invoiced)
//     billed:   { count, rmaCount, dropShipCount, invoices },  // already-invoiced rows in the same period
//     total:    { count, rmaCount, dropShipCount }             // unbilled + billed (sanity check)
//   }

const SB_BASE = `${process.env.SUPABASE_URL}/rest/v1/shipments_general`;

function sbHeaders() {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
}

exports.handler = async (event) => {
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: h, body: '' };

  const p      = event.queryStringParameters || {};
  const client = (p.client || '').trim();
  const start  = p.start || '';
  const end    = p.end   || '';

  if (!client) return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'client required' }) };

  const cFilter = `&client=ilike.*${encodeURIComponent(client)}*`;
  const dFilter = `${start ? `&created_at=gte.${start}T00:00:00` : ''}${end ? `&created_at=lte.${end}T23:59:59` : ''}`;
  const lim     = '&limit=500';
  const headers = sbHeaders();

  // Helper that builds a fetch for one category (direction/type combo) with
  // an optional billed filter ("is.null" for unbilled, "not.is.null" for billed).
  const buildUrl = (direction, typeCondition, billedCondition) => {
    const parts = [
      `select=id,direction,type,client,billing_id`,
      cFilter,
      `&direction=eq.${direction}`,
      typeCondition,
      dFilter,
      `&billed_at=${billedCondition}`,
      lim
    ];
    return `${SB_BASE}?${parts.join('').replace(/^&/, '')}`;
  };

  try {
    const [
      r1u, r2u, r3u,  // unbilled: inbound cartons, rma, drop-shipment
      r1b, r2b, r3b   // billed: same categories
    ] = await Promise.all([
      // ── UNBILLED (what the Billing Generator will invoice) ──────────────
      fetch(buildUrl('Inbound',  '&type=not.ilike.*RMA*&type=not.ilike.*Drop*', 'is.null'), { headers }),
      fetch(buildUrl('Inbound',  '&type=ilike.*RMA*',                           'is.null'), { headers }),
      fetch(buildUrl('Outbound', '&type=ilike.*Drop*',                          'is.null'), { headers }),
      // ── BILLED (already invoiced in a previous run) ─────────────────────
      fetch(buildUrl('Inbound',  '&type=not.ilike.*RMA*&type=not.ilike.*Drop*', 'not.is.null'), { headers }),
      fetch(buildUrl('Inbound',  '&type=ilike.*RMA*',                           'not.is.null'), { headers }),
      fetch(buildUrl('Outbound', '&type=ilike.*Drop*',                          'not.is.null'), { headers }),
    ]);

    // Any failure bubbles up with detail for diagnostics.
    const allRes = [r1u, r2u, r3u, r1b, r2b, r3b];
    const failed = allRes.find(r => !r.ok);
    if (failed) {
      return { statusCode: failed.status, headers: h, body: JSON.stringify({ error: await failed.text() }) };
    }

    const [unbInbound, unbRma, unbDrop, bInbound, bRma, bDrop] =
      await Promise.all(allRes.map(r => r.json()));

    // If there are any billed rows, enrich with invoice numbers
    // (fetch billing_runs entries that cover this client and period).
    let billedInvoices = [];
    if (bInbound.length || bRma.length || bDrop.length) {
      try {
        const billingIds = new Set([
          ...bInbound.map(r => r.billing_id),
          ...bRma.map(r => r.billing_id),
          ...bDrop.map(r => r.billing_id),
        ].filter(Boolean));

        if (billingIds.size > 0) {
          const idsParam = [...billingIds].map(id => `"${id}"`).join(',');
          const runsUrl = `${process.env.SUPABASE_URL}/rest/v1/billing_runs?id=in.(${idsParam})&select=id,invoice_number,period_start,period_end,total_usd,package_count,generated_at`;
          const runsRes = await fetch(runsUrl, { headers });
          if (runsRes.ok) {
            billedInvoices = await runsRes.json();
          }
        }
      } catch (_) {
        // Non-fatal: if billing_runs lookup fails, we still return the counts.
      }
    }

    return {
      statusCode: 200,
      headers: h,
      body: JSON.stringify({
        // Backwards-compatible fields (these are UNBILLED — what gets invoiced)
        count:         unbInbound.length,
        rmaCount:      unbRma.length,
        dropShipCount: unbDrop.length,
        // Rich billing breakdown (Day 4+)
        billed: {
          count:         bInbound.length,
          rmaCount:      bRma.length,
          dropShipCount: bDrop.length,
          invoices:      billedInvoices
        },
        total: {
          count:         unbInbound.length + bInbound.length,
          rmaCount:      unbRma.length     + bRma.length,
          dropShipCount: unbDrop.length    + bDrop.length
        },
        client, start, end
      })
    };
  } catch (err) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: err.message }) };
  }
};
