// netlify/functions/inventory-locations-sync.mjs
// FR-Logistics · Warehouse Occupancy · Sprint 3 (v4: + client mapping)
// SkuVault getProducts (filtro IsAlternateSKU) + getInventoryByLocation -> Supabase
// Snapshot completo: borra e inserta en cada corrida.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SKUVAULT_TENANT_TOKEN ("tenant|user")
// Manual: GET https://apps.fr-logistics.net/.netlify/functions/inventory-locations-sync

const SV_BASE = 'https://app.skuvault.com/api';
const PAGE_SIZE = 1000;
const THROTTLE_MS = 7000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const resp = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
});

function svTokens() {
  const t = process.env.SKUVAULT_TENANT_TOKEN || '';
  if (t.includes('|')) {
    const [TenantToken, UserToken] = t.split('|');
    return { TenantToken, UserToken };
  }
  return { TenantToken: t, UserToken: process.env.SKUVAULT_USER_TOKEN || '' };
}

async function sv(path, body) {
  const res = await fetch(`${SV_BASE}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...svTokens(), ...body }),
  });
  if (res.status === 429) {
    await sleep(60000);
    return sv(path, body);
  }
  if (!res.ok) throw new Error(`SkuVault ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

// SKUs primarios (excluye alternos) + cliente por SKU, mismo criterio que el tab Inventory
function clientOf(p) {
  // Campo nativo Client de SkuVault (matchea fr_clients.name), igual que dashboard-kpis.js
  if (p.Client && String(p.Client).trim()) return String(p.Client).trim();
  for (const a of p.Attributes || []) {
    if (/client/i.test(a.Name || '') && a.Value) return String(a.Value).trim();
  }
  return 'Unassigned';
}

async function primarySkus() {
  const primaries = new Set();
  const clients = {};
  let page = 0;
  for (;;) {
    const data = await sv('products/getProducts', { PageNumber: page, PageSize: 10000 });
    const prods = data.Products || [];
    for (const p of prods) {
      if (p.IsAlternateSKU !== true && p.Sku) {
        const sku = p.Sku.trim();
        primaries.add(sku);
        clients[sku] = clientOf(p);
      }
    }
    if (prods.length < 10000) break;
    page += 1;
    await sleep(THROTTLE_MS);
  }
  return { primaries, clients };
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
    const { primaries, clients } = await primarySkus();
    await sleep(THROTTLE_MS);

    const records = [];
    let page = 0;
    let skippedAlt = 0;
    for (;;) {
      const data = await sv('inventory/getInventoryByLocation', {
        IsReturnByCodes: false,
        PageNumber: page,
        PageSize: PAGE_SIZE,
      });
      const items = data.Items || {};
      const skus = Object.keys(items);
      if (skus.length === 0) break;

      for (const sku of skus) {
        const clean = sku.trim();
        if (!primaries.has(clean)) { skippedAlt += 1; continue; }
        const agg = {};
        for (const loc of items[sku]) {
          const code = (loc.LocationCode || '').trim();
          if (!code) continue;
          const key = `${code}|${loc.Reserve ? 1 : 0}`;
          agg[key] = (agg[key] || 0) + (loc.Quantity || 0);
        }
        for (const [key, qty] of Object.entries(agg)) {
          const [location_code, reserve] = key.split('|');
          records.push({ sku: clean, location_code, quantity: qty, is_reserve: reserve === '1' });
        }
      }

      if (skus.length < PAGE_SIZE) break;
      page += 1;
      await sleep(THROTTLE_MS);
    }

    await sb('inventory_by_location?sku=neq.__none__', { method: 'DELETE' });

    const synced_at = new Date().toISOString();
    const BATCH = 500;
    for (let i = 0; i < records.length; i += BATCH) {
      await sb('inventory_by_location', {
        method: 'POST',
        headers: { Prefer: 'return=minimal,resolution=merge-duplicates' },
        body: JSON.stringify(records.slice(i, i + BATCH).map((r) => ({ ...r, synced_at }))),
      });
    }

    // Upsert de mapeo SKU -> cliente para los SKUs en piso
    const skusOnFloor = [...new Set(records.map((r) => r.sku))];
    const clientRows = skusOnFloor.map((sku) => ({ sku, client: clients[sku] || 'Unassigned' }));
    for (let i = 0; i < clientRows.length; i += BATCH) {
      await sb('wh_sku_clients?on_conflict=sku', {
        method: 'POST',
        headers: { Prefer: 'return=minimal,resolution=merge-duplicates' },
        body: JSON.stringify(clientRows.slice(i, i + BATCH)),
      });
    }

    return resp(200, {
      ok: true,
      clients_mapped: clientRows.length,
      primaries: primaries.size,
      skipped_alternates: skippedAlt,
      rows: records.length,
      ms: Date.now() - started,
    });
  } catch (err) {
    console.error('inventory-locations-sync error:', err);
    return resp(500, { ok: false, error: String(err.message || err) });
  }
};

export const config = {
  schedule: '0 */2 * * *',
};
