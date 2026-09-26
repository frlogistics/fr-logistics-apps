// netlify/functions/calendly-webhook.js
//
// Receives webhook events from Calendly and creates corresponding wa_leads
// entries via wa-leads-create.
//
// 2026-09-26 v3: (1) invitee.created no longer duplicates people: if a lead
//                with that email already exists, the meeting is added to it
//                (same rule as calendly-sync) instead of creating a second
//                lead. (2) invitee.canceled ignores reschedules
//                (payload.rescheduled === true) — Calendly sends a cancel for
//                the old slot plus a create for the new one, and the old code
//                marked the lead "lost" on every reschedule. Real cancellations
//                now APPEND to notes instead of overwriting them.
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

const crypto = require('crypto');

// ─── SIGNATURE VERIFICATION ─────────────────────────────────────────
// Calendly signs with the same scheme Stripe uses:
//   Calendly-Webhook-Signature: t=<unix seconds>,v1=<hex hmac-sha256>
// where the signed string is `${t}.${rawBody}` and the key is the signing
// key handed out when the webhook subscription is created.
//
// MODE — read this before changing it.
// 'observe'  verify, log the verdict, process the request either way.
// 'enforce'  reject anything that fails verification with 401.
//
// It ships as 'observe' ON PURPOSE. This file used to do HMAC and somebody
// replaced it with structural checks; the overwhelmingly likely reason is that
// it began rejecting real bookings. Flipping straight to 'enforce' would risk
// repeating that, and a lead pipeline that silently stops is a worse failure
// than the one we are closing.
//
// TO GO LIVE: watch the function logs for a few real bookings. Every one
// should print `[calendly-webhook] signature ok`. Once you have seen that
// happen for genuine traffic, change this to 'enforce' and redeploy.
const SIGNATURE_MODE = 'enforce';  // 26-sep-2026: verified live — 'signature ok (key=app_secrets len=64 fp=e02bf521)'

// Where the signing key lives (v3, 26-sep-2026): public.app_secrets row
// 'calendly_signing_key' (RLS on, service key only) — so it can be checked and
// rotated without touching Netlify's 4 KB env budget. CALENDLY_WEBHOOK_SECRET
// is only a fallback. Cached per warm instance for 5 minutes.
let _keyCache = { value: null, source: null, at: 0 };
async function getSigningKey() {
  if (_keyCache.value !== null && Date.now() - _keyCache.at < 5 * 60 * 1000) return _keyCache;
  let value = '', source = 'none';
  try {
    const rows = await sbFetch('app_secrets?select=value&name=eq.calendly_signing_key&limit=1');
    const v = rows && rows[0] && String(rows[0].value || '').trim();
    if (v) { value = v; source = 'app_secrets'; }
  } catch (e) {
    console.warn('[calendly-webhook] could not read app_secrets:', e.message);
  }
  if (!value && process.env.CALENDLY_WEBHOOK_SECRET) {
    value = String(process.env.CALENDLY_WEBHOOK_SECRET).trim();
    source = 'env';
  }
  _keyCache = { value, source, at: Date.now() };
  return _keyCache;
}

// Short, non-reversible fingerprint of the key so logs can prove WHICH key
// was used without printing it: first 8 hex chars of sha256(key).
const fingerprint = (k) => crypto.createHash('sha256').update(k, 'utf8').digest('hex').slice(0, 8);

// Replay window. A signature stays valid forever without this: an attacker who
// captures one legitimate request can resend it indefinitely.
const MAX_SIGNATURE_AGE_S = 300;

function parseSignatureHeader(headers) {
  // Header names arrive lowercased on Netlify, but not on every runtime.
  const raw = headers['calendly-webhook-signature']
           || headers['Calendly-Webhook-Signature']
           || '';
  if (!raw) return null;
  const out = {};
  for (const part of String(raw).split(',')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return (out.t && out.v1) ? { t: out.t, v1: out.v1 } : null;
}

function verifyCalendlySignature(rawBody, headers, CALENDLY_SIGNING_KEY) {
  if (!CALENDLY_SIGNING_KEY) {
    return { ok: false, reason: 'signing key not set (app_secrets.calendly_signing_key / CALENDLY_WEBHOOK_SECRET)' };
  }
  const parsed = parseSignatureHeader(headers || {});
  if (!parsed) return { ok: false, reason: 'signature header missing or malformed' };

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(parsed.t));
  if (!Number.isFinite(age)) return { ok: false, reason: 'timestamp not a number' };
  if (age > MAX_SIGNATURE_AGE_S) {
    return { ok: false, reason: `timestamp ${age}s old (max ${MAX_SIGNATURE_AGE_S}s)` };
  }

  const expected = crypto
    .createHmac('sha256', CALENDLY_SIGNING_KEY)
    .update(`${parsed.t}.${rawBody}`, 'utf8')
    .digest('hex');

  // Constant-time compare. A plain === leaks, through response timing, how
  // many leading characters of a guess were right.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(parsed.v1, 'utf8');
  if (a.length !== b.length) return { ok: false, reason: 'signature length mismatch' };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'signature mismatch' };

  return { ok: true };
}

// ─── HELPER: Supabase REST with the service key ─────────────────────
async function sbFetch(path, init = {}) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

// Same ledger calendly-sync uses, so the hourly sync never re-processes an
// event the webhook already handled. Failure here is logged, never fatal.
async function markSeen(eventDetails, action, leadId, email) {
  if (!eventDetails || !eventDetails.uri) return;
  try {
    await sbFetch('calendly_seen_events?on_conflict=event_uri', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        event_uri:  eventDetails.uri,
        lead_id:    leadId || null,
        action,
        email:      email || null,
        start_time: eventDetails.start_time || null,
        status:     eventDetails.status || null,
      }),
    });
  } catch (e) {
    console.warn('[calendly-webhook] markSeen failed:', e.message);
  }
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

  // ─── Signature check ───────────────────────────────────────────────
  // Runs on the RAW body, before JSON.parse. Parsing and re-serialising
  // changes whitespace and key order, and the digest stops matching — that is
  // the single most common reason signature checks "mysteriously" fail.
  // Lambda-compat can hand the body over base64-encoded; Calendly signed the
  // decoded JSON text, so decode before hashing.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');
  const key = await getSigningKey();
  const sig = verifyCalendlySignature(rawBody, event.headers, key.value);
  // Diagnostics that reveal nothing secret: which key source, its length and
  // fingerprint, and the body facts that most often break HMACs.
  const diag = `key=${key.source} len=${key.value.length} fp=${key.value ? fingerprint(key.value) : '-'} ` +
               `body=${rawBody.length}B b64=${!!event.isBase64Encoded}`;

  if (sig.ok) {
    console.log(`[calendly-webhook] signature ok (${diag})`);
  } else if (SIGNATURE_MODE === 'enforce') {
    console.error(`[calendly-webhook] REJECTED — signature: ${sig.reason} (${diag})`);
    return json({ error: 'Invalid signature' }, 401);
  } else {
    // Observe mode. Loud on purpose: this line is what tells you whether it is
    // safe to switch to 'enforce'.
    console.warn(`[calendly-webhook] SIGNATURE FAILED (observe mode, request still processed): ${sig.reason} (${diag})`);
  }

  // ─── Parse payload ─────────────────────────────────────────────────
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
    // v3: no more "email as phone" (it produced numbers like "76" from
    // jhfr76iphone@…, and nothing at all for emails without digits, which
    // made wa-leads-create reject — and lose — the booking). wa-leads-create
    // v2 accepts an empty phone for Calendly leads.
    phone: phone || '',
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

  // ── Same person already in wa_leads? Add the meeting to that lead. ──
  // Reschedules and returning prospects used to create a second lead.
  if (email) {
    try {
      const existing = await sbFetch(
        // ilike = case-insensitive; escape _ and % so they match literally.
        `wa_leads?select=id,name,meeting_start_time&email=ilike.${encodeURIComponent(email.replace(/[\\%_]/g, '\\$&'))}&order=created_at.asc&limit=1`
      );
      const lead = Array.isArray(existing) && existing[0];
      if (lead) {
        const newer = !lead.meeting_start_time || String(meetingStart) > String(lead.meeting_start_time);
        if (newer) {
          await sbFetch(`wa_leads?id=eq.${lead.id}`, {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({
              meeting_url:             meetingURL || null,
              meeting_start_time:      meetingStart,
              meeting_end_time:        meetingEnd,
              calendly_event_uri:      eventDetails.uri || null,
              calendly_invitee_uri:    data.uri || null,
              calendly_custom_answers: questions,
              updated_at:              new Date().toISOString(),
            }),
          });
        }
        await markSeen(eventDetails, newer ? 'merged' : 'skipped', lead.id, email);
        console.log(`[calendly-webhook] Existing lead ${lead.id} (${lead.name}) — meeting ${newer ? 'added' : 'older, ignored'}`);
        return json({ ok: true, lead_id: lead.id, action: newer ? 'merged_into_existing_lead' : 'skipped_older_meeting' });
      }
    } catch (e) {
      // If the lookup fails we fall through and create the lead: a possible
      // duplicate is better than a lost booking.
      console.warn('[calendly-webhook] existing-lead lookup failed, creating new lead:', e.message);
    }
  }

  if (!phone) {
    console.log(`[calendly-webhook] No phone for ${email} (Calendly only sends it if SMS reminders were requested)`);
  }

  const siteHost = process.env.URL || process.env.DEPLOY_URL || 'https://apps.fr-logistics.net';
  const createUrl = `${siteHost}/.netlify/functions/wa-leads-create`;

  try {
    const res = await fetch(createUrl, {
      method: 'POST',
      // Internal call: auth-gate.js lets it through with the service key.
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY || ''}` },
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

  // A reschedule arrives as cancel(old slot) + create(new slot). The create
  // updates the lead; the cancel must not mark it lost.
  if (data.rescheduled === true) {
    console.log(`[calendly-webhook] Reschedule of ${eventUri} — lead left as is (new slot comes as invitee.created)`);
    await markSeen(data.scheduled_event || { uri: eventUri }, 'skipped', null, data.email);
    return json({ ok: true, skipped: 'rescheduled' });
  }

  try {
    const findRes = await fetch(
      `${SUPA_URL}/rest/v1/wa_leads?calendly_event_uri=eq.${encodeURIComponent(eventUri)}&select=id,status,name,notes`,
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
        // Append, never overwrite: notes carry the lead's history.
        notes:  lead.notes ? `${lead.notes} | ${cancelReason}` : cancelReason,
      }),
    });

    console.log(`[calendly-webhook] Marked lead ${lead.id} (${lead.name}) as lost`);
    return json({ ok: true, lead_id: lead.id, action: 'marked_lost' });
  } catch (e) {
    console.error('[calendly-webhook] Cancel handler exception:', e.message);
    return json({ error: 'Cancel handler failed', details: e.message }, 500);
  }
}
