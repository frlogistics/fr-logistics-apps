// netlify/functions/frm-debug-product.mjs
// ONE-OFF DIAGNOSTIC — remove after use.
// Fetches one product by code and returns its raw SkuVault structure so we can
// see exactly which field holds the FNSKU. Usage:
//   GET /.netlify/functions/frm-debug-product?code=X004EZASHN
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

export default async (req) => {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const sku = url.searchParams.get('sku');
    // Ask explicitly by ProductCodes so SkuVault returns that alternate too
    const body = code ? { ProductCodes: [code], PageSize: 1000 }
               : sku  ? { ProductSKUs: [sku], PageSize: 1000 }
               : { PageSize: 2 };
    const data = await sv('products/getProducts', body);
    const prods = (data.Products || []).map(p => ({
      Sku: p.Sku, Code: p.Code, IsAlternateSKU: p.IsAlternateSKU,
      // dump every key so we can spot where the FNSKU lives
      ALL_KEYS: Object.keys(p),
      RAW: p,
    }));
    return resp(200, { count: prods.length, products: prods });
  } catch (e) {
    return resp(500, { error: String(e.message || e) });
  }
};
