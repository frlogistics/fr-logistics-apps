// netlify/functions/portal-warehouse-orders.js
// FR-Logistics Client Portal — Fase 1, Warehouse Order Queue
// Internal (warehouse) view: lists ALL client orders across all clients,
// and exports selected pending orders to a ShipStation-format CSV,
// marking them as 'exported'.
//
// Same pattern as clients-list.js / portal-dashboard.js / portal-orders-list.js
//
// Endpoints (single function, ?action= switch):
//   GET  ?action=list&status=pending      -> orders for the queue
//   POST ?action=export  body:{order_ids:[...], exported_by:"..."}  -> CSV + mark exported

const ALLOWED_ORIGINS = [
  'https://apps.fr-logistics.net',
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
];

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const VALID_STATUSES = ['pending', 'processing', 'exported'];

// ShipStation import format — 47 columns, exact order.
const CSV_HEADERS = [
  'Order #', 'Order Date', 'Date Paid', 'Order Total', 'Amount Paid', 'Tax',
  'Shipping Paid', 'Shipping Service', 'Height(in)', 'Length(in)', 'Width(in)',
  'Weight(oz)', 'Custom Field 1', 'Custom Field 2', 'Custom Field 3', 'Order Source',
  'Notes to the Buyer', 'Notes from the Buyer', 'Internal Notes', 'Gift Message',
  'Gift Flag', 'Buyer Full Name', 'Buyer First Name', 'Buyer Last Name', 'Buyer Email',
  'Buyer Phone', 'Buyer Username', 'Recipient Full Name', 'Recipient First Name',
  'Recipient Last Name', 'Recipient Phone', 'Recipient Company', 'Address Line 1',
  'Address Line 2', 'Address Line 3', 'City', 'State', 'Postal Code', 'Country Code',
  'Item SKU', 'Item Name / Title', 'Item Quantity', 'Item Unit Price', 'Item Weight (oz)',
  'Item Options', 'Item Warehouse Location', 'Item Marketplace ID',
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

// CSV-escape a single value: wrap in quotes if it contains comma, quote, or newline.
function csvCell(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Format a timestamp as M/D/YYYY (ShipStation-friendly).
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

// Split a full name into first / last (best effort).
function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

// Build CSV rows for one order. ShipStation expects one row per item;
// order-level fields repeat on each row, item-level fields differ.
function orderToRows(order, clientName) {
  const items = order.client_order_items || [];
  const { first, last } = splitName(order.recipient_name);
  const orderDate = fmtDate(order.created_at);

  // Order-level values keyed by header name. Anything not set -> '' .
  const base = {
    'Order #': order.order_number,
    'Order Date': orderDate,
    'Date Paid': '',
    'Order Total': '',
    'Amount Paid': '',
    'Tax': '',
    'Shipping Paid': '',
    'Shipping Service': order.shipping_service || '',
    'Height(in)': '',
    'Length(in)': '',
    'Width(in)': '',
    'Weight(oz)': '',
    'Custom Field 1': clientName || '',
    'Custom Field 2': '',
    'Custom Field 3': '',
    'Order Source': 'FR-Logistics',
    'Notes to the Buyer': order.notes_to_buyer || '',
    'Notes from the Buyer': '',
    'Internal Notes': order.internal_notes || '',
    'Gift Message': '',
    'Gift Flag': '',
    'Buyer Full Name': '',
    'Buyer First Name': '',
    'Buyer Last Name': '',
    'Buyer Email': '',
    'Buyer Phone': '',
    'Buyer Username': '',
    'Recipient Full Name': order.recipient_name || '',
    'Recipient First Name': first,
    'Recipient Last Name': last,
    'Recipient Phone': order.recipient_phone || '',
    'Recipient Company': '',
    'Address Line 1': order.address_line1 || '',
    'Address Line 2': order.address_line2 || '',
    'Address Line 3': '',
    'City': order.city || '',
    'State': order.state || '',
    'Postal Code': order.postal_code || '',
    'Country Code': order.country_code || '',
  };

  if (items.length === 0) {
    // Order with no items still produces one row (item columns blank).
    return [CSV_HEADERS.map((h) => csvCell(base[h] !== undefined ? base[h] : '')).join(',')];
  }

  return items.map((it) => {
    const row = Object.assign({}, base, {
      'Item SKU': it.item_sku || '',
      'Item Name / Title': it.item_name || '',
      'Item Quantity': it.item_quantity != null ? it.item_quantity : '',
      'Item Unit Price': it.item_unit_price != null ? it.item_unit_price : '',
      'Item Weight (oz)': '',
      'Item Options': '',
      'Item Warehouse Location': '',
      'Item Marketplace ID': '',
    });
    return CSV_HEADERS.map((h) => csvCell(row[h] !== undefined ? row[h] : '')).join(',');
  });
}

async function sbFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      ...(opts.headers || {}),
    },
  });
  return res;
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const headers = corsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const action = (event.queryStringParameters || {}).action || 'list';

  // ---------- LIST: orders for the warehouse queue ----------
  if (action === 'list' && event.httpMethod === 'GET') {
    const status = (event.queryStringParameters || {}).status || 'pending';
    if (!VALID_STATUSES.includes(status) && status !== 'all') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid status filter' }) };
    }
    try {
      // Load all clients once, to resolve client_id -> name.
      const clientsRes = await sbFetch('fr_clients?select=id,name');
      if (!clientsRes.ok) {
        const t = await clientsRes.text();
        return { statusCode: 502, headers, body: JSON.stringify({ error: 'Clients lookup failed', detail: t }) };
      }
      const clients = await clientsRes.json();
      const clientById = {};
      clients.forEach((c) => { clientById[c.id] = c.name; });

      let query =
        'client_orders?select=id,client_id,order_number,status,recipient_name,recipient_phone,' +
        'address_line1,address_line2,city,state,postal_code,country_code,shipping_service,' +
        'notes_to_buyer,internal_notes,created_at,exported_at,exported_by,' +
        'client_order_items(id,item_sku,item_name,item_quantity,item_unit_price,sku_validated)' +
        '&order=created_at.desc';
      if (status !== 'all') query += `&status=eq.${status}`;

      const ordersRes = await sbFetch(query);
      if (!ordersRes.ok) {
        const t = await ordersRes.text();
        return { statusCode: 502, headers, body: JSON.stringify({ error: 'Orders fetch failed', detail: t }) };
      }
      const orders = await ordersRes.json();
      // Attach client_name to each order.
      orders.forEach((o) => { o.client_name = clientById[o.client_id] || '(unknown client)'; });

      return { statusCode: 200, headers, body: JSON.stringify({ orders }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error', detail: String(err) }) };
    }
  }

  // ---------- EXPORT: generate CSV + mark exported ----------
  if (action === 'export' && event.httpMethod === 'POST') {
    let payload;
    try {
      payload = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }
    const orderIds = Array.isArray(payload.order_ids) ? payload.order_ids : [];
    const exportedBy = (payload.exported_by || '').trim() || 'warehouse';
    if (orderIds.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No order_ids provided' }) };
    }

    try {
      // Resolve client names.
      const clientsRes = await sbFetch('fr_clients?select=id,name');
      if (!clientsRes.ok) {
        const t = await clientsRes.text();
        return { statusCode: 502, headers, body: JSON.stringify({ error: 'Clients lookup failed', detail: t }) };
      }
      const clients = await clientsRes.json();
      const clientById = {};
      clients.forEach((c) => { clientById[c.id] = c.name; });

      // Fetch the selected orders with items. Only 'pending' orders are exportable.
      const idList = orderIds.map((id) => `"${id}"`).join(',');
      const ordersRes = await sbFetch(
        'client_orders?select=id,client_id,order_number,status,recipient_name,recipient_phone,' +
        'address_line1,address_line2,city,state,postal_code,country_code,shipping_service,' +
        'notes_to_buyer,internal_notes,created_at,' +
        'client_order_items(id,item_sku,item_name,item_quantity,item_unit_price)' +
        `&id=in.(${idList})`
      );
      if (!ordersRes.ok) {
        const t = await ordersRes.text();
        return { statusCode: 502, headers, body: JSON.stringify({ error: 'Orders fetch failed', detail: t }) };
      }
      const orders = await ordersRes.json();
      if (orders.length === 0) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'No matching orders found' }) };
      }

      // Guard: only export orders that are still 'pending'. Skip the rest.
      const exportable = orders.filter((o) => o.status === 'pending');
      const skipped = orders.filter((o) => o.status !== 'pending').map((o) => o.order_number);
      if (exportable.length === 0) {
        return {
          statusCode: 409,
          headers,
          body: JSON.stringify({ error: 'None of the selected orders are pending', skipped }),
        };
      }

      // Build CSV.
      const lines = [CSV_HEADERS.map(csvCell).join(',')];
      exportable.forEach((o) => {
        const rows = orderToRows(o, clientById[o.client_id]);
        rows.forEach((r) => lines.push(r));
      });
      const csv = lines.join('\r\n');

      // Mark exportable orders as 'exported'.
      const nowIso = new Date().toISOString();
      const exportableIds = exportable.map((o) => `"${o.id}"`).join(',');
      const updateRes = await sbFetch(`client_orders?id=in.(${exportableIds})`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'exported', exported_at: nowIso, exported_by: exportedBy }),
      });
      if (!updateRes.ok) {
        const t = await updateRes.text();
        // CSV was built but the status update failed — surface clearly, do NOT return CSV
        // (returning it would risk a double-export later).
        return {
          statusCode: 502,
          headers,
          body: JSON.stringify({ error: 'Orders could not be marked exported — nothing was exported', detail: t }),
        };
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          csv,
          exported_count: exportable.length,
          exported_order_numbers: exportable.map((o) => o.order_number),
          skipped, // order numbers that were not pending and were left untouched
        }),
      };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error', detail: String(err) }) };
    }
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action or method' }) };
};
