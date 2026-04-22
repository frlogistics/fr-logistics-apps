// netlify/functions/dashboard-billing-stats.js
// PURPOSE: Billing metrics for the unified KPI Dashboard (Billing tab).
//
// Returns:
// {
//   mtd: {
//     invoiced_amount,   invoiced_count,      // already generated this month
//     unbilled_amount,   unbilled_count,      // packages not yet invoiced (estimated at $6/dropship)
//     total_amount                            // invoiced + unbilled
//   },
//   recent_invoices: [
//     { id, invoice_number, client, period_start, period_end, total_usd, package_count, generated_at }
//   ],
//   pending_by_client: [
//     { client, unbilled_count, unbilled_est_usd, oldest_unbilled_at }
//   ],
//   revenue_6m: [{ month: 'YYYY-MM', total }],
//   updated_at: ISO
// }

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const DROPSHIP_RATE_USD = 6.00; // per drop-shipment package (default estimate for unbilled)

function sbHeaders() {
  return { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
}

async function sbSelect(table, query = '') {
  const r = await fetch(`${SB_URL}/rest/v1/${table}${query}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`sbSelect ${table}: ${await r.text()}`);
  return r.json();
}

function monthBoundsISO(d = new Date()) {
  const y = d.getFullYear();
  const m = d.getMonth();
  return {
    start: new Date(y, m, 1).toISOString(),
    end:   new Date(y, m + 1, 0, 23, 59, 59).toISOString(),
    label: `${y}-${String(m + 1).padStart(2, '0')}`
  };
}

exports.handler = async (event) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  try {
    const now = new Date();
    const { start: mtdStart, end: mtdEnd, label: mtdLabel } = monthBoundsISO(now);

    // 6 months back for revenue trend
    const trendStart = new Date(now.getFullYear(), now.getMonth() - 5, 1).toISOString();

    // ── Parallel fetches ─────────────────────────────────────────────────────
    const [
      invoicedThisMonth,
      recentInvoices,
      unbilledInPeriod,
      revenueTrendRows
    ] = await Promise.all([
      // Invoices generated this month (billing_runs)
      sbSelect('billing_runs',
        `?generated_at=gte.${mtdStart}&generated_at=lte.${mtdEnd}&select=id,invoice_number,client,period_start,period_end,total_usd,package_count,generated_at&order=generated_at.desc`
      ),
      // Last 10 invoices overall (for the "Recent invoices" table)
      sbSelect('billing_runs',
        `?select=id,invoice_number,client,period_start,period_end,total_usd,package_count,generated_at,generated_by&order=generated_at.desc&limit=10`
      ),
      // Unbilled drop-shipment rows — Outbound Drop-Shipment, billed_at IS NULL, in current month
      sbSelect('shipments_general',
        `?select=client,direction,type,created_at&direction=eq.Outbound&type=ilike.*Drop*&billed_at=is.null&created_at=gte.${mtdStart}&created_at=lte.${mtdEnd}&limit=5000`
      ),
      // Revenue trend: all billing_runs in last 6 months
      sbSelect('billing_runs',
        `?generated_at=gte.${trendStart}&select=total_usd,generated_at&limit=500`
      )
    ]);

    // ── MTD summary ─────────────────────────────────────────────────────────
    const invoicedAmount = invoicedThisMonth.reduce((s, r) => s + Number(r.total_usd || 0), 0);
    const invoicedCount  = invoicedThisMonth.length;

    const unbilledCount    = unbilledInPeriod.length;
    const unbilledEstUsd   = unbilledCount * DROPSHIP_RATE_USD;

    const mtd = {
      period:             mtdLabel,
      invoiced_amount:    Math.round(invoicedAmount * 100) / 100,
      invoiced_count:     invoicedCount,
      unbilled_amount:    Math.round(unbilledEstUsd * 100) / 100,
      unbilled_count:     unbilledCount,
      total_amount:       Math.round((invoicedAmount + unbilledEstUsd) * 100) / 100
    };

    // ── Pending-to-bill by client ───────────────────────────────────────────
    const pendMap = {};
    for (const r of unbilledInPeriod) {
      const c = r.client || '—';
      if (!pendMap[c]) {
        pendMap[c] = { client: c, unbilled_count: 0, unbilled_est_usd: 0, oldest_unbilled_at: r.created_at };
      }
      pendMap[c].unbilled_count++;
      pendMap[c].unbilled_est_usd += DROPSHIP_RATE_USD;
      if (new Date(r.created_at) < new Date(pendMap[c].oldest_unbilled_at)) {
        pendMap[c].oldest_unbilled_at = r.created_at;
      }
    }
    const pending_by_client = Object.values(pendMap)
      .map(p => ({ ...p, unbilled_est_usd: Math.round(p.unbilled_est_usd * 100) / 100 }))
      .sort((a, b) => b.unbilled_count - a.unbilled_count);

    // ── Revenue 6-month trend ───────────────────────────────────────────────
    const trendMap = {};
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      trendMap[k] = { month: k, total: 0 };
    }
    for (const r of revenueTrendRows) {
      const d = new Date(r.generated_at);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (trendMap[k]) trendMap[k].total += Number(r.total_usd || 0);
    }
    const revenue_6m = Object.values(trendMap)
      .map(t => ({ ...t, total: Math.round(t.total * 100) / 100 }));

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        mtd,
        recent_invoices: recentInvoices,
        pending_by_client,
        revenue_6m,
        updated_at: new Date().toISOString()
      })
    };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
