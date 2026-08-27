// netlify/functions/portal-order-create.js
// FR-Logistics Client Portal — Paso 3
// Creates a new order (status forced to 'pending') for the client
// linked to portal_user. Autogenerates order_number.
// Same pattern as clients-list.js / portal-dashboard.js

const ALLOWED_ORIGINS = [
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
  'https://apps.fr-logistics.net',
];

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// ---------------------------------------------------------------------------
// Internal "View as client" — WRITES (August 2026)
// ---------------------------------------------------------------------------
// The portal's read functions accept ?as_client=<fr_clients.id> so the
// warehouse account can look at the portal exactly as a client sees it.
// Writes used to refuse that parameter outright, which meant the internal
// account could not upload a CSV or key an order on a client's behalf: the
// lookup fell back to fr_clients.portal_user = warehouse@... , matched
// nothing, and returned "No client linked to this portal user".
//
// Writes now accept as_client, under stricter rules than reads:
//   * ONLY the admin email may pass it. Anybody else who sends the parameter
//     gets a flat 403 — a real client never has a reason to send it, so its
//     presence is a tamper signal, not something to silently ignore.
//   * The value must be a well-formed UUID; anything else is rejected before
//     it reaches PostgREST.
//   * The admin account with NO as_client is a hard 400 with a message that
//     says what to do, instead of the misleading "no client linked" 404.
//   * Every row written this way is stamped in internal_notes with the
//     operator and timestamp, so a misfiled order can be traced later. This
//     is the audit trail that replaces the old blanket ban (see the six WS4B
//     orders filed under the wrong client in August 2026).
const PORTAL_ADMIN_EMAIL = String(process.env.PORTAL_ADMIN_EMAIL || 'warehouse@fr-logistics.net')
  .trim()
  .toLowerCase();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPortalAdmin(portalUser) {
  return String(portalUser || '').trim().toLowerCase() === PORTAL_ADMIN_EMAIL;
}

// Decide which fr_clients row this write belongs to.
// Returns { error, status } on refusal, or { filter, onBehalf } on success.
// `filter` is the PostgREST predicate; `onBehalf` is true when the internal
// account is writing for somebody else and the row needs an audit stamp.
function resolveClientTarget(portalUser, asClient) {
  const admin = isPortalAdmin(portalUser);
  const raw = asClient === undefined || asClient === null ? '' : String(asClient).trim();

  if (raw === '') {
    if (admin) {
      return {
        status: 400,
        error: 'Internal view: pick a client in the "Viewing as" selector before submitting. ' +
               'The warehouse account is not a client itself, so an order has to be filed under one.',
      };
    }
    return { filter: `portal_user=eq.${encodeURIComponent(portalUser)}`, onBehalf: false };
  }

  if (!admin) {
    return { status: 403, error: 'Not allowed to submit on behalf of another client' };
  }
  if (!UUID_RE.test(raw)) {
    return { status: 400, error: 'Invalid as_client' };
  }
  return { filter: `id=eq.${raw}`, onBehalf: true };
}

// Text dropped into client_orders.internal_notes for on-behalf writes.
function onBehalfStamp(portalUser) {
  return `Created from the internal view by ${portalUser} on ${new Date().toISOString()}`;
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

// Build a short prefix from the client name: letters/digits only, max 4 chars, uppercase.
function clientPrefix(name) {
  const cleaned = (name || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return cleaned.slice(0, 4) || 'CLNT';
}

function todayStamp() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// Required non-null fields the client must supply for client_orders
const REQUIRED_ORDER_FIELDS = [
  'recipient_name',
  'address_line1',
  'city',
  'state',
  'postal_code',
  'country_code',
];

// Fields the client is allowed to set (everything else is server-controlled)
const ALLOWED_ORDER_FIELDS = [
  ...REQUIRED_ORDER_FIELDS,
  'recipient_phone',
  'address_line2',
  'shipping_service',
  'notes_to_buyer',
];

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

  // Validate required order fields
  const order = payload.order || {};
  for (const f of REQUIRED_ORDER_FIELDS) {
    if (!order[f] || String(order[f]).trim() === '') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Missing required field: ${f}` }) };
    }
  }

  // Validate items
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (items.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Order must have at least one item' }) };
  }
  for (const it of items) {
    if (!it.item_sku || String(it.item_sku).trim() === '') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Each item needs an item_sku' }) };
    }
    const qty = parseInt(it.item_quantity, 10);
    if (!Number.isInteger(qty) || qty < 1) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Each item needs item_quantity >= 1' }) };
    }
  }

  try {
    // 1. Resolve the target client — the one linked to portal_user, or the one
    //    the internal account is explicitly filing for (as_client).
    const target = resolveClientTarget(portalUser, payload.as_client);
    if (target.error) {
      return { statusCode: target.status, headers, body: JSON.stringify({ error: target.error }) };
    }
    const clientRes = await fetch(
      `${SUPABASE_URL}/rest/v1/fr_clients?${target.filter}&select=id,name,company`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    if (!clientRes.ok) {
      const t = await clientRes.text();
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Supabase client lookup failed', detail: t }) };
    }
    const clients = await clientRes.json();
    if (!clients.length) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({
          error: target.onBehalf
            ? 'The selected client no longer exists'
            : 'No client linked to this portal user',
        }),
      };
    }
    const client = clients[0];
    const clientLabel = client.company || client.name || client.id;

    // 2. Compute next sequence number for today for this client
    const prefix = clientPrefix(client.name);
    const stamp = todayStamp();
    const numberBase = `ORD-${prefix}-${stamp}-`;

    const countRes = await fetch(
      `${SUPABASE_URL}/rest/v1/client_orders` +
        `?client_id=eq.${client.id}` +
        `&order_number=like.${encodeURIComponent(numberBase + '*')}` +
        `&select=order_number`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    if (!countRes.ok) {
      const t = await countRes.text();
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Supabase sequence lookup failed', detail: t }) };
    }
    const existing = await countRes.json();
    let maxSeq = 0;
    for (const row of existing) {
      const tail = (row.order_number || '').slice(numberBase.length);
      const n = parseInt(tail, 10);
      if (Number.isInteger(n) && n > maxSeq) maxSeq = n;
    }
    const orderNumber = numberBase + String(maxSeq + 1).padStart(3, '0');

    // 3. Build the order row — only whitelisted client fields + server-controlled fields
    const orderRow = { client_id: client.id, order_number: orderNumber, status: 'pending' };
    // Audit stamp: who keyed this, for whom, when. Only on internal writes.
    if (target.onBehalf) orderRow.internal_notes = onBehalfStamp(portalUser);
    for (const f of ALLOWED_ORDER_FIELDS) {
      if (order[f] !== undefined && order[f] !== null && String(order[f]).trim() !== '') {
        orderRow[f] = String(order[f]).trim();
      }
    }

    // 4. Insert order
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/client_orders`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(orderRow),
    });
    if (!insertRes.ok) {
      const t = await insertRes.text();
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Order insert failed', detail: t }) };
    }
    const inserted = await insertRes.json();
    const newOrder = inserted[0];

    // 5. Insert items
    const itemRows = items.map((it) => {
      const row = {
        order_id: newOrder.id,
        item_sku: String(it.item_sku).trim(),
        item_quantity: parseInt(it.item_quantity, 10),
        sku_validated: false, // ops validates later, never trust client
      };
      if (it.item_name && String(it.item_name).trim() !== '') {
        row.item_name = String(it.item_name).trim();
      }
      if (it.item_unit_price !== undefined && it.item_unit_price !== null && String(it.item_unit_price).trim() !== '') {
        const price = parseFloat(it.item_unit_price);
        if (!Number.isNaN(price)) row.item_unit_price = price;
      }
      return row;
    });

    const itemsRes = await fetch(`${SUPABASE_URL}/rest/v1/client_order_items`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(itemRows),
    });
    if (!itemsRes.ok) {
      const t = await itemsRes.text();
      // Order is in but items failed — surface clearly so ops can fix
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          error: 'Order created but items insert failed',
          order_number: newOrder.order_number,
          detail: t,
        }),
      };
    }
    const insertedItems = await itemsRes.json();

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({
        order: newOrder,
        items: insertedItems,
        client: { id: client.id, label: clientLabel },
        on_behalf: !!target.onBehalf,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error', detail: String(err) }) };
  }
};
