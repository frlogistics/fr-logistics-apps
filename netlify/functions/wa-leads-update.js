// netlify/functions/wa-leads-update.js
//
// Updates a WhatsApp lead (status, notes, assigned_to, conversation_summary).
// Body (JSON): { id, status?, notes?, assigned_to?, conversation_summary? }

const VALID_STATUSES = new Set(['new', 'qualifying', 'sent_to_sales', 'won', 'lost']);

function json(body, statusCode = 200) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function opt(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'PATCH' && event.httpMethod !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPA_URL || !SUPA_KEY) {
    return json({ error: 'Server misconfigured: SUPABASE_URL or SUPABASE_SERVICE_KEY missing' }, 500);
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return json({ error: 'id is required' }, 400);

  const updates = {};
  if ('status' in body) {
    if (!VALID_STATUSES.has(body.status)) {
      return json({ error: `Invalid status: ${body.status}` }, 400);
    }
    updates.status = body.status;
  }
  if ('notes' in body)                updates.notes                = opt(body.notes);
  if ('assigned_to' in body)          updates.assigned_to          = opt(body.assigned_to);
  if ('conversation_summary' in body) updates.conversation_summary = opt(body.conversation_summary);

  if (Object.keys(updates).length === 0) {
    return json({ error: 'No fields to update' }, 400);
  }

  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/wa_leads?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: {
        'apikey':         SUPA_KEY,
        'Authorization':  `Bearer ${SUPA_KEY}`,
        'Content-Type':   'application/json',
        'Prefer':         'return=representation',
      },
      body: JSON.stringify(updates),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('[wa-leads-update] Supabase error:', res.status, errText);
      return json({ error: 'Update failed', details: errText }, 500);
    }

    const rows = await res.json();
    const lead = Array.isArray(rows) ? rows[0] : rows;
    if (!lead) return json({ error: 'Lead not found' }, 404);

    return json({ lead });
  } catch (e) {
    console.error('[wa-leads-update] Exception:', e.message);
    return json({ error: 'Network error', details: e.message }, 500);
  }
};
