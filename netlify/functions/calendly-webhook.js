// netlify/functions/calendly-webhook.js
//
// Receives webhook events from Calendly and creates corresponding wa_leads
// entries via wa-leads-create.
//
// SECURITY: Verifies webhook signature against CALENDLY_WEBHOOK_SECRET
//
// EVENTS HANDLED:
//   - invitee.created  → INSERT new lead with status='qualifying'
//   - invitee.canceled → UPDATE existing lead to status='lost'
//
// CALENDLY EVENT TYPES (only Discovery Call creates leads):
//   - "Discovery Call — FR-Logistics 3PL"  (slug: discoverycall)         ✅ Creates lead
//   - "Client Onboarding — FR-Logistics"    (slug: josefuentes_fr_...)   ⏭️  Skipped (existing client)
//   - "Operations Review"                    (slug: clientonboarding)    ⏭️  Skipped (existing client)

const crypto = require('crypto');

// ─── CONFIG ─────────────────────────────────────────────────────────
const DISCOVERY_CALL_SLUGS = new Set(['discoverycall']);
const ONBOARDING_SLUGS     = new Set(['josefuentes_fr_onboarding']);
const OPS_REVIEW_SLUGS     = new Set(['clientonboarding']); // confusing slug, but it's Ops Review

// ─── COUNTRY MAPPING (Calendly answer → ISO code) ───────────────────
const COUNTRY_MAP = {
  'Mexico':       'MX',
  'México':       'MX',
  'Colombia':     'CO',
  'Argentina':    'AR',
  'Peru':         'PE',
  'Perú':         'PE',
  'Chile':        'CL',
  'USA':          'US',
  'United States': 'US',
  'Other / Otro': 'OTHER',
  'Otro':         'OTHER',
};

// ─── SERVICE MAPPING (Calendly sales channels → wa_leads.service) ──
//
// Calendly answer values for "Sales channels" multi_select:
//   ['Amazon FBA / Seller Fulfilled Prime', 'Walmart Marketplace',
//    'Shopify / DTC website', 'TikTok Shop', 'eBay', 'Wholesale / B2B']
//
// Priority: Amazon FBA > Shopify/DTC > others
function mapServiceFromChannels(channels) {
  if (!Array.isArray(channels)) channels = [channels].filter(Boolean);
  const lower = channels.map(c => String(c || '').toLowerCase());
  if (lower.some(c => c.includes('amazon') || c.includes('fba')))      return 'fba_prep';
  if (lower.some(c => c.includes('shopify') || c.includes('dtc')))     return 'shopify_dtc';
  if (lower.some(c => c.includes('walmart')))                          return 'fba_prep'; // close fit
  if (lower.some(c => c.includes('wholesale') || c.includes('b2b')))   return 'cross_dock_latam';
  if (lower.some(c => c.includes('tiktok') || c.includes('ebay')))     return 'shopify_dtc';
  return 'other';
}

// ─── LANGUAGE DETECTION (from country + business description) ──────
function detectLanguage(countryISO, businessDescription) {
  // LATAM countries default to ES
  if (['MX', 'CO', 'AR', 'PE', 'CL', 'VE', 'EC'].includes(countryISO)) return 'es';
  // US defaults to EN
  if (countryISO === 'US') return 'en';
  // Fallback: check if business description has Spanish markers
  const desc = String(businessDescription || '').toLowerCase();
  if (/[áéíóúñ]|cliente|empresa|negocio|venta|productos/.test(desc)) return 'es';
  return 'en';
}

// ─── HELPER: Find answer by question text (fuzzy match) ─────────────
function findAnswer(questions, keyword) {
  if (!Array.isArray(questions)) return null;
  const lower = String(keyword).toLowerCase();
  const found = questions.find(q =>
    String(q.question || '').toLowerCase().includes(lower)
  );
  return found ? found.answer : null;
}

// ─── HELPER: JSON response ───────────────────────────────────────────
function json(body, statusCode = 200) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// ─── SIGNATURE VERIFICATION ──────────────────────────────────────────
//
// Calendly sends signature in header: Calendly-Webhook-Signature
// Format: "t=<timestamp>,v1=<hmac_sha256_hex>"
//
// HMAC is computed over: `${timestamp}.${rawBody}`
function verifyCalendlySignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;

  const parts = String(sigHeader).split(',').reduce((acc, p) => {
    const [k, v] = p.split('=');
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {});

  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  // Reject signatures older than 5 minutes (replay protection)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) {
    console.warn('[calendly-webhook] Signature timestamp too old');
    return false;
  }

  const payload = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  // Constant-time comparison
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch (e) {
    return false;
  }
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const SECRET   = process.env.CALENDLY_WEBHOOK_SECRET;
  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SECRET) {
    console.error('[calendly-webhook] Missing CALENDLY_WEBHOOK_SECRET');
    return json({ error: 'Server misconfigured' }, 500);
  }
  if (!SUPA_URL || !SUPA_KEY) {
    console.error('[calendly-webhook] Missing Supabase env vars');
    return json({ error: 'Server misconfigured' }, 500);
  }

  // ─── Verify signature ──────────────────────────────────────────────
  const sigHeader = event.headers['calendly-webhook-signature']
                 || event.headers['Calendly-Webhook-Signature'];
  const rawBody = event.body || '';

  if (!verifyCalendlySignature(rawBody, sigHeader, SECRET)) {
    console.error('[calendly-webhook] Invalid signature');
    return json({ error: 'Invalid signature' }, 401);
  }

  // ─── Parse payload ─────────────────────────────────────────────────
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const eventType = payload.event;
  const data      = payload.payload || {};

  console.log(`[calendly-webhook] Event: ${eventType}`);

  // ─── ROUTE: invitee.canceled ───────────────────────────────────────
  if (eventType === 'invitee.canceled') {
    return await handleCanceled(data, SUPA_URL, SUPA_KEY);
  }

  // ─── ROUTE: invitee.created ────────────────────────────────────────
  if (eventType === 'invitee.created') {
    return await handleCreated(data, payload);
  }

  // Unknown event — ack but ignore
  console.log(`[calendly-webhook] Ignored event type: ${eventType}`);
  return json({ ok: true, ignored: eventType });
};

// ─── HANDLER: invitee.created → create lead ──────────────────────────
async function handleCreated(data, fullPayload) {
  const eventDetails = data.scheduled_event || {};
  const eventType    = eventDetails.event_type || '';
  const eventTypeSlug = String(eventType).split('/').pop();

  // Only Discovery Call creates leads
  if (!DISCOVERY_CALL_SLUGS.has(eventTypeSlug)) {
    if (ONBOARDING_SLUGS.has(eventTypeSlug)) {
      console.log('[calendly-webhook] Skipping Client Onboarding (existing client)');
      return json({ ok: true, skipped: 'client_onboarding' });
    }
    if (OPS_REVIEW_SLUGS.has(eventTypeSlug)) {
      console.log('[calendly-webhook] Skipping Ops Review (existing client)');
      return json({ ok: true, skipped: 'ops_review' });
    }
    console.log(`[calendly-webhook] Unknown event type slug: ${eventTypeSlug}`);
    return json({ ok: true, skipped: 'unknown_event_type' });
  }

  // Extract invitee data
  const name  = data.name || '';
  const email = (data.email || '').toLowerCase();
  const phone = data.text_reminder_number || '';  // Calendly stores SMS number here

  const questions = data.questions_and_answers || [];
  const businessDesc   = findAnswer(questions, 'tell us a little about your business');
  const countryAnswer  = findAnswer(questions, 'country');
  const volumeAnswer   = findAnswer(questions, 'volumen') || findAnswer(questions, 'monthly order volume');
  const channelsAnswer = findAnswer(questions, 'canales de venta') || findAnswer(questions, 'sales channels');
  const challengeAnswer = findAnswer(questions, 'reto operativo') || findAnswer(questions, 'challenge');
  const urlAnswer      = findAnswer(questions, 'website') || findAnswer(questions, 'amazon storefront');

  // Map to wa_leads schema
  const countryISO = COUNTRY_MAP[countryAnswer] || (countryAnswer ? 'OTHER' : null);
  const language   = detectLanguage(countryISO, businessDesc);
  const service    = mapServiceFromChannels(channelsAnswer);

  // Build conversation summary (the human-readable context for sales team)
  const summaryParts = [];
  if (businessDesc)    summaryParts.push(`💼 Business: ${businessDesc}`);
  if (volumeAnswer)    summaryParts.push(`📊 Volume: ${volumeAnswer}`);
  if (channelsAnswer)  summaryParts.push(`🛒 Channels: ${Array.isArray(channelsAnswer) ? channelsAnswer.join(', ') : channelsAnswer}`);
  if (challengeAnswer) summaryParts.push(`⚡ Challenge: ${challengeAnswer}`);
  if (urlAnswer)       summaryParts.push(`🔗 URL: ${urlAnswer}`);

  const meetingStart = eventDetails.start_time;
  const meetingEnd   = eventDetails.end_time;
  const meetingURL   = (eventDetails.location && eventDetails.location.join_url) || data.cancel_url || '';

  const leadPayload = {
    name,
    email,
    phone: phone || email, // fallback: use email if no phone (we need SOMETHING per validation)
    country: countryISO,
    language,
    service,
    monthly_volume:       volumeAnswer || null,
    notes:                challengeAnswer ? `Operational challenge: ${challengeAnswer}` : null,
    conversation_summary: summaryParts.join('\n'),
    captured_by:          'calendly_auto',
    source:               'calendly_discovery_call',
    meeting_url:          meetingURL,
    meeting_start_time:   meetingStart,
    meeting_end_time:     meetingEnd,
    calendly_event_uri:   eventDetails.uri || null,
    calendly_invitee_uri: data.uri || null,
    calendly_custom_answers: questions,
  };

  // Validate phone — if email is the only contact, log a warning
  if (!phone) {
    console.warn(`[calendly-webhook] No phone for ${email}, using email as phone fallback`);
  }

  // Forward to wa-leads-create internally
  // Use the same site's domain so it works in production
  const siteHost = process.env.URL || process.env.DEPLOY_URL || 'https://apps.fr-logistics.net';
  const createUrl = `${siteHost}/.netlify/functions/wa-leads-create`;

  try {
    const res = await fetch(createUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(leadPayload),
    });
    const result = await res.json();

    if (!res.ok && res.status !== 207) {
      console.error('[calendly-webhook] wa-leads-create failed:', result);
      return json({ error: 'Lead creation failed', details: result }, 500);
    }

    console.log(`[calendly-webhook] Created lead ${result.id} from Calendly Discovery Call`);
    return json({
      ok: true,
      lead_id: result.id,
      email_sent: result.email_sent,
      source: 'calendly_discovery_call',
    });
  } catch (e) {
    console.error('[calendly-webhook] Exception calling wa-leads-create:', e.message);
    return json({ error: 'Internal error', details: e.message }, 500);
  }
}

// ─── HANDLER: invitee.canceled → mark lead as lost ──────────────────
async function handleCanceled(data, SUPA_URL, SUPA_KEY) {
  const eventUri = (data.scheduled_event && data.scheduled_event.uri) || data.event;
  if (!eventUri) {
    return json({ ok: true, skipped: 'no_event_uri' });
  }

  try {
    // Find lead by calendly_event_uri
    const findRes = await fetch(
      `${SUPA_URL}/rest/v1/wa_leads?calendly_event_uri=eq.${encodeURIComponent(eventUri)}&select=id,status,name`,
      {
        headers: {
          'apikey':        SUPA_KEY,
          'Authorization': `Bearer ${SUPA_KEY}`,
        },
      }
    );
    const leads = await findRes.json();

    if (!Array.isArray(leads) || leads.length === 0) {
      console.log(`[calendly-webhook] No lead found for canceled event ${eventUri}`);
      return json({ ok: true, skipped: 'lead_not_found' });
    }

    const lead = leads[0];

    // Don't downgrade a "won" lead just because the meeting was canceled
    if (lead.status === 'won') {
      console.log(`[calendly-webhook] Lead ${lead.id} is already 'won', not changing status`);
      return json({ ok: true, skipped: 'lead_already_won' });
    }

    // Update to 'lost' with reason in notes
    const cancelReason = data.cancellation && data.cancellation.reason
      ? `Calendly meeting canceled. Reason: ${data.cancellation.reason}`
      : 'Calendly meeting canceled by invitee.';

    await fetch(`${SUPA_URL}/rest/v1/wa_leads?id=eq.${lead.id}`, {
      method: 'PATCH',
      headers: {
        'apikey':        SUPA_KEY,
        'Authorization': `Bearer ${SUPA_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        status: 'lost',
        notes:  cancelReason,
      }),
    });

    console.log(`[calendly-webhook] Marked lead ${lead.id} (${lead.name}) as lost`);
    return json({ ok: true, lead_id: lead.id, action: 'marked_lost' });
  } catch (e) {
    console.error('[calendly-webhook] Cancel handler exception:', e.message);
    return json({ error: 'Cancel handler failed', details: e.message }, 500);
  }
}
