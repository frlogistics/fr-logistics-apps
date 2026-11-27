// netlify/functions/skuvault-catalog.js
// Creates products in SkuVault and sets their opening quantity in ONE
// location (normally GENERAL, to be slotted later with the handheld).
//
// Why a function and not a CSV import: a CSV goes through SkuVault's import
// screen, which rejects a PO for SKUs that do not exist yet and silently
// drops rows it cannot parse. The API does the two steps in order and
// returns the exact error per item, so what landed is never a guess.
//
// Protected like every function on this site by the auth-gate edge function
// (staff session required). Env: SKUVAULT_TENANT_TOKEN ("tenant|user" or
// tenant alone + SKUVAULT_USER_TOKEN), SKUVAULT_WAREHOUSE_ID.
//
// Actions:
//   GET  ?action=product&sku=…           read one product (to copy its
//                                        Classification / Supplier / Brand)
//   POST { action:'create', items:[{Sku, Code, Description, Classification,
//          Supplier, Brand?, Attributes?, Cost?}], confirm:'CREATE' }
//   POST { action:'set_qty', location_code, items:[{Sku, Quantity}],
//          confirm:<location_code> }
//   POST { action:'create_and_receive', location_code, items:[...same as
//          create + Quantity], confirm:<location_code> }  — both steps
//   POST { action:'update', items:[{Sku, Code?, Description?, …}], confirm:'UPDATE' }

const ALLOWED_ORIGINS = [
  'https://apps.fr-logistics.net',
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
];
const SV = 'https://app.skuvault.com/api';

function svTokens() {
  const t = process.env.SKUVAULT_TENANT_TOKEN || '';
  if (t.includes('|')) { const [TenantToken, UserToken] = t.split('|'); return { TenantToken, UserToken }; }
  return { TenantToken: t, UserToken: process.env.SKUVAULT_USER_TOKEN || '' };
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin',
    'Content-Type': 'application/json',
  };
  const res = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const T = svTokens();
  if (!T.TenantToken || !T.UserToken) return res(500, { error: 'SkuVault tokens missing' });

  const sv = async (path, payload) => {
    const r = await fetch(`${SV}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ TenantToken: T.TenantToken, UserToken: T.UserToken, ...payload }),
    });
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 800) }; }
    return { ok: r.ok, status: r.status, body };
  };

  try {
    const qs = event.queryStringParameters || {};
    let body = {};
    if (event.httpMethod === 'POST') {
      try { body = JSON.parse(event.body || '{}'); } catch { return res(400, { error: 'Invalid JSON body' }); }
    }
    const action = (event.httpMethod === 'GET' ? qs.action : body.action) || '';

    if (action === 'product') {
      const sku = (qs.sku || '').trim();
      if (!sku) return res(400, { error: 'sku is required' });
      const r = await sv('/products/getProduct', { ProductSKU: sku });
      return res(r.ok ? 200 : 502, { ok: r.ok, status: r.status, product: r.body && (r.body.Product || r.body) });
    }

    if (event.httpMethod !== 'POST') return res(405, { error: 'POST required' });

    // Update fields on existing products (Code, Description, attributes…).
    // POST { action:'update', items:[{Sku, Code?, Description?, ...}], confirm:'UPDATE' }
    if (action === 'update') {
      if (body.confirm !== 'UPDATE') return res(400, { error: 'CONFIRM_MISMATCH', message: 'Send confirm:"UPDATE".' });
      const list = Array.isArray(body.items) ? body.items : [];
      if (!list.length) return res(400, { error: 'items[] is required' });
      const upd = list.map((it) => { const o = { Sku: String(it.Sku).trim() }; for (const k of ['Code','Client','PartNumber','Description','ShortDescription','LongDescription','Classification','Supplier','Brand','Cost','SalePrice','RetailPrice','ReorderPoint','Attributes']) if (it[k] !== undefined) o[k] = it[k]; return o; });
      const r = await sv('/products/updateProducts', { Items: upd });
      const errs = (r.body && (r.body.Errors || r.body.errors)) || [];
      return res(r.ok && !errs.length ? 200 : 502, { ok: r.ok, status: r.status, updated: upd.length, response: r.body });
    }

    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return res(400, { error: 'items[] is required' });
    for (const it of items) {
      if (!it.Sku || String(it.Sku).length > 80) return res(400, { error: 'each item needs a Sku (<=80 chars)' });
    }

    const createItems = (list) => list.map((it) => ({
      Sku: String(it.Sku).trim(),
      Code: it.Code ? String(it.Code).trim() : undefined,
      PartNumber: it.PartNumber || undefined,
      Description: it.Description || it.Sku,
      ShortDescription: it.ShortDescription || it.Description || it.Sku,
      LongDescription: it.LongDescription || undefined,
      Classification: it.Classification,
      Supplier: it.Supplier,
      Brand: it.Brand || undefined,
      Cost: Number(it.Cost || 0),
      SalePrice: Number(it.SalePrice || 0),
      RetailPrice: Number(it.RetailPrice || 0),
      ReorderPoint: Number(it.ReorderPoint || 0),
      Attributes: it.Attributes && typeof it.Attributes === 'object' ? it.Attributes : undefined,
    }));

    const out = {};

    if (action === 'create' || action === 'create_and_receive') {
      if (action === 'create' && body.confirm !== 'CREATE') {
        return res(400, { error: 'CONFIRM_MISMATCH', message: 'Send confirm:"CREATE" to create products.' });
      }
      for (const it of items) {
        if (!it.Classification || !it.Supplier) {
          return res(400, { error: 'Classification and Supplier are required on every item (copy them from an existing product with ?action=product).' });
        }
      }
      const r = await sv('/products/createProducts', { Items: createItems(items) });
      out.create = { ok: r.ok, status: r.status, response: r.body };
      const errs = (r.body && (r.body.Errors || r.body.errors)) || [];
      if (!r.ok || errs.length) {
        return res(r.ok ? 207 : 502, { error: 'CREATE_FAILED_OR_PARTIAL', ...out });
      }
      if (action === 'create') return res(200, out);
    }

    if (action === 'set_qty' || action === 'create_and_receive') {
      const loc = String(body.location_code || '').trim().toUpperCase();
      if (!loc) return res(400, { error: 'location_code is required' });
      if (body.confirm !== loc) {
        return res(400, { error: 'CONFIRM_MISMATCH', message: `Send confirm exactly equal to "${loc}".` });
      }
      const warehouseId = Number(body.warehouse_id || process.env.SKUVAULT_WAREHOUSE_ID || 0) || undefined;
      const qtyItems = items.map((it) => ({
        Sku: String(it.Sku).trim(),
        LocationCode: loc,
        Quantity: Number(it.Quantity),
        ...(warehouseId ? { WarehouseId: warehouseId } : {}),
      }));
      for (const q of qtyItems) {
        if (!Number.isInteger(q.Quantity) || q.Quantity < 0 || q.Quantity > 100000) {
          return res(400, { error: `bad Quantity for ${q.Sku}` });
        }
      }
      const r = await sv('/inventory/setItemQuantities', { Items: qtyItems });
      const errs = (r.body && (r.body.Errors || r.body.errors)) || [];
      out.set_qty = { ok: r.ok, status: r.status, location: loc, items: qtyItems.length,
                      units: qtyItems.reduce((n, q) => n + q.Quantity, 0), errors: errs, response: errs.length ? r.body : undefined };
      return res(r.ok && !errs.length ? 200 : 502, out);
    }

    return res(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[skuvault-catalog]', err);
    return res(500, { error: 'Request failed', message: String(err.message || err) });
  }
};
