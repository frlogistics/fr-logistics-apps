// netlify/functions/frm-recon.js
// Conciliación física (handheld) de un retiro / pallet contra el ASN del cliente.
// Guarda una fila por bulto en wh_recon_scans con lo esperado vs lo contado.
//
//   GET  ?project=DLM_VENT-RO-OCT26               -> { rows:[...] }
//   GET  ?project=DLM_VENT-RO-OCT26&format=csv     -> CSV descargable
//   POST { action:'save', project, tracking, counted_units, expected_units,
//          removal_order, carrier, in_asn, client_code, client_id, operator, notes }
//        -> upsert por (project, tracking); un reescaneo REEMPLAZA el conteo
//   POST { action:'delete', project, tracking }   -> borra la fila
//
// Mismo patrón que frm-receive.js: service key del lado del servidor, CORS a
// los orígenes de FR, nunca se expone la llave al navegador.

const ALLOWED_ORIGINS = [
  'https://apps.fr-logistics.net',
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
];

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
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase not configured' }) };

  const sb = (path, init = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });

  const json = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });

  try {
    /* ---------------- GET ---------------- */
    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};
      const project = String(q.project || '').trim();
      if (!project) return json(400, { error: 'project is required' });

      const r = await sb(`wh_recon_scans?project=eq.${encodeURIComponent(project)}&order=scanned_at.asc&select=*`);
      if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
      const rows = await r.json();

      if (q.format === 'csv') {
        const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const head = ['tracking', 'removal_order', 'carrier', 'expected_units', 'counted_units', 'variance', 'in_asn', 'operator', 'scanned_at', 'notes'];
        const lines = [head.join(',')];
        for (const x of rows) {
          const variance = x.expected_units == null ? '' : (x.counted_units - x.expected_units);
          lines.push([x.tracking, x.removal_order, x.carrier, x.expected_units, x.counted_units, variance, x.in_asn ? 'yes' : 'no', x.operator, x.scanned_at, x.notes].map(esc).join(','));
        }
        return {
          statusCode: 200,
          headers: {
            ...headers,
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="recon_${project}.csv"`,
          },
          body: lines.join('\r\n'),
        };
      }
      return json(200, { rows });
    }

    /* ---------------- POST ---------------- */
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

    const project = String(body.project || '').trim();
    const tracking = String(body.tracking || '').trim().toUpperCase();
    if (!project) return json(400, { error: 'project is required' });
    if (!tracking) return json(400, { error: 'tracking is required' });

    if (body.action === 'delete') {
      const r = await sb(`wh_recon_scans?project=eq.${encodeURIComponent(project)}&tracking=eq.${encodeURIComponent(tracking)}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
      return json(200, { ok: true });
    }

    const counted = Number(body.counted_units);
    if (!Number.isInteger(counted) || counted < 0) return json(400, { error: 'counted_units must be a whole number >= 0' });
    const expected = body.expected_units == null || body.expected_units === '' ? null : Number(body.expected_units);
    if (expected != null && (!Number.isInteger(expected) || expected < 0)) return json(400, { error: 'expected_units invalid' });

    const row = {
      project,
      tracking,
      client_code: body.client_code ? String(body.client_code).slice(0, 16) : null,
      client_id: body.client_id || null,
      removal_order: body.removal_order ? String(body.removal_order).slice(0, 40) : null,
      carrier: body.carrier ? String(body.carrier).slice(0, 30) : null,
      expected_units: expected,
      counted_units: counted,
      in_asn: body.in_asn !== false,
      operator: String(body.operator || '').slice(0, 60) || null,
      notes: body.notes ? String(body.notes).slice(0, 400) : null,
      updated_at: new Date().toISOString(),
    };

    const r = await sb('wh_recon_scans?on_conflict=project,tracking', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(row),
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
    const data = await r.json();
    return json(200, { ok: true, row: Array.isArray(data) ? data[0] : data });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
