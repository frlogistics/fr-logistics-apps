// netlify/functions/frm-label-data.js
// Read-only feed for label.html. One place decides what each label says, so a
// label printed by the agent and the same label opened by hand can never
// disagree.
//
// GET ?type=inbound|pallet|release&id=<uuid>
//
// Deliberately narrow: it returns only the handful of fields that fit on a 4x6
// and nothing else. No client list, no totals, no way to walk the warehouse
// from one id.

const ALLOWED_ORIGINS = [
  'https://apps.fr-logistics.net',
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
];

const SITE = 'https://apps.fr-logistics.net';

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin',
    'Content-Type': 'application/json',
  };
  const res = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res(500, { error: 'Supabase not configured' });

  const enc = encodeURIComponent;
  const sb = async (path) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${t}`);
    return t ? JSON.parse(t) : null;
  };

  const short = (s, n) => (s && String(s).length > n ? String(s).slice(0, n - 1) + '…' : (s || ''));

  // Every meta value goes through here. `pallets.packages` is a JSON array of
  // {tracking, addedAt, notes}, and String()-ing it printed a 4x6 label full of
  // "[object Object]". A label is the one place where a silent formatting bug
  // costs paper and gets stuck on a pallet, so anything that is not a plain
  // scalar is refused rather than rendered.
  const scalar = (v) => {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return String(v.length);      // a list means "how many"
    if (typeof v === 'object') return '';
    return String(v);
  };
  const count = (v) => {
    if (Array.isArray(v)) return v.length;
    if (typeof v === 'string') { try { const a = JSON.parse(v); return Array.isArray(a) ? a.length : 0; } catch { return 0; } }
    return Number(v) || 0;
  };
  const day = (d) => (d ? String(d).slice(0, 10) : '');

  try {
    const qs = event.queryStringParameters || {};
    const type = qs.type || '';
    const id = String(qs.id || '').trim();
    if (!id) return res(400, { error: 'id is required' });

    if (type === 'inbound') {
      const rows = await sb(
        `shipments_general?id=eq.${enc(id)}&select=id,tracking,client,type,carrier,direction,notes,created_at,received_at&limit=1`
      );
      const s = rows && rows[0];
      if (!s) return res(404, { error: 'NOT_FOUND', message: 'Shipment not found.' });
      if (String(s.direction || '').toLowerCase() === 'outbound') {
        return res(400, {
          error: 'OUTBOUND_NOT_LABELLED',
          message: 'Outbound packages carry the carrier label. FR does not print a second one.',
        });
      }
      return res(200, {
        tag: 'INBOUND',
        client: s.client,
        code: s.tracking,
        // Strips the redundant "Inbound (…)" wrapper so the type reads as
        // RMA / Overstock / Prep Service at a glance on the shelf.
        meta: [
          { label: 'Type',     value: scalar(s.type).replace(/^Inbound\s*/i, '').replace(/[()]/g, '') },
          { label: 'Carrier',  value: scalar(s.carrier) },
          { label: 'Received', value: day(s.received_at || s.created_at) },
          { label: 'Ref',      value: scalar(s.tracking).slice(-8) },
        ],
        notes: short(s.notes, 160),
        qr: s.tracking,
        hint: 'Scan the tracking to look this package up in FR Mobile.',
      });
    }

    if (type === 'pallet') {
      const rows = await sb(
        `pallets?id=eq.${enc(id)}&select=id,pallet_id,client,pallet_size,status,packages,created_at,full_at,wrapped_at&limit=1`
      );
      const p = rows && rows[0];
      if (!p) return res(404, { error: 'NOT_FOUND', message: 'Pallet not found.' });
      return res(200, {
        tag: 'PALLET',
        client: p.client,
        code: p.pallet_id,
        meta: [
          { label: 'Size',     value: scalar(p.pallet_size) },
          // packages is a JSON array of scanned trackings, not a number.
          { label: 'Packages', value: String(count(p.packages)) },
          { label: 'Status',   value: scalar(p.status) },
          { label: 'Built',    value: day(p.created_at) },
        ],
        // Package count is printed but the list is not: packages get added
        // after the label is stuck on, so a printed list would start lying the
        // moment the next box lands on the pallet.
        qr: p.pallet_id,
        hint: 'Package count is as of printing. Scan for the live list.',
      });
    }

    if (type === 'release') {
      const rows = await sb(
        `warehouse_releases?id=eq.${enc(id)}&select=id,release_id,client,reference,cargo_type,qty_units,weight_lb,pickup_company,released_at,created_at,status&limit=1`
      );
      const w = rows && rows[0];
      if (!w) return res(404, { error: 'NOT_FOUND', message: 'Release not found.' });
      return res(200, {
        tag: 'RELEASE',
        client: w.client,
        code: w.release_id,
        meta: [
          { label: 'Cargo',   value: scalar(w.cargo_type) },
          { label: 'Units',   value: scalar(w.qty_units) || '—' },
          { label: 'Weight',  value: w.weight_lb ? `${w.weight_lb} lb` : '—' },
          { label: 'Pickup',  value: short(scalar(w.pickup_company), 22) },
        ],
        notes: w.reference ? `Ref: ${short(w.reference, 120)}` : '',
        qr: `${SITE}/m/${w.release_id}`,
        hint: 'Scan to open the signed release record.',
      });
    }

    return res(400, { error: `Unknown type: ${type}` });
  } catch (err) {
    console.error('[frm-label-data]', err);
    return res(500, { error: 'Request failed', message: String(err.message || err) });
  }
};
