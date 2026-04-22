// netlify/functions/dashboard-warehouse-stats.js
// PURPOSE: Warehouse inbound/outbound metrics from shipments_general for the
//          unified KPI Dashboard (Warehouse tab).
//
// Returns:
// {
//   mtd: {
//     inbound:   { total, carton, pallet, rma, dropship },
//     outbound:  { total, package, pallet, dropship },
//     period:    'YYYY-MM'
//   },
//   today:       { inbound, outbound },
//   this_week:   { inbound, outbound },
//   volume_30d:  [{ date, inbound, outbound }],
//   by_client: [
//     { client, inbound_total, outbound_total, inbound_cartons, inbound_dropship, outbound_dropship }
//   ],
//   updated_at: ISO
// }

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

function sbHeaders() {
  return { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
}

async function sbSelect(table, query = '') {
  const r = await fetch(`${SB_URL}/rest/v1/${table}${query}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`sbSelect ${table}: ${await r.text()}`);
  return r.json();
}

function monthRange(d = new Date()) {
  const y = d.getFullYear();
  const m = d.getMonth();
  return {
    start: new Date(y, m, 1).toISOString(),
    end:   new Date(y, m + 1, 0, 23, 59, 59).toISOString(),
    label: `${y}-${String(m + 1).padStart(2, '0')}`
  };
}

function dateRange(daysBack) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - daysBack);
  start.setHours(0, 0, 0, 0);
  return { start: start.toISOString(), end: end.toISOString() };
}

exports.handler = async (event) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  try {
    // Load all shipments for the last 35 days (covers MTD + 30-day trend)
    const { start } = dateRange(35);
    const rows = await sbSelect('shipments_general',
      `?select=direction,type,client,created_at&created_at=gte.${start}&order=created_at.desc&limit=5000`
    );

    const mtdR  = monthRange();
    const mtdStart = new Date(mtdR.start).getTime();
    const mtdEnd   = new Date(mtdR.end).getTime();

    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();

    const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 7); weekStart.setHours(0, 0, 0, 0);
    const weekMs = weekStart.getTime();

    // ── Aggregation helpers ──────────────────────────────────────────────────
    const mtd = {
      inbound:  { total: 0, carton: 0, pallet: 0, rma: 0, dropship: 0 },
      outbound: { total: 0, package: 0, pallet: 0, dropship: 0 },
      period:   mtdR.label
    };
    const today     = { inbound: 0, outbound: 0 };
    const thisWeek  = { inbound: 0, outbound: 0 };
    const byClient  = {};
    const vol30Map  = {};

    // Seed 30-day volume map with zeros
    for (let i = 29; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i); d.setHours(0, 0, 0, 0);
      const k = d.toISOString().slice(0, 10);
      vol30Map[k] = { date: k, inbound: 0, outbound: 0 };
    }

    // ── Walk rows ────────────────────────────────────────────────────────────
    for (const r of rows) {
      const ts = new Date(r.created_at).getTime();
      const dir = (r.direction || '').toLowerCase();
      const type = (r.type || '').toLowerCase();
      const dateKey = r.created_at.slice(0, 10);

      // Volume 30d
      if (vol30Map[dateKey]) {
        if (dir === 'inbound')  vol30Map[dateKey].inbound++;
        if (dir === 'outbound') vol30Map[dateKey].outbound++;
      }

      // Today
      if (ts >= todayMs) {
        if (dir === 'inbound')  today.inbound++;
        if (dir === 'outbound') today.outbound++;
      }

      // This week
      if (ts >= weekMs) {
        if (dir === 'inbound')  thisWeek.inbound++;
        if (dir === 'outbound') thisWeek.outbound++;
      }

      // MTD
      if (ts >= mtdStart && ts <= mtdEnd) {
        if (dir === 'inbound') {
          mtd.inbound.total++;
          if (type.includes('rma'))        mtd.inbound.rma++;
          else if (type.includes('drop'))  mtd.inbound.dropship++;
          else if (type.includes('pallet')) mtd.inbound.pallet++;
          else                             mtd.inbound.carton++;
        }
        if (dir === 'outbound') {
          mtd.outbound.total++;
          if (type.includes('drop'))        mtd.outbound.dropship++;
          else if (type.includes('pallet')) mtd.outbound.pallet++;
          else                              mtd.outbound.package++;
        }

        // Per-client MTD aggregation
        const clientName = r.client || '—';
        if (!byClient[clientName]) {
          byClient[clientName] = {
            client: clientName,
            inbound_total: 0, outbound_total: 0,
            inbound_cartons: 0, inbound_dropship: 0, outbound_dropship: 0
          };
        }
        const c = byClient[clientName];
        if (dir === 'inbound') {
          c.inbound_total++;
          if (type.includes('drop')) c.inbound_dropship++;
          else                       c.inbound_cartons++;
        }
        if (dir === 'outbound') {
          c.outbound_total++;
          if (type.includes('drop')) c.outbound_dropship++;
        }
      }
    }

    const by_client = Object.values(byClient)
      .sort((a, b) => (b.inbound_total + b.outbound_total) - (a.inbound_total + a.outbound_total));

    const volume_30d = Object.values(vol30Map);

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        mtd,
        today,
        this_week: thisWeek,
        volume_30d,
        by_client,
        updated_at: new Date().toISOString()
      })
    };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
