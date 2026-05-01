// netlify/functions/wa-leads-create.js
//
// Creates a new WhatsApp lead in Supabase (wa_leads) and forwards it to
// info@fr-logistics.net via Resend's REST API.
//
// Style matches daily-summary.js / dropship-gmail-sync.js:
//   - CommonJS exports.handler
//   - Direct fetch to Supabase REST + Resend REST (no SDKs)
//   - Reads SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY from env

const { buildSubject, buildEmailHtml } = require('./_wa-lead-email');

const VALID_SERVICES = new Set([
  'fba_prep', 'shopify_dtc', 'cross_dock_latam', 'ecopack_plus',
  'hold_for_pickup', 'fnsku_relabel', 'freight_inbound', 'storage_only', 'other',
]);

const SALES_EMAIL = 'info@fr-logistics.net';
const FROM_EMAIL  = 'FR-Logistics LIAM <leads@fr-logistics.net>';
const REPLY_TO    = 'info@fr-logistics.net';

function json(body, statusCode = 200) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function opt(v) {
  const s = str(v);
  return s.length > 0 ? s : null;
}

function normalizePhone(v) {
  const raw = str(v);
  if (!raw) return '';
  const hasPlus = raw.startsWith('+');
  const digits = raw.replace(/[^0-9]/g, '');
  if (!digits) return '';
  return (hasPlus ? '+' : '') + digits;
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // Fail loudly on missing env vars (FR convention)
  const SUPA_URL  = process.env.SUPABASE_URL;
  const SUPA_KEY  = process.env.SUPABASE_SERVICE_KEY;
  const RESEND_KEY = process.env.RESEND_API_KEY;

  if (!SUPA_URL || !SUPA_KEY) {
    console.error('[wa-leads-create] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
    return json({ error: 'Server misconfigured: SUPABASE_URL or SUPABASE_SERVICE_KEY missing' }, 500);
  }
  if (!RESEND_KEY) {
    console.error('[wa-leads-create] Missing RESEND_API_KEY');
    return json({ error: 'Server misconfigured: RESEND_API_KEY missing' }, 500);
  }

  // Parse + validate body
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const errors = [];
  const name  = str(body.name);
  const email = str(body.email).toLowerCase();
  const phone = normalizePhone(body.phone);
  const lang  = body.language === 'es' ? 'es' : 'en';
  const service = VALID_SERVICES.has(body.service) ? body.service : 'other';

  if (!name)                          errors.push('name is required');
  if (!email || !email.includes('@')) errors.push('valid email is required');
  if (!phone)                         errors.push('phone is required');

  if (errors.length) return json({ error: 'Validation failed', details: errors }, 400);

  // ─── 1. INSERT into Supabase via REST API ────────────────────────────
  const insertPayload = {
    name,
    email,
    phone,
    country:              opt(body.country),
    language:             lang,
    service,
    service_detail:       opt(body.service_detail),
    monthly_volume:       opt(body.monthly_volume),
    skus:                 opt(body.skus),
    product_type:         opt(body.product_type),
    origin:               opt(body.origin),
    destination:          opt(body.destination),
    notes:                opt(body.notes),
    conversation_summary: opt(body.conversation_summary),
    captured_by:          opt(body.captured_by),
    status:               'new',
  };

  let lead;
  try {
    const insertRes = await fetch(`${SUPA_URL}/rest/v1/wa_leads`, {
      method: 'POST',
      headers: {
        'apikey':        SUPA_KEY,
        'Authorization': `Bearer ${SUPA_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=representation',
      },
      body: JSON.stringify(insertPayload),
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      console.error('[wa-leads-create] Supabase insert failed:', insertRes.status, errText);
      return json({ error: 'Database insert failed', details: errText }, 500);
    }

    const inserted = await insertRes.json();
    lead = Array.isArray(inserted) ? inserted[0] : inserted;
    if (!lead || !lead.id) {
      console.error('[wa-leads-create] Insert returned no row');
      return json({ error: 'Database insert returned no row' }, 500);
    }
  } catch (e) {
    console.error('[wa-leads-create] Supabase exception:', e.message);
    return json({ error: 'Database error', details: e.message }, 500);
  }

  // ─── 2. SEND via Resend REST API ────────────────────────────────────
  let emailSent = false;
  let messageId = null;
  let emailError = null;

  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:     FROM_EMAIL,
        to:       [SALES_EMAIL],
        reply_to: REPLY_TO,
        subject:  buildSubject(lead),
        html:     buildEmailHtml(lead),
        headers: {
          'X-Lead-ID':       lead.id,
          'X-Lead-Service':  lead.service,
          'X-Lead-Language': lead.language,
        },
      }),
    });

    const resendData = await resendRes.json();
    if (!resendRes.ok) {
      emailError = resendData.message || JSON.stringify(resendData);
      console.error('[wa-leads-create] Resend error:', emailError);
    } else {
      emailSent = true;
      messageId = resendData.id || null;
    }
  } catch (e) {
    emailError = e.message || String(e);
    console.error('[wa-leads-create] Resend exception:', emailError);
  }

  // ─── 3. UPDATE lead with email status (best effort) ─────────────────
  if (emailSent && messageId) {
    try {
      await fetch(`${SUPA_URL}/rest/v1/wa_leads?id=eq.${lead.id}`, {
        method: 'PATCH',
        headers: {
          'apikey':        SUPA_KEY,
          'Authorization': `Bearer ${SUPA_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          status:            'sent_to_sales',
          email_sent_at:     new Date().toISOString(),
          resend_message_id: messageId,
        }),
      });
    } catch (e) {
      console.error('[wa-leads-create] Status update failed (non-fatal):', e.message);
    }
  }

  return json({
    id: lead.id,
    email_sent: emailSent,
    resend_message_id: messageId,
    email_error: emailError,
    status: emailSent ? 'sent_to_sales' : 'new',
  }, emailSent ? 200 : 207);  // 207 Multi-Status: lead saved but email failed
};
