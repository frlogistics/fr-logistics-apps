// netlify/functions/billing-inbound.js
// PURPOSE: Count portal records by type for billing
// Returns: count (inbound), rmaCount (returns), dropShipCount (drop-shipments)

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

  const base     = `${SB_BASE}?select=id,direction,type,client`;
  const cFilter  = `&client=ilike.*${encodeURIComponent(client)}*`;
  const dFilter  = `${start ? `&created_at=gte.${start}T00:00:00` : ''}${end ? `&created_at=lte.${end}T23:59:59` : ''}`;
  const lim      = '&limit=500';
  const headers  = sbHeaders();

  try {
    const [r1, r2, r3] = await Promise.all([
      // Inbound cartons — excludes RMA and Drop-Shipment
      fetch(`${base}${cFilter}&direction=eq.Inbound&type=not.ilike.*RMA*&type=not.ilike.*Drop*${dFilter}${lim}`, { headers }),
      // Returns / RMA
      fetch(`${base}${cFilter}&direction=eq.Inbound&type=ilike.*RMA*${dFilter}${lim}`, { headers }),
      // Drop-Shipment outbound (this is where the $6 charge triggers)
      fetch(`${base}${cFilter}&direction=eq.Outbound&type=ilike.*Drop*${dFilter}${lim}`, { headers }),
    ]);

    if (!r1.ok || !r2.ok || !r3.ok) {
      const failed = [r1, r2, r3].find(r => !r.ok);
      return { statusCode: failed.status, headers: h, body: JSON.stringify({ error: await failed.text() }) };
    }

    const [inbound, rma, drop] = await Promise.all([r1.json(), r2.json(), r3.json()]);

    return {
      statusCode: 200,
      headers: h,
      body: JSON.stringify({
        count:         inbound.length,
        rmaCount:      rma.length,
        dropShipCount: drop.length,
        client, start, end,
      })
    };
  } catch (err) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: err.message }) };
  }
};
