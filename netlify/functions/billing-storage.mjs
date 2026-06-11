// netlify/functions/billing-storage.mjs
// FR-Logistics · Sprint 3 Phase 2 — Storage billing data per client
// Lee v_wh_storage_billing_month (promedio/pico mensual de ft³ por cliente,
// alimentado por los snapshots diarios de pg_cron).
//
// GET /.netlify/functions/billing-storage              -> mes anterior (ciclo de billing)
// GET /.netlify/functions/billing-storage?month=2026-06 -> mes específico
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function previousMonth() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers });
  try {
    const url = new URL(req.url);
    const month = url.searchParams.get('month') || previousMonth();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return new Response(JSON.stringify({ ok: false, error: 'month must be YYYY-MM' }), { status: 400, headers });
    }
    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/v_wh_storage_billing_month?billing_month=eq.${month}&select=*&order=avg_cuft.desc`,
      {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    const rows = await res.json();
    const total_avg_cuft = Math.round(rows.reduce((s, r) => s + Number(r.avg_cuft || 0), 0) * 100) / 100;
    return new Response(JSON.stringify({ ok: true, month, clients: rows.length, total_avg_cuft, rows }), {
      status: 200,
      headers,
    });
  } catch (err) {
    console.error('billing-storage error:', err);
    return new Response(JSON.stringify({ ok: false, error: String(err.message || err) }), { status: 500, headers });
  }
};
