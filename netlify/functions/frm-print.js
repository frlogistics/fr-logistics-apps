// netlify/functions/frm-print.js
// Print queue for every label FR-Logistics prints in the warehouse.
//
// WHY THIS IS ITS OWN FUNCTION
// The queue started inside frm-containers.js because containers were the only
// thing printing. Now inbound packages, pallets and releases print too, and
// resolving a pallet label has nothing to do with containers. Leaving it there
// would turn that file into a junk drawer that has to know about every table
// in the warehouse. The queue is its own concern: it owns wh_print_jobs and
// knows only how to turn a job into a URL the agent can render.
//
// The agent (print-agent.html) polls next_job, loads label_url in an
// off-screen iframe, prints it, and reports back. It never learns what kind of
// label it printed — that is the whole point of a queue.
//
// NO OUTBOUND LABEL, on purpose. An outbound box already wears the carrier's
// label; a second barcode on the same box is how a sorter misreads it.
//
// Actions:
//   GET  ?action=next_job&agent=…
//   GET  ?action=print_queue
//   POST queue_print   { kind, code|ref_id, copies, actor }
//   POST finish_job    { job_id, ok, error }
//   POST requeue_job   { job_id }

const ALLOWED_ORIGINS = [
  'https://apps.fr-logistics.net',
  'https://fr-logistics.net',
  'https://www.fr-logistics.net',
];

const SITE = 'https://apps.fr-logistics.net';
const KINDS = ['container_label', 'inbound_label', 'pallet_label', 'release_label', 'test'];

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin',
    'Content-Type': 'application/json',
  };
  const res = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res(500, { error: 'Supabase not configured' });

  const enc = encodeURIComponent;
  const sb = async (path, opts = {}) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...opts,
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    const t = await r.text();
    if (!r.ok) { const e = new Error(`Supabase ${r.status}: ${t}`); e.status = r.status; throw e; }
    return t ? JSON.parse(t) : null;
  };
  const post = (table, rows) =>
    sb(table, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(rows) });
  const patch = (path, body) =>
    sb(path, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) });

  // Containers keep their own public token so the same URL works from a phone
  // scanning the QR. Everything else is internal-only and renders from label.html.
  const crypto = require('crypto');
  const containerUrl = (code) => {
    const tok = crypto.createHmac('sha256', SUPABASE_SERVICE_KEY)
      .update(`container:${code}`, 'utf8').digest('hex').slice(0, 6).toUpperCase();
    return `${SITE}/c/${code}-${tok}`;
  };

  const labelUrlFor = (job) => {
    switch (job.kind) {
      case 'container_label': return job.code ? containerUrl(job.code) : null;
      case 'inbound_label':   return `${SITE}/label.html?type=inbound&id=${enc(job.ref_id || '')}`;
      case 'pallet_label':    return `${SITE}/label.html?type=pallet&id=${enc(job.ref_id || '')}`;
      case 'release_label':   return `${SITE}/label.html?type=release&id=${enc(job.ref_id || '')}`;
      default: return null;   // 'test' is rendered by the agent itself
    }
  };

  try {
    const qs = event.queryStringParameters || {};
    let body = {};
    if (event.httpMethod === 'POST') {
      try { body = JSON.parse(event.body || '{}'); }
      catch { return res(400, { error: 'Invalid JSON body' }); }
    }
    const action = (event.httpMethod === 'GET' ? qs.action : body.action) || '';

    if (action === 'next_job') {
      const agent = String(qs.agent || 'agent').slice(0, 60);
      const queued = await sb('wh_print_jobs?status=eq.queued&select=*&order=created_at.asc&limit=1');
      if (!queued || !queued[0]) return res(200, { job: null });

      // Claim and filter on status in the same statement: if two polls overlap,
      // the second updates zero rows and walks away empty. Without this a slow
      // network turns into duplicate labels, and two boxes wearing the same
      // plate is worse than no label at all.
      const claimed = await patch(
        `wh_print_jobs?id=eq.${enc(queued[0].id)}&status=eq.queued`,
        { status: 'printing', agent, claimed_at: new Date().toISOString(),
          attempts: (queued[0].attempts || 0) + 1 }
      );
      if (!claimed || !claimed[0]) return res(200, { job: null, raced: true });

      const job = claimed[0];
      return res(200, { job, label_url: labelUrlFor(job) });
    }

    if (action === 'print_queue') {
      const rows = await sb('v_wh_print_queue?select=*&order=created_at.desc&limit=50');
      const all = rows || [];
      return res(200, {
        jobs: all,
        queued: all.filter((j) => j.status === 'queued').length,
        stalled: all.filter((j) => j.stalled).length,
      });
    }

    if (event.httpMethod !== 'POST') return res(405, { error: 'Method not allowed' });
    const actor = body.actor ? String(body.actor).slice(0, 60) : null;

    if (action === 'queue_print') {
      const kind = KINDS.includes(body.kind) ? body.kind : 'container_label';
      const copies = Math.min(Math.max(parseInt(body.copies, 10) || 1, 1), 20);
      const row = { kind, copies, requested_by: actor };

      if (kind === 'test') {
        row.code = 'TEST';
      } else if (kind === 'container_label') {
        const c = await sb(`wh_containers?code=eq.${enc(String(body.code || '').trim())}&select=id,code&limit=1`);
        if (!c || !c[0]) return res(404, { error: 'Container not found', code: body.code || null });
        row.container_id = c[0].id;
        row.code = c[0].code;
      } else {
        // Everything else is addressed by the source record's id. The label is
        // rendered fresh at print time, so a job that waits in the queue prints
        // what the record says NOW, not what it said when it was requested.
        let id = String(body.ref_id || '').trim();

        // A pallet is known on the floor by its printed code (PAL-…), not by a
        // uuid nobody can read. Accept either and resolve to the row id, so the
        // caller never has to carry a key it does not display.
        if (!id && kind === 'pallet_label' && body.code) {
          const byCode = await sb(
            `pallets?pallet_id=eq.${enc(String(body.code).trim())}&select=id&limit=1`
          );
          if (!byCode || !byCode[0]) return res(404, { error: 'Pallet not found', code: body.code });
          id = byCode[0].id;
        }

        if (!id) return res(400, { error: 'ref_id is required for ' + kind });
        row.ref_id = id;

        if (kind === 'inbound_label') {
          const s = await sb(`shipments_general?id=eq.${enc(id)}&select=tracking,direction&limit=1`);
          if (!s || !s[0]) return res(404, { error: 'Shipment not found' });
          if (String(s[0].direction || '').toLowerCase() === 'outbound') {
            return res(400, {
              error: 'OUTBOUND_NOT_LABELLED',
              message: 'Outbound packages carry the carrier label. FR does not print a second one.',
            });
          }
          row.code = s[0].tracking;
        } else if (kind === 'pallet_label') {
          const p = await sb(`pallets?id=eq.${enc(id)}&select=pallet_id&limit=1`);
          if (!p || !p[0]) return res(404, { error: 'Pallet not found' });
          row.code = p[0].pallet_id;
          // (pallets are also addressable by their human code — see below)
        } else if (kind === 'release_label') {
          const w = await sb(`warehouse_releases?id=eq.${enc(id)}&select=release_id&limit=1`);
          if (!w || !w[0]) return res(404, { error: 'Release not found' });
          row.code = w[0].release_id;
        }
      }

      const created = await post('wh_print_jobs', [row]);
      return res(200, { job: created[0], code: row.code });
    }

    if (action === 'finish_job') {
      if (!body.job_id) return res(400, { error: 'job_id is required' });
      const ok = body.ok !== false;
      const upd = await patch(`wh_print_jobs?id=eq.${enc(body.job_id)}`, {
        status: ok ? 'done' : 'failed',
        error: ok ? null : String(body.error || 'unknown').slice(0, 500),
        finished_at: new Date().toISOString(),
      });
      return res(200, { job: upd && upd[0] });
    }

    if (action === 'requeue_job') {
      if (!body.job_id) return res(400, { error: 'job_id is required' });
      const upd = await patch(`wh_print_jobs?id=eq.${enc(body.job_id)}`, {
        status: 'queued', agent: null, claimed_at: null, error: null,
      });
      return res(200, { job: upd && upd[0] });
    }

    return res(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[frm-print]', err);
    return res(err.status && err.status < 500 ? err.status : 500,
               { error: 'Request failed', message: String(err.message || err) });
  }
};
