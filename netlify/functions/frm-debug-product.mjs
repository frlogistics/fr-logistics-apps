// netlify/functions/frm-debug-product.mjs
// ONE-OFF DIAGNOSTIC — remove after use.
// Shows how a product appears in the BULK scan vs. targeted, so we can see
// which fields carry the FNSKU when NOT filtering by code.
//   GET /.netlify/functions/frm-debug-product?sku=DAIZZY G-PINK-BLUSHING HEARTS--SET-M

const SV_BASE = 'https://app.skuvault.com/api';
const resp = (s, b) => new Response(JSON.stringify(b, null, 2), { status: s, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

function svTokens() {
  const t = process.env.SKUVAULT_TENANT_TOKEN || '';
  if (t.includes('|')) { const [TenantToken, UserToken] = t.split('|'); return { TenantToken, UserToken }; }
  return { TenantToken: t, UserToken: process.env.SKUVAULT_USER_TOKEN || '' };
}
async function sv(path, body) {
  const res = await fetch(`${SV_BASE}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...svTokens(), ...body }) });
  if (!res.ok) throw new Error(`SkuVault ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}
const pick = p => ({ Sku: p.Sku, Code: p.Code, PartNumber: p.PartNumber, PrimarySku: p.PrimarySku, IsAlternateSKU: p.IsAlternateSKU, IsAlternateCode: p.IsAlternateCode });

export default async (req) => {
  try {
    const url = new URL(req.url);
    const sku = url.searchParams.get('sku') || 'DAIZZY G-PINK-BLUSHING HEARTS--SET-M';

    // 1) Targeted by SKU — how many rows come back, and their codes?
    const bySku = await sv('products/getProducts', { ProductSKUs: [sku], PageSize: 1000 });
    // 2) A slice of the BULK scan — find this same product and see its fields
    const bulk = await sv('products/getProducts', { PageNumber: 0, PageSize: 10000 });
    const bulkMatches = (bulk.Products || []).filter(p => (p.Sku||'') === sku).map(pick);

    return resp(200, {
      targeted_by_sku: { count: (bySku.Products||[]).length, rows: (bySku.Products||[]).map(pick) },
      bulk_scan_matches: { count: bulkMatches.length, rows: bulkMatches },
      bulk_total_products: (bulk.Products||[]).length,
    });
  } catch (e) {
    return resp(500, { error: String(e.message || e) });
  }
};
