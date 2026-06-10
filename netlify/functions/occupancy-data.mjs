// netlify/functions/occupancy-data.mjs
// FR-Logistics · Warehouse Occupancy · Sprint 2
// API de solo lectura para occupancy.html — lee las vistas de Supabase.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

const CACHE_TTL_MS = 2 * 60 * 1000;
let cache = { data: null, ts: 0 };

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function sb(path) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers });
  if (cache.data && Date.now() - cache.ts < CACHE_TTL_MS) {
    return new Response(JSON.stringify(cache.data), { status: 200, headers: { ...headers, 'X-Cache': 'HIT' } });
  }
  try {
    const [summary, locations, inventory, dims] = await Promise.all([
      sb('v_wh_occupancy_summary?select=*'),
      sb('v_wh_occupancy?select=*&order=location_code.asc'),
      sb('inventory_by_location?select=sku,location_code,quantity&order=quantity.desc&limit=2000'),
      sb('wh_product_dims?select=sku,cuft_per_unit&limit=2000'),
    ]);

    const cuft = Object.fromEntries(dims.map((d) => [d.sku, d.cuft_per_unit]));
    const detail = {};
    for (const r of inventory) {
      const v = cuft[r.sku];
      (detail[r.location_code] ||= []).push({
        sku: r.sku,
        qty: r.quantity,
        cuft: v != null ? Math.round(r.quantity * v * 100) / 100 : null,
      });
    }

    const payload = {
      generated_at: new Date().toISOString(),
      summary,
      locations,
      detail,
    };
    cache = { data: payload, ts: Date.now() };
    return new Response(JSON.stringify(payload), { status: 200, headers: { ...headers, 'X-Cache': 'MISS' } });
  } catch (err) {
    console.error('occupancy-data error:', err);
    return new Response(JSON.stringify({ error: String(err.message || err) }), { status: 502, headers });
  }
};
