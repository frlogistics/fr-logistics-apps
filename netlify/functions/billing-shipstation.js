// netlify/functions/billing-shipstation.js
// Mode 1 (store): filter shipments by storeId from stores list
// Mode 2 (cf1):   get ALL recent orders, filter by advancedOptions.customField1 client-side,
//                 then cross-reference with period shipments by orderId
//
// billed_orders (Sprint 1):
// When client_id is provided, queries billed_orders table and excludes order_ids
// already invoiced. Also returns orderIds array so the frontend can pass them
// back to billing-mark-invoiced for tracking.
//
// Pick & Pack weight tiers (2026-06-17):
// Each unbilled shipment is classified by total billable weight (normalized to
// pounds) into Small / Standard / Oversized. The function returns the per-tier
// order counts (ppSmall, ppStandard, ppOversized) so billing-generator can bill
// Pick & Pack at the correct tier rate. Thresholds mirror billing-rates
// FUL_PP1.tiers.thresholds (small_max 1.50 lb, standard_max 3.00 lb). Weight
// missing / 0 → Small (never overcharge on missing data).
//
// WHY client-side filter on orders (not shipments):
// - ShipStation /orders?customField1= API filter does NOT work
// - shipments.advancedOptions.customField1 is captured at label-creation time
// - orders.advancedOptions.customField1 reflects CURRENT state after retroactive tagging

const SS = 'https://ssapi.shipstation.com';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// ─── Pick & Pack weight tier thresholds (pounds) ────────────────────────────
// Keep in sync with billing-rates.js PP_TIER.thresholds.
const PP_THRESHOLDS = { small_max: 1.50, standard_max: 3.00 };

// Normalize a ShipStation weight object { value, units } to pounds.
// ShipStation units are one of: 'pounds', 'ounces', 'grams'. Anything missing
// or unparseable returns 0 (→ classified as Small downstream).
function weightToLb(weight) {
  if (!weight || weight.value == null) return 0;
  const v = Number(weight.value);
  if (!Number.isFinite(v) || v <= 0) return 0;
  switch (String(weight.units || '').toLowerCase()) {
    case 'ounces': return v / 16;
    case 'grams':  return v / 453.59237;
    case 'pounds':
    default:       return v;   // assume pounds if unit absent
  }
}

// Classify a shipment's weight (lb) into a P&P tier key.
function ppTierOf(weightLb) {
  const w = Number(weightLb);
  if (!Number.isFinite(w) || w <= 0)   return 'small';
  if (w <= PP_THRESHOLDS.small_max)    return 'small';
  if (w <= PP_THRESHOLDS.standard_max) return 'standard';
  return 'oversized';
}

// Given a list of shipments, return per-tier order counts.
function tallyTiers(shipments) {
  const t = { ppSmall: 0, ppStandard: 0, ppOversized: 0 };
  for (const s of shipments) {
    const lb = weightToLb(s.weight);
    const tier = ppTierOf(lb);
    if (tier === 'small')          t.ppSmall++;
    else if (tier === 'standard')  t.ppStandard++;
    else                           t.ppOversized++;
  }
  return t;
}

async function ssGet(url, auth) {
  const r = await fetch(url, { headers: auth });
  if (!r.ok) throw new Error(`SS ${r.status}: ${await r.text()}`);
  return r.json();
}

async function fetchAllPages(url, auth) {
  let page = 1, pages = 1, out = [];
  do {
    const sep = url.includes('?') ? '&' : '?';
    const d   = await ssGet(`${url}${sep}pageSize=500&page=${page}`, auth);
    out   = out.concat(d.shipments || d.orders || []);
    pages = d.pages || 1;
    page++;
  } while (page <= pages && page <= 10);
  return out;
}

// Fetch billed order_ids for a client from Supabase.
// Returns Set<string> of order_ids already in billed_orders for this client.
// Fails gracefully (returns empty Set) if Supabase unreachable — never blocks billing.
async function getBilledOrderIds(clientId) {
  if (!clientId || !SUPABASE_URL || !SUPABASE_KEY) return new Set();
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/billed_orders?client_id=eq.${clientId}&select=order_id`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
        }
      }
    );
    if (!r.ok) {
      console.warn(`billed_orders fetch failed: ${r.status}`);
      return new Set();
    }
    const rows = await r.json();
    return new Set(rows.map(r => String(r.order_id)));
  } catch (err) {
    console.warn(`billed_orders query error: ${err.message}`);
    return new Set();
  }
}

exports.handler = async (event) => {
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: h, body: '' };

  const key = process.env.SS_API_KEY;
  const sec = process.env.SS_API_SECRET;
  if (!key || !sec) return { statusCode: 500, headers: h, body: JSON.stringify({ error: 'SS credentials missing' }) };

  const auth     = { 'Authorization': `Basic ${Buffer.from(`${key}:${sec}`).toString('base64')}` };
  const p        = event.queryStringParameters || {};
  const start    = (p.start || '').trim();
  const end      = (p.end   || '').trim();
  const store    = (p.store || '').trim();
  const cf1      = (p.cf1   || '').trim();
  const clientId = (p.client_id || '').trim();

  if (!start || !end)      return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'start and end required' }) };
  if (!store && !cf1)      return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'store or cf1 required' }) };

  try {
    // Fetch shipments + stores list + billed orders set in parallel
    const [allShipments, storeList, billedSet] = await Promise.all([
      fetchAllPages(`${SS}/shipments?shipDateStart=${start}&shipDateEnd=${end}`, auth),
      ssGet(`${SS}/stores?showInactive=false`, auth).catch(() => []),
      getBilledOrderIds(clientId),
    ]);

    // Build storeId → storeName map
    const storeMap = {};
    (Array.isArray(storeList) ? storeList : []).forEach(s => {
      storeMap[s.storeId] = (s.storeName || '').toLowerCase();
    });

    // Resolve storeName for each shipment
    const enriched = allShipments.map(s => ({
      ...s,
      _store: (s.storeName || storeMap[s.advancedOptions?.storeId] || '').toLowerCase(),
    }));

    const allStoreNames = [...new Set(enriched.map(s => s._store).filter(Boolean))].sort();

    // ══ MODE 1: Store filter ═══════════════════════════════════════════════
    if (store) {
      const pat        = store.toLowerCase();
      const allMatched = enriched.filter(s => s._store === pat);
      const unbilled   = allMatched.filter(s => !billedSet.has(String(s.orderId)));
      const billed     = allMatched.filter(s =>  billedSet.has(String(s.orderId)));
      const tiers      = tallyTiers(unbilled);

      return {
        statusCode: 200,
        headers: h,
        body: JSON.stringify({
          mode:         'store',
          store,
          count:        unbilled.length,
          totalCount:   enriched.length,
          carrierCost:  round(unbilled.reduce((s, x) => s + (x.shipmentCost || 0), 0)),
          storeMatched: allMatched.length > 0,
          storeNames:   allStoreNames,
          // Pick & Pack weight-tier order counts
          ppSmall:      tiers.ppSmall,
          ppStandard:   tiers.ppStandard,
          ppOversized:  tiers.ppOversized,
          // order IDs for billed_orders tracking (now include tier + weight)
          orderIds: unbilled.map(s => ({
            order_id:     String(s.orderId),
            carrier_cost: round(s.shipmentCost || 0),
            weight_lb:    round(weightToLb(s.weight)),
            pp_tier:      ppTierOf(weightToLb(s.weight)),
          })),
          // informative billed counter
          billed: {
            count:       billed.length,
            carrierCost: round(billed.reduce((s, x) => s + (x.shipmentCost || 0), 0)),
          },
        })
      };
    }

    // ══ MODE 2: Custom Field 1 filter ══════════════════════════════════════
    const allOrders = await fetchAllPages(`${SS}/orders?orderStatus=shipped`, auth);
    const cf1Lower  = cf1.toLowerCase();

    const matchedOrders = allOrders.filter(o =>
      (o.advancedOptions?.customField1 || '').toLowerCase() === cf1Lower
    );

    if (matchedOrders.length === 0) {
      return {
        statusCode: 200,
        headers: h,
        body: JSON.stringify({
          mode:        'cf1',
          cf1,
          count:       0,
          carrierCost: 0,
          totalCount:  enriched.length,
          storeNames:  allStoreNames,
          ppSmall:     0,
          ppStandard:  0,
          ppOversized: 0,
          orderIds:    [],
          billed:      { count: 0, carrierCost: 0 },
          note:        `No shipped orders found with Custom Field 1 = "${cf1}". Tag orders in ShipStation.`,
        })
      };
    }

    const orderIdSet        = new Set(matchedOrders.map(o => o.orderId));
    const matchedShipments  = enriched.filter(s => orderIdSet.has(s.orderId));
    const unbilledShipments = matchedShipments.filter(s => !billedSet.has(String(s.orderId)));
    const billedShipments   = matchedShipments.filter(s =>  billedSet.has(String(s.orderId)));
    const tiers             = tallyTiers(unbilledShipments);

    return {
      statusCode: 200,
      headers: h,
      body: JSON.stringify({
        mode:         'cf1',
        cf1,
        count:        unbilledShipments.length,
        ordersTagged: matchedOrders.length,
        totalCount:   enriched.length,
        carrierCost:  round(unbilledShipments.reduce((sum, s) => sum + (s.shipmentCost || 0), 0)),
        storeNames:   allStoreNames,
        // Pick & Pack weight-tier order counts
        ppSmall:      tiers.ppSmall,
        ppStandard:   tiers.ppStandard,
        ppOversized:  tiers.ppOversized,
        orderIds: unbilledShipments.map(s => ({
          order_id:     String(s.orderId),
          carrier_cost: round(s.shipmentCost || 0),
          weight_lb:    round(weightToLb(s.weight)),
          pp_tier:      ppTierOf(weightToLb(s.weight)),
        })),
        billed: {
          count:       billedShipments.length,
          carrierCost: round(billedShipments.reduce((s, x) => s + (x.shipmentCost || 0), 0)),
        },
      })
    };

  } catch (err) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: err.message }) };
  }
};

function round(n) { return Math.round(n * 100) / 100; }
