// netlify/functions/frm-alias-sync.mjs
// FR Mobile — builds the scanned-code -> merchant-SKU map in wh_fnsku_map.
// Reads SkuVault getProducts and captures each product's Code (FNSKU/barcode)
// and any alternate codes, mapping them to the merchant Sku used in inventory.
//
// ISOLATED: writes only to wh_fnsku_map. Does NOT touch inventory-locations-sync,
// inventory_by_location, wh_sku_aliases, or anything billing depends on.
//
// Manual run: GET https://apps.fr-logistics.net/.netlify/functions/frm-alias-sync
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SKUVAULT_TENANT_TOKEN ("tenant|user")

const SV_BASE = 'https://app.skuvault.com/api';
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
  if (res.status === 429) { await sleep(60000); return sv(path, body); }
  if (!res.ok) throw new Error(`SkuVault ${path} ${res.status}: ${await res.text()}`);
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

// Collect every code that could be scanned, mapped to the merchant SKU.
// SkuVault products carry: Sku (merchant), Code (primary barcode/FNSKU),
// and may carry alternate codes/skus. We map all non-empty codes -> Sku.
function collectCodes(p, out) {
  const sku = (p.Sku || '').trim();
  if (!sku) return;
  const add = (code, type) => {
    const c = (code || '').trim();
    if (!c || c === sku) return;
    // last-writer-wins is fine; a code maps to one primary SKU
    out[c] = { sku, code_type: type };
  };
  add(p.Code, 'code');
  // Alternate codes can appear under a few possible shapes depending on account config
  for (const ac of p.AlternateCodes || []) add(typeof ac === 'string' ? ac : (ac.Code || ac.code), 'alt_code');
  for (const as of p.AlternateSKUs || []) add(typeof as === 'string' ? as : (as.Code || as.Sku || as.code), 'alt_sku');
}

export default async () => {
  const started = Date.now();
  try {
    const map = {}; // code -> {sku, code_type}
    let page = 0;
    let products = 0;
    for (;;) {
      const data = await sv('products/getProducts', { PageNumber: page, PageSize: 10000 });
      const prods = data.Products || [];
      for (const p of prods) {
        // Only map codes onto the PRIMARY sku; skip alternate-sku rows as targets
        if (p.IsAlternateSKU === true) continue;
        collectCodes(p, map);
        products += 1;
      }
      if (prods.length < 10000) break;
      page += 1;
      await sleep(THROTTLE_MS);
    }

    const rows = Object.entries(map).map(([code, v]) => ({
      code, sku: v.sku, code_type: v.code_type, synced_at: new Date().toISOString(),
    }));

    // Full refresh: clear then insert (snapshot, like the inventory sync)
    await sb('wh_fnsku_map?code=neq.__none__', { method: 'DELETE' });
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      await sb('wh_fnsku_map', {
        method: 'POST',
        headers: { Prefer: 'return=minimal,resolution=merge-duplicates' },
        body: JSON.stringify(rows.slice(i, i + BATCH)),
      });
    }

    return resp(200, { ok: true, products, codes_mapped: rows.length, ms: Date.now() - started });
  } catch (err) {
    console.error('frm-alias-sync error:', err);
    return resp(500, { ok: false, error: String(err.message || err) });
  }
};
