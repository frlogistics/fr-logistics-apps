// netlify/functions/billing-rates.js — FR-Logistics Unified Rate Card API
//
// Single source of truth for service rates across the portal.
// Reads from fr_client_rates (per-client row + DEFAULT fallback) +
// fr_clients.rate_overrides (JSONB) + fr_clients policy fields
// (shipping_markup, mmb).
//
// Used by:
//   - billing.html (Billing Generator UI)
//   - billing-generator.js (auto-generate billing lines)
//   - FR_Logistics_Quote_System_v3.html (quote builder)
//   - services-log.html (rate display in dropdown)
//   - public website calculator (fr-logistics.net)
//
// Endpoints:
//   GET ?client=NAME             → full rate card for that client (with fallback)
//   GET ?client=DEFAULT          → just the default rates
//   GET ?action=catalog          → service catalog (53 entries from fr_service_catalog VIEW)
//   GET ?action=list-clients     → all clients with custom rates (for admin UI)
//
// Response shape (single client):
//   {
//     client_name: "Milano Brands LLC",
//     is_default: false,
//     rates: {
//       "INB_CARTON": { code, name, unit, rate, category, source: "client"|"default" },
//       ...
//     },
//     policy: { shipping_markup: 10.0, mmb: null, billing_source: "ss_store" },
//     overrides: {},  // from fr_clients.rate_overrides JSONB
//     fetched_at: ISO timestamp
//   }

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY");

const sbHeaders = {
  "apikey":        SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type":  "application/json"
};

// ─── service_code ↔ fr_client_rates column name mapping ─────────────────────
// Single source of truth for which service maps to which column.
// Add new rows here when fr_client_rates gets new columns.
const RATE_COLUMN_MAP = {
  // Inbound
  "INB_CARTON":    "inbound_carton",
  "INB_PALLET":    "inbound_pallet",
  "INB_FLOOR":     "inbound_floor",
  "INB_ECO":       "ecopack",
  "INB_XDOCK_PKG": "xdock_pkg",
  "INB_XDOCK_PAL": "xdock_pal",
  // Storage
  "STO_RACK":      "storage_rack",
  "STO_LBIN":      "storage_lbin",
  "STO_SBIN":      "storage_sbin",
  "STO_LT":        "storage_lt",
  // Prep
  "PRP_FNSKU":     "labeling",
  "PRP_POLY":      "poly_bag",
  "PRP_BUBBLE":    "bubble_wrap",
  "PRP_BOXING":    "boxing",
  "PRP_KIT":       "kitting",
  "PRP_BUNDLE":    "complex_bundle",
  "PRP_SORT_UNIT": "sorting",
  "PRP_SORT_BOX":  "sorting_box",
  "PRP_ROL":       "label_removal",
  "PRP_PALLETIZE": "palletizing",
  "PRP_STRETCH":   "stretch_wrap",
  "PRP_PALREPACK": "pal_repack",
  "PRP_HANGTAG":   "hang_tag",
  "PRP_INSERT":    "marketing_insert",
  // QC
  "QC_HOUR":       "qc",
  "QC_PHOTO":      "qc_photo",
  "QC_SAMPLE":     "sku_intake",
  // Fulfillment
  "FUL_PP1":       "pick_pack",
  "FUL_PPN":       "pick_pack_add",
  "FUL_OUT_CART":  "outbound_carton",
  "FUL_OUT_PAL":   "outbound_pallet",
  "FUL_OUT_OVS":   "oversized_pallet",
  "FUL_OUT_DROP":  "drop_shipment",
  "FUL_PICKUP":    "carrier_pickup",
  "FUL_LABEL_APP": "shipping_label_app",
  "FUL_CONSOL":    "order_consol",
  "FUL_RUSH":      "rush_surcharge",
  "FUL_HEAVY":     "heavy_surcharge",
  "FUL_BOX_UP":    "box_upgrade",
  "FUL_ADDR_FIX":  "address_correction",
  // Returns
  "RET_PROC":      "return_proc",
  "RET_REFURB":    "refurb",
  "RET_DISPOSE":   "disposal",
  "RET_REMOVAL":   "removal_order",
  // B2B
  "B2B_CART":      "b2b_master_carton",
  "B2B_PALLET":    "b2b_pallet_build",
  "B2B_RETAIL":    "retail_dist",
  // Technology
  "TEC_WMS":       "wms",
  "TEC_INTEG":     "marketplace",
  "TEC_SETUP":     "setup_fee",
  "TEC_AMZ_PLAN":  "amz_shipment_plan",
  // TEC_CUSTOM has no column — manual billing only
  // Special
  "SPC_SKU_SUR":   "sku_surcharge"
  // SPC_SHOE, SPC_GARMENT, SPC_HAZMAT live in fr_clients.rate_overrides JSONB
};

// ─── In-memory cache (resets on cold start, ~5 min effective TTL) ───────────
// Reduces Supabase reads for high-frequency callers (billing.html, public calc).
const CACHE = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;  // 5 minutes

function getCache(key) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    CACHE.delete(key);
    return null;
  }
  return hit.value;
}

function setCache(key, value) {
  CACHE.set(key, { ts: Date.now(), value });
}

// ─── Fetch helpers ──────────────────────────────────────────────────────────
async function fetchClientRow(clientName) {
  // Returns the fr_client_rates row for this client, or null if no custom row
  const url = `${SUPABASE_URL}/rest/v1/fr_client_rates`
    + `?client_name=eq.${encodeURIComponent(clientName)}&limit=1`;
  const res = await fetch(url, { headers: sbHeaders });
  if (!res.ok) throw new Error(`fetchClientRow ${clientName}: HTTP ${res.status}`);
  const rows = await res.json();
  return rows[0] || null;
}

async function fetchClientPolicy(clientName) {
  // Returns shipping_markup, mmb, billing_source, rate_overrides from fr_clients
  // Match by name OR aliases (some clients use display name vs aliases for matching)
  const url = `${SUPABASE_URL}/rest/v1/fr_clients`
    + `?or=(name.eq.${encodeURIComponent(clientName)},`
    +     `company.eq.${encodeURIComponent(clientName)},`
    +     `store_name.eq.${encodeURIComponent(clientName)})`
    + `&select=name,company,store_name,billing_source,shipping_markup,mmb,rate_overrides`
    + `&limit=1`;
  const res = await fetch(url, { headers: sbHeaders });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

async function fetchCatalog() {
  const url = `${SUPABASE_URL}/rest/v1/fr_service_catalog`
    + `?select=service_code,service_name,unit,default_rate,category,sort_order,active`
    + `&active=eq.true`
    + `&order=sort_order.asc`;
  const res = await fetch(url, { headers: sbHeaders });
  if (!res.ok) throw new Error(`fetchCatalog: HTTP ${res.status}`);
  return res.json();
}

async function fetchClientsWithRates() {
  const url = `${SUPABASE_URL}/rest/v1/fr_client_rates`
    + `?select=client_name,updated_at`
    + `&order=client_name.asc`;
  const res = await fetch(url, { headers: sbHeaders });
  if (!res.ok) throw new Error(`fetchClientsWithRates: HTTP ${res.status}`);
  return res.json();
}

// ─── Build full rate card for a client ──────────────────────────────────────
async function buildRateCard(clientName) {
  const isDefault = clientName === "DEFAULT";

  // Fetch in parallel: catalog, default rates, client custom rates, client policy
  const [catalog, defaultRow, clientRow, policy] = await Promise.all([
    fetchCatalog(),
    fetchClientRow("DEFAULT"),
    isDefault ? Promise.resolve(null) : fetchClientRow(clientName),
    isDefault ? Promise.resolve(null) : fetchClientPolicy(clientName)
  ]);

  if (!defaultRow) {
    throw new Error("DEFAULT rate row missing in fr_client_rates — migration not applied?");
  }

  // Build rates map: catalog entry × column from client row (with default fallback)
  const rates = {};
  for (const svc of catalog) {
    const colName = RATE_COLUMN_MAP[svc.service_code];

    // Manual-billing services have no column — use catalog default_rate
    if (!colName) {
      rates[svc.service_code] = {
        code:     svc.service_code,
        name:     svc.service_name,
        unit:     svc.unit,
        rate:     Number(svc.default_rate) || 0,
        category: svc.category,
        source:   "catalog"
      };
      continue;
    }

    // Look up the rate: client row > default row > catalog default_rate
    let rate = null;
    let source = "default";

    if (clientRow && clientRow[colName] != null) {
      rate = Number(clientRow[colName]);
      source = "client";
    } else if (defaultRow[colName] != null) {
      rate = Number(defaultRow[colName]);
      source = "default";
    } else {
      rate = Number(svc.default_rate) || 0;
      source = "catalog";
    }

    rates[svc.service_code] = {
      code:     svc.service_code,
      name:     svc.service_name,
      unit:     svc.unit,
      rate,
      category: svc.category,
      source
    };
  }

  // Policy fields from fr_clients (or empty defaults)
  const policyOut = {
    shipping_markup: policy?.shipping_markup ?? null,
    mmb:             policy?.mmb             ?? null,
    billing_source:  policy?.billing_source  ?? null
  };

  // JSONB overrides for niche services (shoe, garment, hazmat)
  const overrides = policy?.rate_overrides || {};

  return {
    client_name:     clientName,
    is_default:      isDefault,
    has_custom_rates: !!clientRow,
    rates,
    policy:          policyOut,
    overrides,
    fetched_at:      new Date().toISOString()
  };
}

// ─── Main handler ───────────────────────────────────────────────────────────
export default async (req) => {
  // CORS handled by /netlify/edge-functions/cors.js; minimal headers here.
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=300"  // 5 min CDN cache
  };

  const method = req.method;
  const url    = new URL(req.url);
  const action = url.searchParams.get("action");
  const client = (url.searchParams.get("client") || "").trim();

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  if (method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers
    });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return new Response(JSON.stringify({ error: "Supabase not configured" }), {
      status: 500, headers
    });
  }

  try {
    // ── Action: catalog ──────────────────────────────────────────────────
    if (action === "catalog") {
      const cacheKey = "catalog";
      let catalog = getCache(cacheKey);
      if (!catalog) {
        catalog = await fetchCatalog();
        setCache(cacheKey, catalog);
      }
      return new Response(JSON.stringify({
        catalog,
        count: catalog.length,
        fetched_at: new Date().toISOString()
      }), { status: 200, headers });
    }

    // ── Action: list clients with custom rates ───────────────────────────
    if (action === "list-clients") {
      const cacheKey = "list-clients";
      let list = getCache(cacheKey);
      if (!list) {
        list = await fetchClientsWithRates();
        setCache(cacheKey, list);
      }
      return new Response(JSON.stringify({
        clients: list,
        count: list.length,
        fetched_at: new Date().toISOString()
      }), { status: 200, headers });
    }

    // ── Default: build rate card for one client ──────────────────────────
    if (!client) {
      return new Response(JSON.stringify({
        error: "Missing required parameter: client",
        usage: {
          rate_card:    "GET ?client=NAME",
          default_card: "GET ?client=DEFAULT",
          catalog:      "GET ?action=catalog",
          list_clients: "GET ?action=list-clients"
        }
      }), { status: 400, headers });
    }

    const cacheKey = `card:${client}`;
    let card = getCache(cacheKey);
    if (!card) {
      card = await buildRateCard(client);
      setCache(cacheKey, card);
    }

    return new Response(JSON.stringify(card), { status: 200, headers });
  } catch (err) {
    console.error("billing-rates error:", err);
    return new Response(JSON.stringify({
      error: err.message || String(err),
      stack: err.stack
    }), { status: 500, headers });
  }
};
