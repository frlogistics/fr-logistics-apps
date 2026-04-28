// netlify/functions/billing-inbound.js
// PURPOSE: Count portal records by type for billing, separated by billing status
//
// v2 (2026-04-28): Captures Outbound (Shipment) packages separately from
//                  drop-shipments, so all outbound packages get counted correctly.

const SB_BASE = `${process.env.SUPABASE_URL}/rest/v1/shipments_general`;

function sbHeaders() {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
}

exports.handler = async (event) => {
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: h, body: '' };

  const p         = event.queryStringParameters || {};
  const client    = (p.client    || '').trim();
  const clientId  = (p.client_id || '').trim();
  const start     = p.start || '';
  const end       = p.end   || '';

  if (!client && !clientId) {
    return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'client or client_id required' }) };
  }

  const clientFilter = clientId
    ? `&client_id=eq.${encodeURIComponent(clientId)}`
    : `&client=ilike.*${encodeURIComponent(client)}*`;
  const dFilter = `${start ? `&created_at=gte.${start}T00:00:00` : ''}${end ? `&created_at=lte.${end}T23:59:59` : ''}`;
  const lim     = '&limit=500';
  const headers = sbHeaders();

  const buildUrl = (direction, typeCondition, billedCondition) => {
    const parts = [
      `select=id,direction,type,client,billing_id`,
      clientFilter,
      `&direction=eq.${direction}`,
      typeCondition,
      dFilter,
      `&billed_at=${billedCondition}`,
      lim,
    ];
    return `${SB_BASE}?${parts.join('').replace(/^&/, '')}`;
  };

  try {
    const [
      r_inGen_u, r_rma_u, r_inDrop_u, r_outShip_u, r_outDrop_u,
      r_inGen_b, r_rma_b, r_inDrop_b, r_outShip_b, r_outDrop_b,
    ] = await Promise.all([
      fetch(buildUrl('Inbound',  '&type=not.ilike.*RMA*&type=not.ilike.*Drop*', 'is.null'), { headers }),
      fetch(buildUrl('Inbound',  '&type=ilike.*RMA*',                            'is.null'), { headers }),
      fetch(buildUrl('Inbound',  '&type=ilike.*Drop*',                           'is.null'), { headers }),
      fetch(buildUrl('Outbound', '&type=not.ilike.*Drop*',                       'is.null'), { headers }),
      fetch(buildUrl('Outbound', '&type=ilike.*Drop*',                           'is.null'), { headers }),
      fetch(buildUrl('Inbound',  '&type=not.ilike.*RMA*&type=not.ilike.*Drop*', 'not.is.null'), { headers }),
      fetch(buildUrl('Inbound',  '&type=ilike.*RMA*',                            'not.is.null'), { headers }),
      fetch(buildUrl('Inbound',  '&type=ilike.*Drop*',                           'not.is.null'), { headers }),
      fetch(buildUrl('Outbound', '&type=not.ilike.*Drop*',                       'not.is.null'), { headers }),
      fetch(buildUrl('Outbound', '&type=ilike.*Drop*',                           'not.is.null'), { headers }),
    ]);

    const allRes = [r_inGen_u, r_rma_u, r_inDrop_u, r_outShip_u, r_outDrop_u, r_inGen_b, r_rma_b, r_inDrop_b, r_outShip_b, r_outDrop_b];
    const failed = allRes.find(r => !r.ok);
    if (failed) {
      return { statusCode: failed.status, headers: h, body: JSON.stringify({ error: await failed.text() }) };
    }

    const [u_inGen, u_rma, u_inDrop, u_outShip, u_outDrop, b_inGen, b_rma, b_inDrop, b_outShip, b_outDrop] =
      await Promise.all(allRes.map(r => r.json()));

    let billedInvoices = [];
    const billedRows = [...b_inGen, ...b_rma, ...b_inDrop, ...b_outShip, ...b_outDrop];
    if (billedRows.length) {
      try {
        const billingIds = new Set(billedRows.map(r => r.billing_id).filter(Boolean));
        if (billingIds.size > 0) {
          const idsParam = [...billingIds].map(id => `"${id}"`).join(',');
          const runsUrl = `${process.env.SUPABASE_URL}/rest/v1/billing_runs?id=in.(${idsParam})&select=id,invoice_number,period_start,period_end,total_usd,package_count,generated_at`;
          const runsRes = await fetch(runsUrl, { headers });
          if (runsRes.ok) billedInvoices = await runsRes.json();
        }
      } catch (_) { }
    }

    return {
      statusCode: 200,
      headers: h,
      body: JSON.stringify({
        count:                   u_inGen.length,
        rmaCount:                u_rma.length,
        dropShipCount:           u_outDrop.length,
        inboundDropshipCount:    u_inDrop.length,
        outboundCount:           u_outShip.length,
        outboundDropshipCount:   u_outDrop.length,
        billed: {
          count:                 b_inGen.length,
          rmaCount:              b_rma.length,
          dropShipCount:         b_outDrop.length,
          inboundDropshipCount:  b_inDrop.length,
          outboundCount:         b_outShip.length,
          outboundDropshipCount: b_outDrop.length,
          invoices:              billedInvoices,
        },
        total: {
          count:                 u_inGen.length + b_inGen.length,
          rmaCount:              u_rma.length   + b_rma.length,
          dropShipCount:         u_outDrop.length + b_outDrop.length,
          inboundDropshipCount:  u_inDrop.length + b_inDrop.length,
          outboundCount:         u_outShip.length + b_outShip.length,
          outboundDropshipCount: u_outDrop.length + b_outDrop.length,
        },
        client, client_id: clientId, start, end,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: err.message }) };
  }
};
