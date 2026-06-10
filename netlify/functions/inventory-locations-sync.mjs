// netlify/functions/inventory-locations-sync.mjs
// FR-Logistics · Warehouse Occupancy Module · Sprint 1
// Sincroniza SkuVault getInventoryByLocation -> Supabase inventory_by_location
// Snapshot completo: borra e inserta en cada corrida.
//
// Env vars (ya existentes en Netlify):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//   SKUVAULT_TENANT_TOKEN  (formato "tenant|user", igual que inventory.js)
//
// Programada cada 2 horas. También se puede invocar manual:
//   GET https://apps.fr-logistics.net/.netlify/functions/inventory-locations-sync

const SV_URL = 'https://app.skuvault.com/api/inventory/getInventoryByLocation';
const PAGE_SIZE = 1000;
const THROTTLE_MS = 7000; // SkuVault: ~10 calls/min por endpoint

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const resp = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  },
});

function svTokens() {
  // Compatible con el patron de inventory.js: SKUVAULT_TENANT_TOKEN = "tenant|user"
  const t = process.env.SKUVAULT_TENANT_TOKEN || '';
  if (t.includes('|')) {
    const [TenantToken, UserToken] = t.split('|');
    return { TenantToken, UserToken };
  }
  return { TenantToken: t, UserToken: process.env.SKUVAULT_USER_TOKEN || '' };
}

async function svPage(pageNumber) {
  const { TenantToken, UserToken } = svTokens();
  const res = await fetch(SV_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      TenantToken,
      UserToken,
      IsReturnByCodes: false,
      PageNumber: pageNumber,
      PageSize: PAGE_SIZE,
    }),
  });
  if (res.status === 429) {
    await sleep(60000); // throttled: esperar 1 min y reintentar una vez
    return svPage(pageNumber);
  }
  if (!res.ok) throw new Error(`SkuVault ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sb(path, init = {}) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res;
}

export default async () => {
  const started = Date.now();
  try {
    // 1. Traer todas las páginas de SkuVault
    const records = [];
    let page = 0;
    for (;;) {
      const data = await svPage(page);
      const items = data.Items || {};
      const skus = Object.keys(items);
      if (skus.length === 0) break;

      for (const sku of skus) {
        // Agregar por (sku, location, reserve) — SkuVault puede repetir entradas
        const agg = {};
        for (const loc of items[sku]) {
          const code = (loc.LocationCode || '').trim();
          if (!code) continue;
          const key = `${code}|${loc.Reserve ? 1 : 0}`;
          agg[key] = (agg[key] || 0) + (loc.Quantity || 0);
        }
        for (const [key, qty] of Object.entries(agg)) {
          const [location_code, reserve] = key.split('|');
          records.push({
            sku,
            location_code,
            quantity: qty,
            is_reserve: reserve === '1',
          });
        }
      }

      if (skus.length < PAGE_SIZE) break;
      page += 1;
      await sleep(THROTTLE_MS);
    }

    // 2. Snapshot completo: borrar e insertar en lotes
    await sb('inventory_by_location?sku=neq.__none__', { method: 'DELETE' });

    const synced_at = new Date().toISOString();
    const BATCH = 500;
    for (let i = 0; i < records.length; i += BATCH) {
      await sb('inventory_by_location', {
        method: 'POST',
        headers: { Prefer: 'return=minimal,resolution=merge-duplicates' },
        body: JSON.stringify(
          records.slice(i, i + BATCH).map((r) => ({ ...r, synced_at }))
        ),
      });
    }

    return resp(200, {
      ok: true,
      pages: page + 1,
      rows: records.length,
      ms: Date.now() - started,
    });
  } catch (err) {
    console.error('inventory-locations-sync error:', err);
    return resp(500, { ok: false, error: String(err.message || err) });
  }
};

export const config = {
  schedule: '0 */2 * * *', // cada 2 horas
};
