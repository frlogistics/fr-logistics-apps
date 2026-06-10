// netlify/functions/dims-shipstation-import.mjs
// FR-Logistics · One-off: importa dimensiones de producto desde ShipStation
// a wh_product_dims (solo SKUs con L/W/H completos, no sobrescribe existentes).
//
// Env vars (ya existentes): SUPABASE_URL, SUPABASE_SERVICE_KEY,
//   SHIPSTATION_API_KEY, SHIPSTATION_API_SECRET
//   (verificar nombres exactos contra dashboard-kpis.js — usar los mismos)
//
// Invocar manual:
//   GET https://apps.fr-logistics.net/.netlify/functions/dims-shipstation-import
// Se puede borrar del repo después de usarla.

const SS_BASE = 'https://ssapi.shipstation.com';

const resp = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
});

function ssAuth() {
  const key = process.env.SS_API_KEY;
const secret = process.env.SS_API_SECRET;
  return 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');
}

async function sb(path, init = {}) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res;
}

export default async () => {
  try {
    // 1. SKUs que ya tienen dims (no sobrescribir)
    const existing = await (await sb('wh_product_dims?select=sku', {
      headers: { Prefer: 'count=none' },
    })).json();
    const have = new Set(existing.map((r) => r.sku));

    // 2. Paginar productos de ShipStation
    const found = [];
    let pg = 1;
    for (;;) {
      const res = await fetch(`${SS_BASE}/products?page=${pg}&pageSize=500`, {
        headers: { Authorization: ssAuth() },
      });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 40000));
        continue;
      }
      if (!res.ok) throw new Error(`ShipStation ${res.status}: ${await res.text()}`);
      const data = await res.json();
      for (const p of data.products || []) {
        const sku = (p.sku || '').trim();
        const L = p.length, W = p.width, H = p.height;
        if (sku && L > 0 && W > 0 && H > 0 && !have.has(sku)) {
          found.push({
            sku,
            length_in: L,
            width_in: W,
            height_in: H,
            source: 'shipstation',
          });
          have.add(sku);
        }
      }
      if (pg >= (data.pages || 1)) break;
      pg += 1;
    }

    // 3. Upsert en lotes
    const BATCH = 500;
    for (let i = 0; i < found.length; i += BATCH) {
      await sb('wh_product_dims?on_conflict=sku', {
        method: 'POST',
        headers: { Prefer: 'return=minimal,resolution=ignore-duplicates' },
        body: JSON.stringify(found.slice(i, i + BATCH)),
      });
    }

    return resp(200, { ok: true, pages: pg, imported: found.length });
  } catch (err) {
    console.error('dims-shipstation-import error:', err);
    return resp(500, { ok: false, error: String(err.message || err) });
  }
};
