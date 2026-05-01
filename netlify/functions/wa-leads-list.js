// netlify/functions/wa-leads-list.js
//
// Lists WhatsApp leads from wa_leads (Supabase REST).
// Query params (all optional):
//   ?status=new|qualifying|sent_to_sales|won|lost
//   ?service=fba_prep|...|other
//   ?since=2026-04-01            (created_at >= since)
//   ?limit=50                    (default 50, max 200)
//   ?q=searchTerm                (matches name/email/phone)

function json(body, statusCode = 200) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPA_URL || !SUPA_KEY) {
    return json({ error: 'Server misconfigured: SUPABASE_URL or SUPABASE_SERVICE_KEY missing' }, 500);
  }

  const qp = event.queryStringParameters || {};
  const status   = (qp.status  || '').trim();
  const service  = (qp.service || '').trim();
  const since    = (qp.since   || '').trim();
  const q        = (qp.q       || '').trim();
  const limitRaw = parseInt(qp.limit || '50', 10);
  const limit    = Math.min(Math.max(isNaN(limitRaw) ? 50 : limitRaw, 1), 200);

  // Build Supabase REST query
  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('order', 'created_at.desc');
  params.set('limit', String(limit));
  if (status)  params.append('status', `eq.${status}`);
  if (service) params.append('service', `eq.${service}`);
  if (since)   params.append('created_at', `gte.${since}`);
  if (q) {
    const term = q.replace(/[%_,()]/g, '').replace(/\s+/g, ' ');
    if (term) {
      // PostgREST OR filter
      params.append('or', `(name.ilike.*${term}*,email.ilike.*${term}*,phone.ilike.*${term}*)`);
    }
  }

  const url = `${SUPA_URL}/rest/v1/wa_leads?${params.toString()}`;

  try {
    const res = await fetch(url, {
      headers: {
        'apikey':         SUPA_KEY,
        'Authorization':  `Bearer ${SUPA_KEY}`,
        'Prefer':         'count=exact',
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('[wa-leads-list] Supabase error:', res.status, errText);
      return json({ error: 'Query failed', details: errText }, 500);
    }

    const leads = await res.json();
    // PostgREST returns count via Content-Range header: "0-49/123"
    const range = res.headers.get('content-range') || '';
    const count = parseInt(range.split('/')[1], 10) || (leads ? leads.length : 0);

    return json({ leads: leads || [], count });
  } catch (e) {
    console.error('[wa-leads-list] Exception:', e.message);
    return json({ error: 'Network error', details: e.message }, 500);
  }
};
