/**
 * frm-pallets.js  —  FR-Logistics
 *
 * Backend del modulo Pallets (armado de pallets de devoluciones).
 *
 * POR QUE EXISTE: hasta ahora el modulo hablaba DIRECTO a Supabase con la llave
 * anon incrustada en fr-mobile.html, que se sirve publico. Las tablas pallets y
 * pallet_packages tenian politica FOR ALL TO public y grants completos a anon,
 * incluidos DELETE y TRUNCATE. Cualquiera con "ver codigo fuente" podia vaciarlas.
 * Esta funcion mueve todo el acceso a la service key, del lado del servidor.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY  (ambas ya existen)
 *
 * GET  ?action=open                       -> pallets abiertos (status != FULL)
 * GET  ?action=pallet&pallet_id=FRP-…     -> un pallet con sus paquetes
 * GET  ?action=find_package&tracking=…    -> en que pallet esta un tracking
 * POST {action:'create',  client, pallet_size}
 * POST {action:'add_package', pallet_id, tracking, notes}
 * POST {action:'remove_package', pallet_id, tracking}
 * POST {action:'set_status', pallet_id, status}   FULL | WRAPPED | OPEN
 */

const ALLOWED_ORIGINS = [
  'https://apps.fr-logistics.net',
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
];

const STATUSES = ['OPEN', 'FULL', 'WRAPPED'];
const SIZES = ['48x40', '48x48', '42x42', 'Custom', ''];
const MAX_PACKAGES = 400;

/* ------------------------------------------------------------- helpers */

function headers(origin) {
  const o = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': o,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  };
}
const res = (code, body, origin) => ({
  statusCode: code, headers: headers(origin), body: JSON.stringify(body),
});

/**
 * Un tracking de transportista: alfanumerico, guiones permitidos.
 * Se valida SIEMPRE antes de que toque una URL de PostgREST — un valor sin
 * filtrar en un filtro eq. es una via de manipulacion de la consulta.
 */
function cleanTracking(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{5,49}$/.test(s)) return null;
  return s;
}

/** Los IDs los genera el servidor: FRP-YYYYMMDD-HHMMSS-XXXX */
function cleanPalletId(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  return /^FRP-\d{8}-\d{6}-[A-Z0-9]{4}$/.test(s) ? s : null;
}

function genPalletId() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const rnd = Math.random().toString(16).slice(2, 6).toUpperCase();
  return `FRP-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
       + `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${rnd}`;
}

async function sb(path, opts = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY');
  const r = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: key, Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json', ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) {
    const e = new Error(typeof body === 'string' ? body : JSON.stringify(body));
    e.status = r.status;
    throw e;
  }
  return body;
}

async function getPallet(palletId) {
  const rows = await sb(`pallets?pallet_id=eq.${encodeURIComponent(palletId)}&limit=1`);
  return (rows && rows[0]) || null;
}

/* ------------------------------------------------------------ acciones */

async function actionOpen() {
  const rows = await sb(
    'pallets?app_source=eq.pallets&status=neq.FULL&order=updated_at.desc&limit=50'
  );
  return {
    ok: true,
    pallets: (rows || []).map((r) => ({
      pallet_id: r.pallet_id, client: r.client || '', pallet_size: r.pallet_size || '',
      status: r.status || 'OPEN', count: (r.packages || []).length,
      created_at: r.created_at, updated_at: r.updated_at,
    })),
  };
}

async function actionPallet(q) {
  const id = cleanPalletId(q.pallet_id);
  if (!id) return { ok: false, error: 'BAD_PALLET_ID' };
  const p = await getPallet(id);
  if (!p) return { ok: false, error: 'NOT_FOUND' };
  return { ok: true, pallet: p };
}

async function actionFindPackage(q) {
  const trk = cleanTracking(q.tracking);
  if (!trk) return { ok: false, error: 'BAD_TRACKING' };
  const rows = await sb(
    `pallet_packages?tracking=eq.${encodeURIComponent(trk)}&select=tracking,pallet_id&limit=1`
  );
  return { ok: true, found: !!(rows && rows.length), package: (rows && rows[0]) || null };
}

async function actionCreate(b) {
  const client = String(b.client || '').trim().slice(0, 120);
  if (!client) return { ok: false, error: 'CLIENT_REQUIRED' };
  const size = SIZES.includes(String(b.pallet_size || '')) ? String(b.pallet_size || '') : '';

  const palletId = genPalletId();
  const [row] = await sb('pallets', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      pallet_id: palletId, client, pallet_size: size, status: 'OPEN',
      packages: [], app_source: 'pallets', updated_at: new Date().toISOString(),
    }]),
  });
  return { ok: true, pallet: row };
}

async function actionAddPackage(b) {
  const id = cleanPalletId(b.pallet_id);
  const trk = cleanTracking(b.tracking);
  if (!id) return { ok: false, error: 'BAD_PALLET_ID' };
  if (!trk) return { ok: false, error: 'BAD_TRACKING', message: 'Tracking must be 6-50 alphanumeric characters.' };
  if (/^FRP-/.test(trk)) return { ok: false, error: 'IS_PALLET_ID', message: 'That is a Pallet ID, not a carrier tracking.' };

  const pallet = await getPallet(id);
  if (!pallet) return { ok: false, error: 'NOT_FOUND' };
  if (pallet.status === 'WRAPPED')
    return { ok: false, error: 'WRAPPED', message: 'This pallet is already wrapped.' };

  const packages = pallet.packages || [];
  if (packages.some((p) => p.tracking === trk))
    return { ok: false, error: 'ALREADY_HERE', message: 'Already on this pallet.' };
  if (packages.length >= MAX_PACKAGES)
    return { ok: false, error: 'PALLET_FULL', message: `A pallet holds at most ${MAX_PACKAGES} packages.` };

  // El indice de pallet_packages es la fuente de verdad de "en que pallet esta".
  const elsewhere = await sb(
    `pallet_packages?tracking=eq.${encodeURIComponent(trk)}&select=pallet_id&limit=1`
  );
  if (elsewhere && elsewhere.length && elsewhere[0].pallet_id !== id) {
    return { ok: false, error: 'ON_ANOTHER_PALLET', pallet_id: elsewhere[0].pallet_id,
             message: `Already on pallet ${elsewhere[0].pallet_id}.` };
  }

  // El indice primero: si falla, el pallet no queda con un paquete fantasma.
  await sb('pallet_packages?on_conflict=tracking', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{ tracking: trk, pallet_id: id, notes: String(b.notes || '').slice(0, 200) }]),
  });

  packages.push({ tracking: trk, addedAt: new Date().toISOString(), notes: String(b.notes || '').slice(0, 200) });
  const [row] = await sb(`pallets?pallet_id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ packages, updated_at: new Date().toISOString() }),
  });
  return { ok: true, pallet: row, count: packages.length };
}

async function actionRemovePackage(b) {
  const id = cleanPalletId(b.pallet_id);
  const trk = cleanTracking(b.tracking);
  if (!id || !trk) return { ok: false, error: 'BAD_INPUT' };

  const pallet = await getPallet(id);
  if (!pallet) return { ok: false, error: 'NOT_FOUND' };
  if (pallet.status === 'WRAPPED')
    return { ok: false, error: 'WRAPPED', message: 'This pallet is already wrapped.' };

  const packages = (pallet.packages || []).filter((p) => p.tracking !== trk);

  // Borrado acotado a ESTE pallet: nunca puede tocar el registro de otro.
  await sb(
    `pallet_packages?tracking=eq.${encodeURIComponent(trk)}&pallet_id=eq.${encodeURIComponent(id)}`,
    { method: 'DELETE' }
  );
  const [row] = await sb(`pallets?pallet_id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ packages, updated_at: new Date().toISOString() }),
  });
  return { ok: true, pallet: row, count: packages.length };
}

async function actionSetStatus(b) {
  const id = cleanPalletId(b.pallet_id);
  const status = String(b.status || '').toUpperCase();
  if (!id) return { ok: false, error: 'BAD_PALLET_ID' };
  if (!STATUSES.includes(status)) return { ok: false, error: 'BAD_STATUS', allowed: STATUSES };

  const pallet = await getPallet(id);
  if (!pallet) return { ok: false, error: 'NOT_FOUND' };
  if (status !== 'OPEN' && !(pallet.packages || []).length)
    return { ok: false, error: 'EMPTY', message: 'An empty pallet cannot be closed.' };

  const patch = { status, updated_at: new Date().toISOString() };
  if (status === 'FULL' && !pallet.full_at) patch.full_at = new Date().toISOString();
  if (status === 'WRAPPED') {
    patch.wrapped_at = new Date().toISOString();
    if (!pallet.full_at) patch.full_at = patch.wrapped_at;
  }
  const [row] = await sb(`pallets?pallet_id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
  });
  return { ok: true, pallet: row };
}

/* -------------------------------------------------------------- handler */

exports.handler = async (event) => {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers(origin), body: '' };

  try {
    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};
      switch (q.action) {
        case 'open':         return res(200, await actionOpen(), origin);
        case 'pallet':       return res(200, await actionPallet(q), origin);
        case 'find_package': return res(200, await actionFindPackage(q), origin);
        default: return res(400, { ok: false, error: 'Unknown action',
                                   actions: ['open', 'pallet', 'find_package'] }, origin);
      }
    }

    if (event.httpMethod === 'POST') {
      let b = {};
      try { b = JSON.parse(event.body || '{}'); }
      catch { return res(400, { ok: false, error: 'BODY_NOT_JSON' }, origin); }

      switch (b.action) {
        case 'create':         return res(200, await actionCreate(b), origin);
        case 'add_package':    return res(200, await actionAddPackage(b), origin);
        case 'remove_package': return res(200, await actionRemovePackage(b), origin);
        case 'set_status':     return res(200, await actionSetStatus(b), origin);
        default: return res(400, { ok: false, error: 'Unknown action',
                 actions: ['create', 'add_package', 'remove_package', 'set_status'] }, origin);
      }
    }

    return res(405, { ok: false, error: 'Method not allowed' }, origin);
  } catch (e) {
    return res(e.status && e.status < 500 ? e.status : 500,
               { ok: false, error: String((e && e.message) || e) }, origin);
  }
};

module.exports.__test = { cleanTracking, cleanPalletId, genPalletId, STATUSES, SIZES, MAX_PACKAGES };
