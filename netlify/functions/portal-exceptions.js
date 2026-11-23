// netlify/functions/portal-exceptions.js
// FR-Logistics Client Portal — "Exceptions" tab (Delivery Guard, 23-nov-2026).
//
// The client sees every delivery case of its orders and decides in one click:
//   * address_pre_ship  → confirm_address | correct_address
//       (the ShipStation hold is released automatically)
//   * after shipping    → reship | return_to_stock | reroute
//       (requires cost_approved:true; FR staff carries it out)
//
// Auth contract: same as portal-outbound.js. The edge gate (auth-gate.js)
// forces portal_user to the signed-in email on GET and POST, and strips
// as_client for anybody who is not the admin.
//   CLIENT MODE: only that client's cases.
//   ADMIN MODE (warehouse@fr-logistics.net): all clients, or one with
//   ?as_client=<uuid> (GET) / "as_client" in the body (POST).
//
// GET  ?portal_user=…[&as_client=…][&days=60]  → { ok, open:[…], recent:[…] }
// POST { portal_user, as_client?, id, decision, data?, cost_approved? } → { ok, exception }

const core = require('./_delivery-guard/core.js');

const ALLOWED_ORIGINS = [
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
  'https://apps.fr-logistics.net',
];
const ADMIN_EMAIL = 'warehouse@fr-logistics.net';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
}

// Resolves who the caller is allowed to act for.
// → { allClients:boolean, client:{id,label}|null, isAdmin:boolean }
async function resolveCaller(portalUser, asClient) {
  const email = String(portalUser || '').trim().toLowerCase();
  const isAdmin = email === ADMIN_EMAIL;
  const viewingAs = isAdmin && UUID_RE.test(String(asClient || '')) ? String(asClient) : '';
  if (isAdmin && !viewingAs) return { allClients: true, client: null, isAdmin };
  const lookup = viewingAs ? `id=eq.${viewingAs}` : `portal_user=eq.${encodeURIComponent(portalUser)}`;
  const rows = await core.sb(`fr_clients?${lookup}&select=id,name,company,delivery_guard&limit=1`);
  const c = rows && rows[0];
  return { allClients: false, client: c ? { id: c.id, label: core.clientLabel(c), guard: !!c.delivery_guard } : null, isAdmin };
}

exports.handler = async (event) => {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const headers = cors(origin);
  const json = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  try {
    // ── GET: list ─────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
      const qs = event.queryStringParameters || {};
      if (!qs.portal_user) return json(400, { ok: false, error: 'missing portal_user' });
      const who = await resolveCaller(qs.portal_user, qs.as_client);
      if (!who.allClients && !who.client) return json(200, { ok: true, mode: 'no_client', open: [], recent: [] });

      const days = Math.min(Math.max(parseInt(qs.days, 10) || 60, 7), 365);
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const clientF = who.allClients ? '' : `&client_id=eq.${who.client.id}`;
      const rows = await core.sb(
        `shipment_exceptions?select=*,client:fr_clients(company,name)${clientF}` +
        `&or=(state.in.(${core.OPEN_STATES.join(',')}),detected_at.gte.${encodeURIComponent(since)})` +
        '&order=detected_at.desc&limit=300');
      const shape = (r) => ({
        ...core.publicException(r),
        ...(who.allClients ? { client: r.client ? (r.client.company || r.client.name) : '' } : {}),
      });
      const list = (rows || []).map(shape);
      return json(200, {
        ok: true,
        isAdmin: who.allClients,
        client: who.client ? { id: who.client.id, name: who.client.label } : null,
        guard_enabled: who.allClients ? true : !!(who.client && who.client.guard),
        open: list.filter((e) => e.state === 'awaiting_client' || e.state === 'decided' || e.state === 'in_progress'),
        recent: list.filter((e) => e.state === 'resolved' || e.state === 'closed'),
      });
    }

    // ── POST: decide ──────────────────────────────────────────────────────
    if (event.httpMethod === 'POST') {
      let p;
      try { p = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Invalid JSON body' }); }
      if (!p.portal_user) return json(400, { ok: false, error: 'missing portal_user' });
      if (!UUID_RE.test(String(p.id || ''))) return json(400, { ok: false, error: 'Invalid case id' });

      const who = await resolveCaller(p.portal_user, p.as_client);
      const rows = await core.sb(`shipment_exceptions?id=eq.${p.id}&select=*&limit=1`);
      const exc = rows && rows[0];
      // Same answer for "not yours" and "does not exist".
      if (!exc || (!who.allClients && (!who.client || exc.client_id !== who.client.id))) {
        return json(404, { ok: false, error: 'Case not found' });
      }
      const actor = who.isAdmin ? `${p.portal_user} (internal view)` : p.portal_user;
      try {
        const out = await core.applyDecision(exc, String(p.decision || ''), p.data || {}, actor, p.cost_approved === true);
        return json(200, { ok: true, exception: core.publicException(out) });
      } catch (e) {
        return json(e.status || 502, { ok: false, error: String(e.message || e) });
      }
    }

    return json(405, { ok: false, error: 'Method not allowed' });
  } catch (err) {
    return json(500, { ok: false, error: 'Server error', detail: String(err.message || err) });
  }
};
