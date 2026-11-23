// netlify/functions/delivery-exceptions.js
// FR-Logistics — DELIVERY GUARD, staff endpoint (23-nov-2026).
// Used by exceptions.html (apps portal). STAFF ONLY: the edge gate lets in
// only STAFF_EMAILS sessions (this is not a portal-* route).
//
// GET  ?state=open|all|awaiting_client|decided|in_progress|resolved|closed[&days=60]
//        → { ok, exceptions:[…], tracking_summary }
// POST { action:'run' }                                   → monitor pass now (short budget)
// POST { action:'set_state', id, state, note? }            → in_progress | resolved | closed
// POST { action:'note', id, internal_note }
// POST { action:'extend', id, days }                       → push due_at by N business days
// POST { action:'decide', id, decision, data?, cost_approved? } → decide for the client (phone call)

const core = require('./_delivery-guard/core.js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES = ['awaiting_client', 'decided', 'in_progress', 'resolved', 'closed'];

const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  const actor = (event.headers && (event.headers['x-fr-user-email'] || event.headers['X-Fr-User-Email'])) || 'staff';

  try {
    if (event.httpMethod === 'GET') {
      const qs = event.queryStringParameters || {};
      const state = String(qs.state || 'open');
      const days = Math.min(Math.max(parseInt(qs.days, 10) || 60, 1), 365);
      const since = new Date(Date.now() - days * 86400000).toISOString();
      let f;
      if (state === 'open') f = `state=in.(${core.OPEN_STATES.join(',')})`;
      else if (state === 'all') f = `detected_at=gte.${encodeURIComponent(since)}`;
      else if (STATES.includes(state)) f = `state=eq.${state}&detected_at=gte.${encodeURIComponent(since)}`;
      else return json(400, { ok: false, error: 'Invalid state filter' });

      const rows = await core.sb(`shipment_exceptions?${f}&select=*,client:fr_clients(company,name)&order=detected_at.desc&limit=500`);
      const exceptions = (rows || []).map((r) => ({
        ...core.publicException(r),
        client: r.client ? (r.client.company || r.client.name) : '',
        client_id: r.client_id,
        internal_note: r.internal_note,
        notified_at: r.notified_at,
        reminded_at: r.reminded_at,
        resolved_by: r.resolved_by,
        ss_order_id: r.ss_order_id,
        cost_approved: r.cost_approved,
      }));

      // Small health line for the page header: how many labels are followed.
      const trk = await core.sb('shipment_tracking?delivered_at=is.null&voided=eq.false&select=tracking_number,checked_at,check_error&limit=2000');
      const tracking_summary = {
        followed: (trk || []).length,
        with_errors: (trk || []).filter((t) => t.check_error).length,
        never_checked: (trk || []).filter((t) => !t.checked_at).length,
        last_check: (trk || []).map((t) => t.checked_at).filter(Boolean).sort().pop() || null,
      };
      const guarded = await core.guardedClients();
      return json(200, { ok: true, exceptions, tracking_summary, guarded_clients: guarded.map(core.clientLabel) });
    }

    if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
    let p;
    try { p = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Invalid JSON body' }); }
    const action = String(p.action || '');

    if (action === 'run') {
      // Browser call: Netlify cuts synchronous functions at ~10 s.
      const report = await core.runMonitor({ timeBudgetMs: 8000 });
      return json(200, { ok: true, report });
    }

    if (!UUID_RE.test(String(p.id || ''))) return json(400, { ok: false, error: 'Invalid id' });
    const exc = ((await core.sb(`shipment_exceptions?id=eq.${p.id}&select=*&limit=1`)) || [])[0];
    if (!exc) return json(404, { ok: false, error: 'Case not found' });
    const nowIso = new Date().toISOString();

    if (action === 'set_state') {
      const st = String(p.state || '');
      if (!['in_progress', 'resolved', 'closed'].includes(st)) return json(400, { ok: false, error: 'state must be in_progress, resolved or closed' });
      const patch = { state: st, updated_at: nowIso };
      if (st === 'resolved' || st === 'closed') Object.assign(patch, { resolved_at: nowIso, resolved_by: actor, resolution_note: String(p.note || '').slice(0, 500) || null });
      const out = (await core.sbPatch(`shipment_exceptions?id=eq.${exc.id}`, patch))[0];
      return json(200, { ok: true, exception: core.publicException(out) });
    }

    if (action === 'note') {
      const out = (await core.sbPatch(`shipment_exceptions?id=eq.${exc.id}`, { internal_note: String(p.internal_note || '').slice(0, 2000), updated_at: nowIso }))[0];
      return json(200, { ok: true, exception: core.publicException(out) });
    }

    if (action === 'extend') {
      const n = Math.min(Math.max(parseInt(p.days, 10) || 1, 1), 10);
      const base = exc.due_at && new Date(exc.due_at) > new Date() ? new Date(exc.due_at) : new Date();
      const out = (await core.sbPatch(`shipment_exceptions?id=eq.${exc.id}`, { due_at: core.addBusinessDays(base, n).toISOString(), reminded_at: null, updated_at: nowIso }))[0];
      return json(200, { ok: true, exception: core.publicException(out) });
    }

    if (action === 'decide') {
      try {
        const out = await core.applyDecision(exc, String(p.decision || ''), p.data || {}, `${actor} (staff)`, p.cost_approved === true);
        return json(200, { ok: true, exception: core.publicException(out) });
      } catch (e) {
        return json(e.status || 502, { ok: false, error: String(e.message || e) });
      }
    }

    return json(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    return json(500, { ok: false, error: 'Server error', detail: String(err.message || err) });
  }
};
