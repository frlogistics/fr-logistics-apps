// netlify/functions/portal-orders-bulk-create.js
// FR-Logistics Client Portal — Fase 1, Bulk CSV Upload
//
// Accepts CSV rows in ShipStation export format (47-column standard) and
// creates orders in the client_orders / client_order_items tables.
//
// Why ShipStation format: every 3PL client (MXS, Milano, etc.) already
// exports from ShipStation in this exact column layout, and so does our
// own warehouse-orders.js when generating the file we re-import to
// ShipStation later. Using the same format end-to-end removes friction
// (no template re-typing for the client) and keeps a single canonical
// shape across the system.
//
// CSV defaults per client (added June 2026):
//   fr_clients.csv_defaults is a JSONB of agreed fixed values keyed by
//   ShipStation header name. We apply them to EVERY row right after mapping
//   and BEFORE validation, so:
//     (a) the client can't accidentally clear "Shipping Service" or
//         "Notes to the Buyer" by leaving them blank — they get the
//         contract values regardless;
//     (b) for fields that DO persist in client_orders (Shipping Service,
//         Notes to the Buyer), the agreed value lands in the DB and flows
//         to the ShipStation export.
//   Fields that DON'T persist in client_orders (Custom Field 1, Order
//   Source) are still listed in csv_defaults — they are injected at export
//   time by portal-warehouse-orders.js. We leave them in the row here so
//   the validation summary the client sees stays consistent with the
//   template.
//
// Body: { portal_user: "email", rows: [ { "Order #": "...", "Recipient Full Name": "...", ... } ] }
//
// Rows with the same "Order #" are merged into a single order with
// multiple items, just like ShipStation imports.

const ALLOWED_ORIGINS = [
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
  'https://apps.fr-logistics.net',
];

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const MAX_ROWS = 500;

// ShipStation header → internal DB column. Only the fields the portal cares
// about; the other 32 ShipStation columns (Order Total, Buyer info, weights,
// etc.) are ignored silently so the CSV can be uploaded as-is.
const HEADER_MAP = {
  'Order #': 'order_number',
  'Recipient Full Name': 'recipient_name',
  'Recipient Phone': 'recipient_phone',
  'Address Line 1': 'address_line1',
  'Address Line 2': 'address_line2',
  'City': 'city',
  'State': 'state',
  'Postal Code': 'postal_code',
  'Country Code': 'country_code',
  'Shipping Service': 'shipping_service',
  'Notes to the Buyer': 'notes_to_buyer',
  'Item SKU': 'item_sku',
  'Item Name / Title': 'item_name',
  'Item Quantity': 'item_quantity',
  'Item Unit Price': 'item_unit_price',
};

// Headers from csv_defaults that map to fields we actually persist in
// client_orders. The OTHERS in csv_defaults (Custom Field 1, Order Source)
// are intentionally NOT in HEADER_MAP — they're injected at export time by
// portal-warehouse-orders.js. We track them here so we know which keys are
// safe to push into the mapped row before validation.
const PERSISTED_DEFAULT_HEADERS = ['Shipping Service', 'Notes to the Buyer'];

// Required ShipStation headers — what we surface in error messages so the
// client recognises the column names from their own export.
const REQUIRED_SHIPSTATION_FIELDS = [
  'Order #',
  'Recipient Full Name',
  'Address Line 1',
  'City',
  'State',
  'Postal Code',
  'Country Code',
  'Item SKU',
  'Item Quantity',
];

// Mirror of REQUIRED_SHIPSTATION_FIELDS in DB names, used after mapping.
const REQUIRED_INTERNAL_FIELDS = REQUIRED_SHIPSTATION_FIELDS.map((h) => HEADER_MAP[h]);

// Order-level fields (apply to the whole order, not the item). The first row
// of a given order_number wins; subsequent rows for the same order_number
// are only used for their item_* fields.
const ORDER_FIELDS = [
  'recipient_name',
  'recipient_phone',
  'address_line1',
  'address_line2',
  'city',
  'state',
  'postal_code',
  'country_code',
  'shipping_service',
  'notes_to_buyer',
];

// USA-only country normalisation per project decision (May 2026). When other
// countries become relevant, extend this map. Anything not recognised that's
// already 2 letters is passed through verbatim; anything else falls to
// validation as "country_code must be 2 letters".
const COUNTRY_NORMALISE = {
  'united states': 'US',
  'united states of america': 'US',
  'usa': 'US',
  'us': 'US',
};

function normaliseCountry(value) {
  if (value === undefined || value === null) return value;
  const trimmed = String(value).trim();
  if (trimmed === '') return trimmed;
  const lower = trimmed.toLowerCase();
  if (COUNTRY_NORMALISE[lower]) return COUNTRY_NORMALISE[lower];
  // Already a 2-letter code: leave as uppercase.
  if (trimmed.length === 2) return trimmed.toUpperCase();
  return trimmed; // fall through, validateRow will flag it
}

// Map a ShipStation-format row to internal field names. Unknown headers are
// dropped. If the row already uses internal field names (legacy template),
// they pass through unchanged so backward-compat is preserved.
function mapRow(rawRow) {
  const out = {};
  for (const key of Object.keys(rawRow)) {
    const internalKey = HEADER_MAP[key] || key; // unknown ShipStation → drop later
    // Only keep keys that match either a header we know about or an
    // internal field name (legacy). Avoid bringing in irrelevant junk.
    if (HEADER_MAP[key] || REQUIRED_INTERNAL_FIELDS.includes(key) || ORDER_FIELDS.includes(key) || key === 'item_sku' || key === 'item_name' || key === 'item_quantity' || key === 'item_unit_price' || key === 'order_number') {
      out[internalKey] = rawRow[key];
    }
  }
  if (out.country_code !== undefined) out.country_code = normaliseCountry(out.country_code);
  return out;
}

// Force the agreed per-client defaults onto a mapped row. Runs AFTER mapRow,
// BEFORE validateRow. Overrides whatever the client put in the CSV — that's
// the whole point: "fixed values" means fixed, not "suggested". Returns the
// same row (mutated) for caller convenience.
//
// csvDefaults is the raw fr_clients.csv_defaults JSONB; its keys are
// ShipStation headers. We only act on the keys whose internal DB column we
// actually persist (PERSISTED_DEFAULT_HEADERS). Custom Field 1 / Order
// Source are no-ops here on purpose — they live in csv_defaults so the
// frontend template can pre-fill them and so the warehouse export can read
// them at export time, but they never land in client_orders.
function applyDefaults(mappedRow, csvDefaults) {
  if (!csvDefaults || typeof csvDefaults !== 'object') return mappedRow;
  for (const header of PERSISTED_DEFAULT_HEADERS) {
    const value = csvDefaults[header];
    if (value === undefined || value === null || String(value).trim() === '') continue;
    const dbCol = HEADER_MAP[header];
    if (!dbCol) continue; // defensive — would only happen if PERSISTED_DEFAULT_HEADERS got out of sync
    mappedRow[dbCol] = String(value);
  }
  return mappedRow;
}

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

// Validate a single mapped row. Returns null if valid, or
// { row_index, order_number, errors }.
function validateRow(row, rowIndex) {
  const errors = [];

  for (const f of REQUIRED_INTERNAL_FIELDS) {
    if (row[f] === undefined || row[f] === null || String(row[f]).trim() === '') {
      // Surface the ShipStation column name so the client recognises it.
      const ssHeader = Object.keys(HEADER_MAP).find((k) => HEADER_MAP[k] === f) || f;
      errors.push(`Missing required field: ${ssHeader}`);
    }
  }

  if (row.country_code && String(row.country_code).trim().length !== 2) {
    errors.push('Country Code must be 2 letters (ISO Alpha-2, e.g. US, CA, MX)');
  }

  if (row.item_quantity !== undefined && row.item_quantity !== null && String(row.item_quantity).trim() !== '') {
    const qty = parseInt(row.item_quantity, 10);
    if (!Number.isInteger(qty) || qty < 1) {
      errors.push('Item Quantity must be an integer >= 1');
    }
  }

  if (row.item_unit_price !== undefined && row.item_unit_price !== null && String(row.item_unit_price).trim() !== '') {
    const price = parseFloat(row.item_unit_price);
    if (Number.isNaN(price) || price < 0) {
      errors.push('Item Unit Price must be a non-negative number');
    }
  }

  if (row.order_number && String(row.order_number).length > 100) {
    errors.push('Order # too long (max 100 chars)');
  }

  if (errors.length === 0) return null;
  return { row_index: rowIndex, order_number: row.order_number || null, errors };
}

// Group valid rows by order_number into orders with items.
function groupRows(validRows) {
  const byOrder = {};
  const orderSequence = []; // preserve first-seen order

  for (const r of validRows) {
    const num = String(r.row.order_number).trim();
    if (!byOrder[num]) {
      const order = {};
      for (const f of ORDER_FIELDS) {
        const v = r.row[f];
        if (v !== undefined && v !== null && String(v).trim() !== '') {
          order[f] = String(v).trim();
        }
      }
      byOrder[num] = {
        order_number: num,
        order,
        items: [],
        row_indices: [],
      };
      orderSequence.push(num);
    }
    byOrder[num].row_indices.push(r.row_index);
    const item = {
      item_sku: String(r.row.item_sku).trim(),
      item_quantity: parseInt(r.row.item_quantity, 10),
    };
    if (r.row.item_name && String(r.row.item_name).trim() !== '') {
      item.item_name = String(r.row.item_name).trim();
    }
    if (r.row.item_unit_price !== undefined && r.row.item_unit_price !== null && String(r.row.item_unit_price).trim() !== '') {
      const price = parseFloat(r.row.item_unit_price);
      if (!Number.isNaN(price)) item.item_unit_price = price;
    }
    byOrder[num].items.push(item);
  }

  return orderSequence.map((num) => byOrder[num]);
}

async function sbFetch(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      ...(opts.headers || {}),
    },
  });
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const headers = corsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const portalUser = payload.portal_user;
  if (!portalUser) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing portal_user' }) };
  }

  const rawRows = Array.isArray(payload.rows) ? payload.rows : [];
  if (rawRows.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No rows provided' }) };
  }
  if (rawRows.length > MAX_ROWS) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `Too many rows (max ${MAX_ROWS})` }) };
  }

  try {
    // 1. Resolve client by portal_user — include csv_defaults so we can apply
    //    them to every row before validation. Single round trip.
    const clientRes = await sbFetch(
      `fr_clients?portal_user=eq.${encodeURIComponent(portalUser)}&select=id,name,csv_defaults`
    );
    if (!clientRes.ok) {
      const t = await clientRes.text();
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Client lookup failed', detail: t }) };
    }
    const clients = await clientRes.json();
    if (!clients.length) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No client linked to this portal user' }) };
    }
    const client = clients[0];
    const csvDefaults = client.csv_defaults || {};

    // 2. Map ShipStation headers → internal field names, then force the
    //    per-client defaults. Order matters: map first so the defaults land
    //    on the internal column names, then defaults overwrite whatever the
    //    client may have typed for those fields.
    const rows = rawRows.map((rawRow) => applyDefaults(mapRow(rawRow), csvDefaults));

    // 3. Validate every row. Build valid list + row_errors list.
    const validRows = [];
    const rowErrors = [];
    rows.forEach((row, i) => {
      const err = validateRow(row, i + 1); // 1-indexed for user-facing messages
      if (err) rowErrors.push(err);
      else validRows.push({ row, row_index: i + 1 });
    });

    // 4. Check for duplicate order_numbers across THIS client (existing in DB).
    if (validRows.length > 0) {
      const numbersInBatch = Array.from(new Set(validRows.map((r) => String(r.row.order_number).trim())));
      const numList = numbersInBatch.map((n) => `"${n.replace(/"/g, '\\"')}"`).join(',');
      const dupRes = await sbFetch(
        `client_orders?client_id=eq.${client.id}&order_number=in.(${numList})&select=order_number`
      );
      if (dupRes.ok) {
        const dupRows = await dupRes.json();
        const dupSet = new Set(dupRows.map((d) => d.order_number));
        if (dupSet.size > 0) {
          const stillValid = [];
          for (const r of validRows) {
            const num = String(r.row.order_number).trim();
            if (dupSet.has(num)) {
              rowErrors.push({
                row_index: r.row_index,
                order_number: num,
                errors: [`Order # already exists for this client`],
              });
            } else {
              stillValid.push(r);
            }
          }
          validRows.length = 0;
          validRows.push(...stillValid);
        }
      }
    }

    if (validRows.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          created_count: 0,
          created_orders: [],
          row_errors: rowErrors,
          message: 'No valid rows to submit',
        }),
      };
    }

    // 5. Group valid rows into orders by order_number.
    const orders = groupRows(validRows);

    // 6. Insert orders one by one, then items.
    const created = [];
    const failed = [];
    for (const grp of orders) {
      const orderRow = Object.assign(
        { client_id: client.id, order_number: grp.order_number, status: 'pending' },
        grp.order
      );

      const insertRes = await sbFetch('client_orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify(orderRow),
      });
      if (!insertRes.ok) {
        const detail = await insertRes.text();
        failed.push({
          order_number: grp.order_number,
          row_indices: grp.row_indices,
          error: `Order insert failed: ${detail.slice(0, 200)}`,
        });
        continue;
      }
      const inserted = await insertRes.json();
      const newOrder = inserted[0];

      const itemRows = grp.items.map((it) => Object.assign(
        { order_id: newOrder.id, sku_validated: false },
        it
      ));
      const itemsRes = await sbFetch('client_order_items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(itemRows),
      });
      if (!itemsRes.ok) {
        const detail = await itemsRes.text();
        failed.push({
          order_number: grp.order_number,
          row_indices: grp.row_indices,
          error: `Order created but items insert failed: ${detail.slice(0, 200)}`,
        });
        continue;
      }
      created.push({
        order_number: newOrder.order_number,
        order_id: newOrder.id,
        item_count: grp.items.length,
        row_indices: grp.row_indices,
      });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        created_count: created.length,
        created_orders: created,
        failed_orders: failed,
        row_errors: rowErrors,
        total_rows_received: rawRows.length,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error', detail: String(err) }) };
  }
};
