// netlify/functions/calendly-webhook.js
//
// Receives webhook events from Calendly and creates corresponding wa_leads
// entries via wa-leads-create.
//
// 2026-05-18 v2: Calendly sends event_type as UUID (not slug). Updated to
//                match by UUID directly. Also kept slug fallback for safety.
//
// 2026-05-18 v1: Removed HMAC signature verification (Calendly does not expose
// signing_key via PAT API). Replaced with structural payload validation.

// ─── CONFIG ─────────────────────────────────────────────────────────
//
// Event type UUIDs (extracted from Calendly's event_type URI)
// To find a UUID: GET https://api.calendly.com/event_types or check the URL
// when editing an event type in Calendly admin.
//
const DISCOVERY_CALL_UUIDS = new Set([
  '370979b2-00e9-4877-98b1-d3f908acbcb0',  // Discovery Call — FR-Logistics 3PL
]);

const ONBOARDING_UUIDS = new Set([
  'a3a27acf-8e46-4ea6-b0e0-169863bf0988',  // Client Onboarding — FR-Logistics
]);

const OPS_REVIEW_UUIDS = new Set([
  '3daf975f-feef-4a4e-a0f6-91fb62c92ce8',  // Operations Review
]);

// Legacy slug matching (kept as fallback for safety)
const DISCOVERY_CALL_SLUGS = new Set(['discoverycall']);
const ONBOARDING_SLUGS     = new Set(['josefuentes_fr_onboarding']);
const OPS_REVIEW_SLUGS     = new Set(['clientonboarding']);

const VALID_EVENT_TYPES = new Set(['invitee.created', 'invitee.canceled']);
const CALENDLY_EVENT_URI_PREFIX = 'https://api.calendly.com/scheduled_events/';

// ─── COUNTRY MAPPING ────────────────────────────────────────────────
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

// ─── SERVICE MAPPING ────────────────────────────────────────────────
function mapServiceFromChannels(channels) {
  if (!Array.isArray(channels)) channels = [channels].filter(Boolean);
  const lower = channels.map(c => String(c || '').toLowerCase());
  if (lower.some(c => c.includes('amazon') || c.includes('fba')))      return 'fba_prep';
  if (lower.some(c => c.includes('shopify') || c.includes('dtc')))     return 'shopify_dtc';
  if (lower.some(c => c.includes('walmart')))                          return 'fba_prep';
  if (lower.some(c => c.includes('wholesale') || c.includes('b2b')))   return 'cross_dock_latam';
  if (lower.some(c => c.includes('tiktok') || c.includes('ebay')))     return 'shopify_dtc';
  return 'other';
}

// ─── LANGUAGE DETECTION ─────────────────────────────────────────────
function detectLanguage(countryISO, businessDescription) {
  if (['MX', 'CO', 'AR', 'PE', 'CL', 'VE', 'EC'].includes(countryISO)) return 'es';
  if (countryISO === 'US') return 'en';
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

// ─── HELPER: Match event type identifier against a set ──────────────
//
// Tries both UUID match and slug match for robustness.
function matchesEventType(eventTypeUri, uuidSet, slugSet) {
  if (!eventTypeUri) return false;
  const lastSegment = String(eventTypeUri).split('/').pop();
  return uuidSet.has(lastSegment) || slugSet.has(lastSegment);
}

// ─── HELPER: JSON response ───────────────────────────────────────────
function json(body, statusCode = 200) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// ─── STRUCTURAL VALIDATION (replaces HMAC) ──────────────────────────
function validatePayload(payload) {
  const errors = [];

  if (!payload || typeof payload !== 'object') {
    errors.push('payload is not an object');
    return errors;
  }

  if (!payload.event) {
    errors.push('payload.event is missing');
  } else if (!VALID_EVENT_TYPES.has(payload.event)) {
    errors.push(`payload.event "${payload.event}" is not a valid event type`);
  }

  if (!payload.payload || typeof payload.payload !== 'object') {
    errors.push('payload.payload is missing or not an object');
    return errors;
  }

  const data = payload.payload;

  if (payload.event === 'invitee.created') {
    if (!data.scheduled_event || typeof data.scheduled_event !== 'object') {
      errors.push('payload.payload.scheduled_event is missing');
    } else {
      const eventUri = data.scheduled_event.uri;
      if (!eventUri || typeof eventUri !== 'string') {
        errors.push('scheduled_event.uri is missing');
      } else if (!eventUri.startsWith(CALENDLY_EVENT_URI_PREFIX)) {
        errors.push(`scheduled_event.uri does not start with ${CALENDLY_EVENT_URI_PREFIX}`);
      }
    }

    if (!data.email && !data.name) {
      errors.push('Both email and name are missing from invitee');
    }
  }

  if (payload.event === 'invitee.canceled') {
    const eventUri = (data.scheduled_event && data.scheduled_event.uri) || data.event;
    if (!eventUri) {
      errors.push('Cannot identify canceled event');
    } else if (typeof eventUri === 'string' && !eventUri.startsWith(CALENDLY_EVENT_URI_PREFIX)) {
      errors.push('Canceled event URI does not start with Calendly prefix');
    }
  }

  return errors;
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPA_URL || !SUPA_KEY) {
    console.error('[calendly-webhook] Missing Supabase env vars');
    return json({ error: 'Server misconfigured' }, 500);
  }

  // ─── Parse payload ─────────────────────────────────────────────────
  const rawBody = event.body || '';
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    console.error('[calendly-webhook] Invalid JSON in body');
    return json({ error: 'Invalid JSON' }, 400);
  }

  // ─── Structural validation ─────────────────────────────────────────
  const validationErrors = validatePayload(payload);
  if (validationErrors.length > 0) {
    console.error('[calendly-webhook] Payload validation failed:', validationErrors);
    console.error('[calendly-webhook] Rejected payload (first 500 chars):', rawBody.slice(0, 500));
    return json({ error: 'Invalid payload structure', details: validationErrors }, 400);
  }

  const eventType = payload.event;
  const data      = payload.payload;

  console.log(`[calendly-webhook] Event: ${eventType} | invitee: ${data.email || 'unknown'} | event_uri: ${(data.scheduled_event && data.scheduled_event.uri) || 'n/a'}`);

  if (eventType === 'invitee.canceled') {
    return await handleCanceled(data, SUPA_URL, SUPA_KEY);
  }

  if (eventType === 'invitee.created') {
    return await handleCreated(data);
  }

  return json({ ok: true, ignored: eventType });
};

// ─── HANDLER: invitee.created → create lead ──────────────────────────
async function handleCreated(data) {
  const eventDetails = data.scheduled_event || {};
  const eventTypeUri = eventDetails.event_type || '';
  const eventTypeId  = String(eventTypeUri).split('/').pop();

  // Match against Discovery Call (by UUID or slug)
  if (!matchesEventType(eventTypeUri, DISCOVERY_CALL_UUIDS, DISCOVERY_CALL_SLUGS)) {
    if (matchesEventType(eventTypeUri, ONBOARDING_UUIDS, ONBOARDING_SLUGS)) {
      console.log('[calendly-webhook] Skipping Client Onboarding (existing client)');
      return json({ ok: true, skipped: 'client_onboarding' });
    }
    if (matchesEventType(eventTypeUri, OPS_REVIEW_UUIDS, OPS_REVIEW_SLUGS)) {
      console.log('[calendly-webhook] Skipping Ops Review (existing client)');
      return json({ ok: true, skipped: 'ops_review' });
    }
    console.log(`[calendly-webhook] Unknown event type identifier: ${eventTypeId}`);
    return json({ ok: true, skipped: 'unknown_event_type', identifier: eventTypeId });
  }

  // Extract invitee data
  const name  = data.name || '';
  const email = (data.email || '').toLowerCase();
  const phone = data.text_reminder_number || '';

  const questions = data.questions_and_answers || [];
  const businessDesc    = findAnswer(questions, 'tell us a little about your business');
  const countryAnswer   = findAnswer(questions, 'country');
  const volumeAnswer    = findAnswer(questions, 'volumen') || findAnswer(questions, 'monthly order volume');
  const channelsAnswer  = findAnswer(questions, 'canales de venta') || findAnswer(questions, 'sales channels');
  const challengeAnswer = findAnswer(questions, 'reto operativo') || findAnswer(questions, 'challenge');
  const urlAnswer       = findAnswer(questions, 'website') || findAnswer(questions, 'amazon storefront');

  const countryISO = COUNTRY_MAP[countryAnswer] || (countryAnswer ? 'OTHER' : null);
  const language   = detectLanguage(countryISO, businessDesc);
  const service    = mapServiceFromChannels(channelsAnswer);

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
    phone: phone || email,
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

  if (!phone) {
    console.warn(`[calendly-webhook] No phone for ${email}, using email as phone fallback`);
  }

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

    if (lead.status === 'won') {
      console.log(`[calendly-webhook] Lead ${lead.id} is already 'won', not changing status`);
      return json({ ok: true, skipped: 'lead_already_won' });
    }

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
