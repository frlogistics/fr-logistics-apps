// netlify/functions/clients-list.js
// Returns all clients from fr_clients table.
// Used by billing.html, onboarding.html, Inbound_Outbound.html, fr-mobile.html,
// and any app needing client data.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS FUNCTION IS THE CLIENT RESOLVER FOR THE WHOLE ECOSYSTEM.
//
// Core rule (25-Apr-2026): every app sources its clients from fr_clients
// through this endpoint. No hardcoded seeds, no per-app lists, no local
// fallbacks. If this endpoint fails, apps must fail loudly.
//
// Identity rule (13-Jul-2026): `company` (Company/Brand) is the canonical
// display and matching identifier. `name` is the contact, used only as a
// fallback when company is empty.
//
// Capability rule (2-Sep-2026): apps filter their functionality by the
// client's contracted service lines and operating flags. If a behaviour
// depends on the client, it belongs in fr_clients — not hardcoded in the app.
//
// To honour those rules without touching 30 apps, this function returns the
// raw fr_clients row PLUS derived fields. Everything that was returned before
// is still returned, byte for byte, so existing apps keep working untouched:
//
//   display        -> company || name              (canonical label)
//   service_lines  -> normalised keys from services[] (fr_service_lines)
//   flags          -> { wms_integration, receiving_mode, state, has_portal }
//   unmapped_services -> anything in services[] we could not normalise
//
// Normalisation happens on READ, not on write: fr_clients.services keeps its
// human-readable labels. If the map is wrong you fix this one file instead of
// rewriting 30 rows.
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  'https://apps.fr-logistics.net',
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
];

// Label (or synonym) -> line_key in fr_service_lines.
// Keys are the label reduced to lowercase alphanumerics, so "FBA Prep",
// "fba prep" and "FBA-PREP" all collapse to the same entry.
const LINE_SYNONYMS = {
  fbaprep: 'fba_prep',
  amazonfbaprep: 'fba_prep',
  prep: 'fba_prep',

  fbmdtcfulfillment: 'fbm_dtc',
  fbmdtc: 'fbm_dtc',
  dtcfulfillment: 'fbm_dtc',
  fulfillment: 'fbm_dtc',
  fbm: 'fbm_dtc',

  kittingbundling: 'kitting',
  kitting: 'kitting',
  bundling: 'kitting',

  storage: 'storage',
  almacenaje: 'storage',

  walmartdsv: 'walmart_dsv',
  dsv: 'walmart_dsv',

  ecopack: 'ecopack',
  ecopackplus: 'ecopack',

  dropship: 'dropship',
  dropshipment: 'dropship',
  dropshipments: 'dropship',
  casillero: 'dropship',
  dropshipcasillero: 'dropship',

  crossdocking: 'xdock',
  crossdock: 'xdock',
  xdock: 'xdock',

  returnsreverselogistics: 'returns',
  returns: 'returns',
  reverselogistics: 'returns',
  logisticainversa: 'returns',

  b2b: 'b2b',
  retaildistribution: 'b2b',
  b2bretaildistribution: 'b2b',
};

const slug = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

function deriveLines(services) {
  const lines = [];
  const unmapped = [];
  const raw = Array.isArray(services) ? services : [];
  raw.forEach((s) => {
    const key = LINE_SYNONYMS[slug(s)];
    if (key) {
      if (!lines.includes(key)) lines.push(key);
    } else if (String(s || '').trim()) {
      unmapped.push(s);
    }
  });
  return { lines, unmapped };
}

function enrich(row) {
  const { lines, unmapped } = deriveLines(row.services);
  // Nombre canonico: empresa si existe, si no el contacto (personas naturales).
  const label = (row.company && String(row.company).trim())
    ? String(row.company).trim()
    : String(row.name || '').trim();
  const code = String(row.client_code || '').trim();
  // display = idioma unico del ecosistema: "RAG_LIMI · RAGSA, LLC".
  // El codigo va primero porque es lo que el operador lee en la caja.
  const display = code ? (code + ' \u00b7 ' + label) : label;
  return Object.assign({}, row, {
    display,
    display_name: label,
    client_code: code || null,
    service_lines: lines,
    unmapped_services: unmapped,
    flags: {
      wms_integration: row.wms_integration === true,
      receiving_mode: row.receiving_mode || 'inventory',
      state: row.state || (row.active ? 'Active' : 'Inactive'),
      has_portal: !!row.portal_user,
    },
  });
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin)
    ? origin
    : ALLOWED_ORIGINS[0];

  const headers = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase not configured' }) };

  const params = event.queryStringParameters || {};
  const status = params.status || null;   // legacy: filter by fr_clients.status
  const state = params.state || null;     // Active | Dormant | Inactive
  const line = params.line || null;       // e.g. ?line=fba_prep
  const mode = params.receiving_mode || null; // inventory | receipt_only

  let url = `${SUPABASE_URL}/rest/v1/fr_clients?select=*&order=name.asc`;
  if (status) url += `&status=eq.${encodeURIComponent(status)}`;

  try {
    const resp = await fetch(url, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      }
    });
    if (!resp.ok) throw new Error(`Supabase ${resp.status}: ${await resp.text()}`);

    let data = (await resp.json()).map(enrich);

    // Derived filters. Applied here so no app has to reimplement them.
    if (state) data = data.filter((c) => c.flags.state === state);
    if (mode) data = data.filter((c) => c.flags.receiving_mode === mode);
    if (line) data = data.filter((c) => c.service_lines.includes(line));

    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
