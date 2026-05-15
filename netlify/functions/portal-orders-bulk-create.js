// netlify/functions/portal-orders-bulk-create.js
// FR-Logistics Client Portal — Fase 1, Bulk CSV Upload
// Accepts an array of CSV rows (already parsed by the client) and creates
// orders in bulk. Validates each row server-side (format only — no inventory
// check). Returns a per-row report so the client can show which rows were
// created and which failed.
//
// Body: { portal_user: "email", rows: [ {order_number, recipient_name, ...}, ... ] }
//
// Rows with the same order_number are merged into a single order with
// multiple items, just like ShipStation imports.

const ALLOWED_ORIGINS = [
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
  'https://apps.fr-logistics.net',
];

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const MAX_ROWS = 500;

// Required per-row CSV fields.
const REQUIRED_FIELDS = [
  'order_number',
  'recipient_name',
  'address_line1',
  'city',
  'state',
  'postal_code',
  'country_code',
  'item_sku',
  'item_quantity',
];

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

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

// Validate a single row. Returns null if valid, or { row, errors: [...] }.
function validateRow(row, rowIndex) {
  const errors = [];

  for (const f of REQUIRED_FIELDS) {
    if (row[f] === undefined || row[f] === null || String(row[f]).trim() === '') {
      errors.push(`Missing required field: ${f}`);
    }
  }

  if (row.country_code && String(row.country_code).trim().length !== 2) {
    errors.push('country_code must be 2 letters (ISO Alpha-2, e.g. US, CA, MX)');
  }

  if (row.item_quantity !== undefined && row.item_quantity !== null && String(row.item_quantity).trim() !== '') {
    const qty = parseInt(row.item_quantity, 10);
    if (!Number.isInteger(qty) || qty < 1) {
      errors.push('item_quantity must be an integer >= 1');
    }
  }

  if (row.item_unit_price !== undefined && row.item_unit_price !== null && String(row.item_unit_price).trim() !== '') {
    const price = parseFloat(row.item_unit_price);
    if (Number.isNaN(price) || price < 0) {
      errors.push('item_unit_price must be a non-negative number');
    }
  }

  if (row.order_number && String(row.order_number).length > 100) {
    errors.push('order_number too long (max 100 chars)');
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

  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (rows.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No rows provided' }) };
  }
  if (rows.length > MAX_ROWS) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `Too many rows (max ${MAX_ROWS})` }) };
  }

  try {
    // 1. Resolve client by portal_user.
    const clientRes = await sbFetch(
      `fr_clients?portal_user=eq.${encodeURIComponent(portalUser)}&select=id,name`
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

    // 2. Validate every row. Build valid list + row_errors list.
    const validRows = [];
    const rowErrors = [];
    rows.forEach((row, i) => {
      const err = validateRow(row, i + 1); // 1-indexed for user-facing messages
      if (err) rowErrors.push(err);
      else validRows.push({ row, row_index: i + 1 });
    });

    // 3. Check for duplicate order_numbers across THIS client (existing in DB).
    // We do this before grouping so we can flag the rows clearly.
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
          // Move duplicate rows from validRows to rowErrors.
          const stillValid = [];
          for (const r of validRows) {
            const num = String(r.row.order_number).trim();
            if (dupSet.has(num)) {
              rowErrors.push({
                row_index: r.row_index,
                order_number: num,
                errors: [`order_number already exists for this client`],
              });
            } else {
              stillValid.push(r);
            }
          }
          validRows.length = 0;
          validRows.push(...stillValid);
        }
      }
      // If dup check failed, we proceed without it — DB unique constraints (if any)
      // would catch a true duplicate; absent that, the worst case is two rows
      // with the same number, which the warehouse will spot.
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

    // 4. Group valid rows into orders by order_number.
    const orders = groupRows(validRows);

    // 5. Insert orders one by one, then items. We don't wrap in a transaction
    // because Supabase REST doesn't expose one; instead we report per-order
    // success/failure so the client knows exactly what happened.
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
        total_rows_received: rows.length,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error', detail: String(err) }) };
  }
};
