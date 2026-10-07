// netlify/functions/client-orders-ss-check.js
// FR-Logistics — Verificación "¿la orden exportada realmente llegó a ShipStation?"
//
// PROBLEMA QUE RESUELVE (7-oct-2026):
//   La pantalla Client Orders (warehouse-orders.html) marca una orden como
//   'exported' en el momento en que se DESCARGA el CSV. Si el CSV nunca se
//   importa en ShipStation, la orden se queda "Exported" para siempre y nadie
//   se entera (caso real: ORD-JULI-20261005-002..006 de MXS Overseas Ltd).
//
// QUÉ HACE:
//   Busca en la API v1 de ShipStation cada orden con status='exported' que
//   todavía no tiene ss_order_id (exportada en los últimos LOOKBACK_DAYS) y
//   escribe el resultado en client_orders:
//     ss_state = 'found'   + ss_order_id, ss_order_status, ss_found_at
//     ss_state = 'missing' (y sigue revisándola en cada corrida hasta que aparezca)
//   Una orden 'found' no se vuelve a consultar (ya tiene ss_order_id).
//
// ENDPOINTS (HTTP, SIN schedule — el navegador lo llama al abrir la pantalla):
//   GET  /.netlify/functions/client-orders-ss-check            -> verifica y devuelve resumen
//   GET  /.netlify/functions/client-orders-ss-check?dry_run=1  -> consulta ShipStation sin escribir
//
// La alerta por correo NO vive aquí: la manda client-orders-ss-alert.js
// (función programada), que reutiliza runCheck() de este archivo. Regla del
// stack: una función que le responde al navegador no puede tener schedule.
//
// Variables de entorno (todas YA existen, no agrega ninguna):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY, SS_API_KEY, SS_API_SECRET

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SS = 'https://ssapi.shipstation.com';

// Solo se verifican órdenes exportadas en esta ventana. Lo más viejo que siga
// sin ss_order_id no se consulta (evita quemar el rate limit con el histórico).
const LOOKBACK_DAYS = 30;
// Tope de consultas a ShipStation por corrida (la API v1 permite 40/min).
const MAX_LOOKUPS_PER_RUN = 30;
// Presupuesto de tiempo por llamada HTTP. Netlify corta una función síncrona
// a los ~10 s con "504 Inactivity Timeout" (pasó el 7-oct-2026 en la carga
// inicial de 68 órdenes, consultadas de a una). Al agotarse el presupuesto se
// devuelve lo hecho y `backlog` dice cuántas faltan; la pantalla vuelve a
// llamar sola. La función programada pasa un presupuesto mayor (límite 30 s).
const DEFAULT_TIME_BUDGET_MS = 7000;
// Consultas simultáneas a ShipStation.
const CONCURRENCY = 4;
// Horas desde la exportación a partir de las cuales una orden 'missing'
// se considera ALERTA (antes de eso es normal: el operador está importando).
const GRACE_HOURS = 2;

const ALLOWED_ORIGINS = [
  'https://apps.fr-logistics.net',
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };
}

// ─── Supabase ────────────────────────────────────────────────────────────────
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

async function sbPatchOrder(id, data) {
  const r = await sbFetch(`client_orders?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`PATCH client_orders ${id}: ${r.status} ${await r.text()}`);
}

// ─── ShipStation ─────────────────────────────────────────────────────────────
function ssAuth() {
  const key = process.env.SS_API_KEY;
  const sec = process.env.SS_API_SECRET;
  if (!key || !sec) throw new Error('SS credentials missing (SS_API_KEY / SS_API_SECRET)');
  return { Authorization: `Basic ${Buffer.from(`${key}:${sec}`).toString('base64')}` };
}

// GET /orders?orderNumber= hace búsqueda "empieza con", así que se filtra
// exacto en el resultado (ORD-...-001 no debe casar con ORD-...-0010).
// Devuelve { order|null, rateLimited:boolean }.
async function ssFindOrder(orderNumber, auth) {
  const url = `${SS}/orders?orderNumber=${encodeURIComponent(orderNumber)}&pageSize=100`;
  const r = await fetch(url, { headers: auth });
  if (r.status === 429) return { order: null, rateLimited: true };
  if (!r.ok) throw new Error(`ShipStation ${r.status} for ${orderNumber}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const want = String(orderNumber).trim().toLowerCase();
  const matches = (j.orders || []).filter(
    (o) => String(o.orderNumber || '').trim().toLowerCase() === want
  );
  // Si hay varias (importada dos veces), preferir la que no esté cancelada.
  matches.sort((a, b) => (a.orderStatus === 'cancelled') - (b.orderStatus === 'cancelled'));
  const remaining = Number(r.headers.get('X-Rate-Limit-Remaining'));
  return { order: matches[0] || null, duplicates: matches.length, rateLimited: false, remaining };
}

function hoursSince(iso) {
  if (!iso) return null;
  return (Date.now() - new Date(iso).getTime()) / 3600000;
}

// ─── Núcleo reutilizable ─────────────────────────────────────────────────────
// options.dryRun = true -> consulta ShipStation pero no escribe en Supabase.
async function runCheck(options = {}) {
  const dryRun = !!options.dryRun;
  const startedAt = Date.now();
  const timeBudgetMs = Number(options.timeBudgetMs) > 0 ? Number(options.timeBudgetMs) : DEFAULT_TIME_BUDGET_MS;
  const auth = ssAuth();
  const sinceIso = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();

  // Clientes para mostrar company (regla de identidad: company > contact name).
  const cr = await sbFetch('fr_clients?select=id,name,company');
  if (!cr.ok) throw new Error(`fr_clients: ${cr.status} ${await cr.text()}`);
  const clientName = {};
  (await cr.json()).forEach((c) => { clientName[c.id] = (c.company && c.company.trim()) || c.name; });

  // Pendientes de verificar: exportadas, sin ss_order_id, dentro de la ventana.
  // Primero las nunca revisadas y, dentro de eso, las exportadas MÁS RECIENTES
  // (son las urgentes: las viejas casi siempre ya se despacharon).
  const q =
    'client_orders?select=id,client_id,order_number,recipient_name,exported_at,exported_by,' +
    'ss_state,ss_checked_at,ss_alerted_at' +
    `&status=eq.exported&ss_order_id=is.null&exported_at=gte.${encodeURIComponent(sinceIso)}` +
    '&order=ss_checked_at.asc.nullsfirst,exported_at.desc&limit=200';
  const pr = await sbFetch(q);
  if (!pr.ok) throw new Error(`client_orders: ${pr.status} ${await pr.text()}`);
  const toCheck = await pr.json();

  const found = [];
  const missing = [];
  const errors = [];
  let checked = 0;
  let rateLimited = false;

  // Verifica UNA orden y escribe el resultado. Devuelve 'found' | 'missing' | 'rate_limited' | 'error'.
  async function checkOne(o) {
    let res;
    try {
      res = await ssFindOrder(o.order_number, auth);
    } catch (e) {
      errors.push({ order_number: o.order_number, error: String(e.message || e) });
      return 'error';
    }
    if (res.rateLimited) return 'rate_limited';
    checked++;
    const nowIso = new Date().toISOString();
    try {
      if (res.order) {
        found.push({
          id: o.id,
          order_number: o.order_number,
          client: clientName[o.client_id] || '(unknown client)',
          ss_order_id: res.order.orderId,
          ss_order_status: res.order.orderStatus,
          duplicates_in_shipstation: res.duplicates > 1 ? res.duplicates : undefined,
        });
        if (!dryRun) {
          await sbPatchOrder(o.id, {
            ss_state: 'found',
            ss_order_id: res.order.orderId,
            ss_order_status: res.order.orderStatus,
            ss_checked_at: nowIso,
            ss_found_at: nowIso,
          });
        }
      } else if (!dryRun) {
        await sbPatchOrder(o.id, { ss_state: 'missing', ss_checked_at: nowIso });
      }
    } catch (e) {
      errors.push({ order_number: o.order_number, error: String(e.message || e) });
      return 'error';
    }
    // Respetar el rate limit si ShipStation avisa que quedan pocas consultas.
    if (Number.isFinite(res.remaining) && res.remaining <= CONCURRENCY) return 'rate_limited';
    return res.order ? 'found' : 'missing';
  }

  let processed = 0;
  let timedOut = false;
  while (processed < toCheck.length && checked < MAX_LOOKUPS_PER_RUN) {
    if (Date.now() - startedAt > timeBudgetMs) { timedOut = true; break; }
    const batch = toCheck.slice(processed, processed + CONCURRENCY);
    processed += batch.length;
    const outcomes = await Promise.all(batch.map(checkOne));
    if (outcomes.includes('rate_limited')) { rateLimited = true; break; }
  }

  // Estado final de TODAS las que siguen sin aparecer (incluye las que no se
  // alcanzaron a consultar en esta corrida pero ya estaban 'missing').
  const mr = await sbFetch(
    'client_orders?select=id,client_id,order_number,recipient_name,city,state,exported_at,' +
    'exported_by,ss_state,ss_checked_at,ss_alerted_at' +
    `&status=eq.exported&ss_order_id=is.null&exported_at=gte.${encodeURIComponent(sinceIso)}` +
    '&order=exported_at.asc'
  );
  if (!mr.ok) throw new Error(`client_orders (missing): ${mr.status} ${await mr.text()}`);
  (await mr.json()).forEach((o) => {
    const age = hoursSince(o.exported_at);
    missing.push({
      id: o.id,
      order_number: o.order_number,
      client: clientName[o.client_id] || '(unknown client)',
      recipient_name: o.recipient_name,
      destination: [o.city, o.state].filter(Boolean).join(', '),
      exported_at: o.exported_at,
      exported_by: o.exported_by,
      hours_since_export: age == null ? null : Math.round(age * 10) / 10,
      // 'alert' = pasó la gracia y sigue sin estar; 'waiting' = recién exportada.
      severity: age != null && age >= GRACE_HOURS ? 'alert' : 'waiting',
      verified: o.ss_state === 'missing', // false = aún no se pudo consultar
      ss_checked_at: o.ss_checked_at,
      ss_alerted_at: o.ss_alerted_at,
    });
  });

  return {
    ok: true,
    dry_run: dryRun,
    checked_at: new Date().toISOString(),
    grace_hours: GRACE_HOURS,
    lookback_days: LOOKBACK_DAYS,
    candidates: toCheck.length,
    lookups: checked,
    // Órdenes que quedaron sin consultar en esta corrida (se siguen en la próxima).
    backlog: missing.filter((m) => !m.verified).length,
    timed_out: timedOut,
    elapsed_ms: Date.now() - startedAt,
    rate_limited: rateLimited,
    found,
    missing,
    alert_count: missing.filter((m) => m.severity === 'alert' && m.verified).length,
    errors,
  };
}

exports.runCheck = runCheck;
exports.GRACE_HOURS = GRACE_HOURS;

exports.handler = async (event) => {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const headers = corsHeaders(origin);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Use GET' }) };
  }
  const p = event.queryStringParameters || {};
  try {
    const result = await runCheck({ dryRun: p.dry_run === '1' });
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: String(err.message || err) }),
    };
  }
};
