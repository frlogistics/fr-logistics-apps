// netlify/functions/dashboard-dropship-stats.js
// PURPOSE: Dropshipments pipeline metrics for the unified KPI Dashboard
//
// Returns:
// {
//   pipeline: { pending, received, labeled, shipped, orphan, exception, total },
//   stuck: {
//     pending_over_48h:   [{id, client, tracking, hours_stuck, email_received_at}],
//     received_over_24h:  [{id, client, tracking, hours_stuck, physical_received_at}],
//     labeled_over_6h:    [{id, client, tracking, hours_stuck, labeled_at}],
//     orphans:            [{id, client, tracking, hours_stuck, physical_received_at}]
//   },
//   by_client: [
//     { client_code, client_name, pending, received, labeled, shipped, stuck }
//   ],
//   volume_14d: [{ date: 'YYYY-MM-DD', received, shipped }],
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

function hoursBetween(iso, nowMs) {
  if (!iso) return null;
  return Math.round((nowMs - new Date(iso).getTime()) / 3.6e6 * 10) / 10;
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  try {
    // ── Load all dropshipments (with client info) + client configs ───────────
    const [rows, configs] = await Promise.all([
      sbSelect('dropshipments',
        '?select=id,client_id,tracking_number,order_id,status,email_received_at,physical_received_at,labeled_at,shipped_at,created_at&order=created_at.desc&limit=2000'
      ),
      sbSelect('dropship_client_configs',
        '?select=client_id,client_code,display_name,client_name_billing'
      )
    ]);

    const clientById = Object.fromEntries(configs.map(c => [c.client_id, c]));
    const now = Date.now();

    // ── Pipeline counts ──────────────────────────────────────────────────────
    const pipeline = { pending: 0, received: 0, labeled: 0, shipped: 0, orphan: 0, exception: 0, total: rows.length };
    for (const r of rows) {
      if (pipeline[r.status] !== undefined) pipeline[r.status]++;
    }

    // ── Stuck packages ───────────────────────────────────────────────────────
    const stuck = {
      pending_over_48h:  [],
      received_over_24h: [],
      labeled_over_6h:   [],
      orphans:           []
    };

    for (const r of rows) {
      const cfg       = clientById[r.client_id] || {};
      const clientLbl = cfg.display_name || cfg.client_code || '—';
      const base      = { id: r.id, client: clientLbl, tracking: r.tracking_number, order_id: r.order_id };

      if (r.status === 'pending') {
        const ts = r.email_received_at;
        const h  = hoursBetween(ts, now);
        if (h !== null && h > 48) {
          stuck.pending_over_48h.push({ ...base, hours_stuck: h, since: ts });
        }
      }

      if (r.status === 'received') {
        const ts = r.physical_received_at;
        const h  = hoursBetween(ts, now);
        if (h !== null && h > 24) {
          stuck.received_over_24h.push({ ...base, hours_stuck: h, since: ts });
        }
      }

      if (r.status === 'labeled') {
        const ts = r.labeled_at;
        const h  = hoursBetween(ts, now);
        if (h !== null && h > 6) {
          stuck.labeled_over_6h.push({ ...base, hours_stuck: h, since: ts });
        }
      }

      if (r.status === 'orphan') {
        const ts = r.physical_received_at;
        const h  = hoursBetween(ts, now);
        stuck.orphans.push({ ...base, hours_stuck: h, since: ts });
      }
    }

    // Sort each stuck list by most-stuck first
    for (const k of Object.keys(stuck)) {
      stuck[k].sort((a, b) => (b.hours_stuck || 0) - (a.hours_stuck || 0));
    }

    // ── Breakdown by client ─────────────────────────────────────────────────
    const byClientMap = {};
    for (const r of rows) {
      const cfg  = clientById[r.client_id] || {};
      const code = cfg.client_code || 'UNK';
      if (!byClientMap[code]) {
        byClientMap[code] = {
          client_code: code,
          client_name: cfg.display_name || cfg.client_name_billing || code,
          pending: 0, received: 0, labeled: 0, shipped: 0, orphan: 0, exception: 0,
          stuck: 0
        };
      }
      const entry = byClientMap[code];
      if (entry[r.status] !== undefined) entry[r.status]++;
    }

    // Count stuck per client
    const stuckIds = new Set([
      ...stuck.pending_over_48h.map(s => s.id),
      ...stuck.received_over_24h.map(s => s.id),
      ...stuck.labeled_over_6h.map(s => s.id),
      ...stuck.orphans.map(s => s.id)
    ]);
    for (const r of rows) {
      if (!stuckIds.has(r.id)) continue;
      const cfg  = clientById[r.client_id] || {};
      const code = cfg.client_code || 'UNK';
      if (byClientMap[code]) byClientMap[code].stuck++;
    }

    const by_client = Object.values(byClientMap).sort((a, b) => (b.pending + b.received + b.labeled) - (a.pending + a.received + a.labeled));

    // ── Volume last 14 days ─────────────────────────────────────────────────
    const volMap = {};
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      volMap[key] = { date: key, received: 0, shipped: 0 };
    }
    for (const r of rows) {
      if (r.physical_received_at) {
        const k = r.physical_received_at.slice(0, 10);
        if (volMap[k]) volMap[k].received++;
      }
      if (r.shipped_at) {
        const k = r.shipped_at.slice(0, 10);
        if (volMap[k]) volMap[k].shipped++;
      }
    }
    const volume_14d = Object.values(volMap);

    // ── Response ────────────────────────────────────────────────────────────
    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        pipeline,
        stuck,
        by_client,
        volume_14d,
        updated_at: new Date().toISOString()
      })
    };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
