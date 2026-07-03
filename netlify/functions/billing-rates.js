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
//   GET ?action=catalog          → service catalog (from fr_service_catalog)
//   GET ?action=list-clients     → all clients with custom rates (for admin UI)
//
// Pick & Pack weight tiers:
//   FUL_PP1 is a single service_code whose object is enriched with a `tiers`
//   block so the whole ecosystem stays consistent without breaking callers
//   that still read only `rate`. Tiers (by total billable order weight in lb):
//     Small      <= 1.50 lb  → pick_pack_sm  (DEFAULT 3.00)
//     Standard   1.51–3.00   → pick_pack_st  (DEFAULT 4.00)
//     Oversized  > 3.00 lb   → pick_pack_ov  (DEFAULT 5.00)
//     Additional item        → pick_pack_add (DEFAULT 0.50, also FUL_PPN)
//   FUL_PP1.rate == Small tier (back-compat). Billing Generator must read
//   FUL_PP1.tiers and classify each order by weight via classifyPickPackTier().
//
// 2026-07-03 — Added 8 Dropshipments — Casillero mappings (DS_INTAKE,
//   DS_STORAGE, DS_CONSOL, DS_PHOTO, DS_REPACK_XL, DS_RTS, DS_DISPOSAL) +
//   TEC_PORTAL_PREM for the casillero client portal fee (Eugenio Piñeiro
//   launch). REQUIRES matching columns in fr_client_rates (see companion
//   SQL migration 20260703_casillero_rates.sql) and matching rows in the
//   fr_service_catalog VIEW rebuild.
//
// Response shape (single client):
//   {
//     client_name: "Milano Brands LLC",
//     is_default: false,
//     rates: {
//       "INB_CARTON": { code, name, unit, rate, category, source: "client"|"default" },
//       "FUL_PP1":    { code, name, unit, rate, category, source, tiers: {...} },
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

// ─── Pick & Pack weight-tier configuration ──────────────────────────────────
// Canonical thresholds (lb) and the fr_client_rates columns each tier reads.
// Kept here as the single source so the API, billing generator, quote builder,
// and public calculator all agree.
const PP_TIER = {
  columns:    { small: "pick_pack_sm", standard: "pick_pack_st",
                oversized: "pick_pack_ov", additional: "pick_pack_add" },
  fallback:   { small: 3.00, standard: 4.00, oversized: 5.00, additional: 0.50 },
  thresholds: { small_max: 1.50, standard_max: 3.00 }  // inclusive upper bounds
};

// Classify an order's billable weight (lb) into a Pick & Pack tier + rate.
// Exported so billing-generator can import the SAME logic instead of
// re-implementing the thresholds. `tiers` is the object found at
// rates.FUL_PP1.tiers; if omitted, canonical fallbacks are used.
export function classifyPickPackTier(weightLb, tiers) {
  const t = tiers || {
    small:      PP_TIER.fallback.small,
    standard:   PP_TIER.fallback.standard,
    oversized:  PP_TIER.fallback.oversized,
    thresholds: PP_TIER.thresholds
  };
  const th = t.thresholds || PP_TIER.thresholds;
  const w  = Number(weightLb);
  // Null / 0 / invalid weight → safest tier (Small) so missing data never overcharges.
  if (!Number.isFinite(w) || w <= 0)   return { tier: "small",     rate: t.small };
  if (w <= th.small_max)               return { tier: "small",     rate: t.small };
  if (w <= th.standard_max)            return { tier: "standard",  rate: t.standard };
  return { tier: "oversized", rate: t.oversized };
}

// ─── service_code ↔ fr_client_rates column name mapping ─────────────────────
// Single source of truth for which service maps to which column.
// Add new rows here when fr_client_rates gets new columns.
//
// NOTE: FUL_PP1 maps to pick_pack_sm (the Small/base tier) so the generic
// resolver yields the correct base `rate`. The full tier block is attached
// afterward in buildRateCard() from the PP_TIER columns.
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
  "FUL_PP1":       "pick_pack_sm",     // base = Small tier; tiers block added in buildRateCard
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
  "TEC_PORTAL_PREM": "tec_portal_prem",   // 2026-07-03 casillero client portal fee
  "TEC_INTEG":     "marketplace",
  "TEC_SETUP":     "setup_fee",
  "TEC_AMZ_PLAN":  "amz_shipment_plan",
  // TEC_CUSTOM has no column — manual billing only
  // Dropshipments — Casillero (2026-07-03, Eugenio Piñeiro launch)
  "DS_INTAKE":     "ds_intake",
  "DS_STORAGE":    "ds_storage",
  "DS_CONSOL":     "ds_consol",
  "DS_PHOTO":      "ds_photo",
  "DS_REPACK_XL":  "ds_repack_xl",
  "DS_RTS":        "ds_rts",
  "DS_DISPOSAL":   "ds_disposal",
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

// ─── Rate resolver: client row > DEFAULT row > catalog fallback ─────────────
function resolveColumn(colName, clientRow, defaultRow, catalogDefault) {
  if (clientRow && clientRow[colName] != null) {
    return { rate: Number(clientRow[colName]), source: "client" };
  }
  if (defaultRow[colName] != null) {
    return { rate: Number(defaultRow[colName]), source: "default" };
  }
  return { rate: Number(catalogDefault) || 0, source: "catalog" };
}

// Build the Pick & Pack tiers block for a client using the same resolver.
// Each tier resolves independently so a per-client override on any single
// tier (via fr_client_rates) is respected; missing values fall back to DEFAULT
// then to the canonical fallback.
function buildPickPackTiers(clientRow, defaultRow) {
  const pick = (col, fb) =>
    resolveColumn(col, clientRow, defaultRow, fb).rate;
  return {
    small:      pick(PP_TIER.columns.small,      PP_TIER.fallback.small),
    standard:   pick(PP_TIER.columns.standard,   PP_TIER.fallback.standard),
    oversized:  pick(PP_TIER.columns.oversized,  PP_TIER.fallback.oversized),
    additional: pick(PP_TIER.columns.additional, PP_TIER.fallback.additional),
    thresholds: { ...PP_TIER.thresholds }
  };
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

    const { rate, source } =
      resolveColumn(colName, clientRow, defaultRow, svc.default_rate);

    rates[svc.service_code] = {
      code:     svc.service_code,
      name:     svc.service_name,
      unit:     svc.unit,
      rate,
      category: svc.category,
      source
    };
  }

  // Enrich Pick & Pack with its weight tiers. FUL_PP1.rate already equals the
  // Small tier (mapped to pick_pack_sm), so adding the block is non-breaking:
  // callers that read only `rate` keep working; tier-aware callers (Billing
  // Generator) read `tiers` and classify per order via classifyPickPackTier().
  if (rates.FUL_PP1) {
    rates.FUL_PP1.tiers = buildPickPackTiers(clientRow, defaultRow);
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
