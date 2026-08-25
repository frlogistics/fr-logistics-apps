// netlify/functions/slip-extract.js
// FR-Logistics · reads the Amazon packing slip out of the photo the warehouse
// already takes, so nobody has to type FNSKU / quantity / RA# by hand.
//
// Called fire-and-forget by fr-mobile.html right after shipment-photos-proxy
// returns. The operator never waits for it: the photo and the inbound row are
// already saved by then, so if this fails nothing is lost — the result simply
// falls back to what we had before (a photo and no structured data).
//
// POST { tracking, photo_url }            (photo_url must live in our bucket)
// →    { ok, status, summary, extraction_id }
//
// Design rules:
//   1. NEVER writes to shipments_general. That table drives billing; this is a
//      satellite table joined by shipment_id.
//   2. NEVER guesses. A field the model cannot read comes back null, and a
//      low-confidence read is parked as 'low_confidence' for internal review
//      instead of being shown to the client. Showing a client the wrong FNSKU
//      is worse than showing nothing.
//   3. Idempotent: photo_url is unique, so a retry of the same photo updates
//      the same row instead of creating a second one.
//
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY (already set) and the Anthropic
// key. It accepts either ANTHROPIC_API_KEY or CLAUDE_API_KEY so it works with
// whichever name the project already uses — no new variable needed if one of
// those exists (that project is near the 4 KB env-var ceiling).

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const AI_KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;

// Overridable without touching code. Haiku is the cheaper swap if the slips
// keep reading cleanly; Sonnet is the safer default for angled phone photos.
const MODEL = process.env.SLIP_EXTRACT_MODEL || 'claude-sonnet-5';

// Amazon product titles run past 200 characters, and a slip with several lines
// blew past a 1000-token budget mid-array — the response came back as truncated
// JSON and the whole reading was lost. Give it real headroom and also cap the
// titles in the prompt: both together, because either one alone can fail.
const MAX_TOKENS = 3000;

// Below this we do not publish the reading to the client.
const MIN_CONFIDENCE = 0.75;

// Only accept images that live in our own storage — never fetch an arbitrary
// URL somebody posts to this endpoint.
const ALLOWED_PHOTO_PREFIX = `${SB_URL}/storage/v1/object/public/shipment-photos/`;

const SB_HEADERS = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

async function sb(path, init = {}) {
  return fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { ...SB_HEADERS, ...(init.headers || {}) } });
}

const PROMPT = `You are reading a packing slip that arrived attached to a parcel at a 3PL warehouse. It is normally an Amazon document (vendor return, removal order, or customer return), photographed with a phone, possibly at an angle or slightly creased.

Return ONLY a JSON object, no markdown fences and no commentary, with exactly these keys:

{
  "is_slip": true/false,
  "doc_type": "amazon_vendor_return" | "amazon_removal" | "amazon_customer_return" | "other" | null,
  "ra_number": string|null,
  "vret_id": string|null,
  "amz_shipment_id": string|null,
  "origin_fc": string|null,
  "process_date": "YYYY-MM-DD"|null,
  "lpn": string|null,
  "items": [ { "fnsku": string|null, "asin": string|null, "upc": string|null, "lpn": string|null, "qty": number|null, "title": string|null } ],
  "confidence": number
}

Rules:
- If the image is not a packing slip (a plain box, a shipping label only, a blurred photo), set is_slip false, items to an empty array, and confidence to your certainty about THAT judgement.
- Transcribe characters exactly as printed. Do not correct, expand or invent anything.
- A code printed under a column labelled ASIN that starts with X00 is an FNSKU, not an ASIN: put it in "fnsku".
- ASINs are 10 characters and normally start with B0. Only fill "asin" when the code really looks like one.
- "origin_fc" is the Amazon fulfillment center code, usually visible inside the RA number or next to the origin address (for example ABQ1).
- If a field is unreadable or absent, use null. Never guess to fill a gap.
- "title" must be at most 80 characters: take the beginning of the printed product name and stop there. Do not transcribe the full marketing title.
- "confidence" is 0 to 1 and reflects how sure you are of the fields you DID fill.
- Multiple line items means multiple entries in "items".
- "lpn" is Amazon's license plate number for a returned unit, printed on a sticker and usually starting with LPN. Customer returns carry one; removals and vendor returns normally do not. Put it at the top level when the document has a single one, and inside the item when each line has its own.`;

function buildSummary(items, topLpn) {
  const parts = (items || [])
    .map((it) => {
      // A customer return often has no FNSKU at all: the LPN sticker is the
      // only usable identifier, and it is what resolves the unit in the FBA
      // Customer Returns report. Fall back to it rather than returning nothing.
      const code = it.fnsku || it.asin || it.upc || it.lpn || topLpn;
      if (!code) return null;
      // Number(null) is 0 and 0 is finite — check for an actual value first,
      // otherwise a missing quantity would print as "(0)".
      const hasQty = it.qty !== null && it.qty !== undefined && it.qty !== '';
      const qty = hasQty && Number.isFinite(Number(it.qty)) ? Number(it.qty) : null;
      return qty !== null ? `${code} (${qty})` : String(code);
    })
    .filter(Boolean);
  return parts.length ? parts.join(' · ') : '';
}

// The RA number carries the fulfillment center as its second-to-last segment
// (QB8G6-260814YX3-IGQ1-1 -> IGQ1). The model often leaves origin_fc null even
// when the RA is right there, so derive it rather than asking for it twice.
function fcFromRa(ra) {
  const parts = String(ra || '').split('-').filter(Boolean);
  if (parts.length < 2) return null;
  const candidate = parts[parts.length - 2].toUpperCase();
  return /^[A-Z]{3,4}\d{1,2}$/.test(candidate) ? candidate : null;
}

function parseModelJson(text) {
  const cleaned = String(text || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  // Be forgiving about a stray sentence around the object.
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('model did not return JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!SB_URL || !SB_KEY) return json(500, { error: 'Supabase not configured' });
  if (!AI_KEY) {
    return json(500, {
      error: 'Missing API key — set ANTHROPIC_API_KEY (or CLAUDE_API_KEY) in Netlify',
    });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const tracking = String(body.tracking || '').trim();
  const photoUrl = String(body.photo_url || '').trim();
  if (!tracking || !photoUrl) return json(400, { error: 'tracking and photo_url are required' });
  if (!photoUrl.startsWith(ALLOWED_PHOTO_PREFIX)) {
    return json(400, { error: 'photo_url is not a shipment photo of ours' });
  }

  let extractionId = null;

  try {
    // 1. Resolve the shipment row. `tracking` has a unique index, so this is 1:1.
    const shipRes = await sb(
      `shipments_general?tracking=eq.${encodeURIComponent(tracking)}&select=id,type,client_id&limit=1`
    );
    const shipRows = await shipRes.json();
    const shipment = Array.isArray(shipRows) && shipRows.length ? shipRows[0] : null;

    // 2. Park a pending row FIRST, so a crash further down still leaves a trace.
    //    on_conflict=photo_url + merge-duplicates makes a retry update in place.
    const seedRes = await sb('wh_slip_extractions?on_conflict=photo_url', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify([
        {
          shipment_id: shipment ? shipment.id : null,
          tracking,
          photo_url: photoUrl,
          status: 'pending',
          model: MODEL,
          error: null,
        },
      ]),
    });
    const seedRows = await seedRes.json();
    if (Array.isArray(seedRows) && seedRows.length) extractionId = seedRows[0].id;

    // 3. Pull the image we just stored and hand it to the model.
    const imgRes = await fetch(photoUrl);
    if (!imgRes.ok) throw new Error(`photo fetch ${imgRes.status}`);
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const b64 = Buffer.from(await imgRes.arrayBuffer()).toString('base64');

    // One retry on a malformed reply. The failure we actually saw in production
    // was truncated JSON, so the retry leans harder on brevity rather than
    // repeating the identical request and hoping.
    async function askModel(extraInstruction) {
      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': AI_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: contentType, data: b64 } },
                { type: 'text', text: PROMPT + (extraInstruction || '') },
              ],
            },
          ],
        }),
      });
      if (!aiRes.ok) throw new Error(`anthropic ${aiRes.status}: ${(await aiRes.text()).slice(0, 300)}`);
      const aiJson = await aiRes.json();
      return (aiJson.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
    }

    let parsed;
    let attempts = 1;
    try {
      parsed = parseModelJson(await askModel());
    } catch (firstErr) {
      attempts = 2;
      parsed = parseModelJson(
        await askModel(
          '\n\nIMPORTANT: your previous reply was not valid JSON. Reply with the JSON object and nothing else. Omit "title" entirely if that is what it takes to keep the object complete and well formed.'
        )
      );
    }

    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const confidence = Number(parsed.confidence);
    const topLpn = parsed.lpn || null;
    const summary = buildSummary(items, topLpn);

    let status;
    if (parsed.is_slip === false) status = 'no_slip';
    else if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE || !summary) status = 'low_confidence';
    else status = 'ok';

    const patch = {
      status,
      doc_type: parsed.doc_type || null,
      ra_number: parsed.ra_number || null,
      vret_id: parsed.vret_id || null,
      amz_shipment_id: parsed.amz_shipment_id || null,
      origin_fc: parsed.origin_fc || fcFromRa(parsed.ra_number) || null,
      lpn: topLpn,
      process_date: /^\d{4}-\d{2}-\d{2}$/.test(parsed.process_date || '') ? parsed.process_date : null,
      items,
      summary: summary || null,
      confidence: Number.isFinite(confidence) ? confidence : null,
      model: MODEL,
      raw_response: { ...parsed, _attempts: attempts },
      error: null,
      completed_at: new Date().toISOString(),
    };

    await sb(`wh_slip_extractions?photo_url=eq.${encodeURIComponent(photoUrl)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });

    return json(200, { ok: true, status, summary: summary || null, extraction_id: extractionId });
  } catch (err) {
    const message = String((err && err.message) || err).slice(0, 500);
    // Best effort: leave the failure recorded so it can be retried or reviewed.
    try {
      await sb(`wh_slip_extractions?photo_url=eq.${encodeURIComponent(photoUrl)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'failed', error: message, completed_at: new Date().toISOString() }),
      });
    } catch {
      /* swallow: the caller never waits for us anyway */
    }
    return json(200, { ok: false, status: 'failed', error: message });
  }
};
