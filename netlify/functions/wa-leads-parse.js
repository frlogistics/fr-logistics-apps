// netlify/functions/wa-leads-parse.js
//
// Receives a pasted WhatsApp chat transcript and uses Claude API to extract
// structured lead data ready to fill the wa-lead-capture form.
//
// This function does NOT create a lead — it returns extracted JSON which
// the front-end uses to fill the form. The user reviews and clicks submit
// (which then calls wa-leads-create normally).
//
// Style matches FR-Logistics conventions:
//   - CommonJS exports.handler
//   - Direct fetch to Anthropic API (no SDK)
//   - Reads ANTHROPIC_API_KEY from env, fails loudly if missing

const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514'; // fast + cheap, plenty for extraction
const MAX_CHAT_LENGTH = 50000; // characters — ~10k tokens, plenty for any WhatsApp chat

const EXTRACTION_PROMPT = `You are a lead data extractor for FR-Logistics, an Amazon SPN-certified 3PL based in Doral, FL. You are reading a WhatsApp chat between a potential client (lead) and Liam (an AI Logistics Assistant or human responding as Liam).

Your job: extract structured lead data and return ONLY a JSON object. NO prose, NO markdown, NO explanation. Just the JSON.

The JSON must have this exact shape:

{
  "name": string | null,
  "email": string | null,
  "phone": string | null,
  "country": string | null,
  "language": "en" | "es",
  "service": "fba_prep" | "shopify_dtc" | "cross_dock_latam" | "ecopack_plus" | "hold_for_pickup" | "fnsku_relabel" | "freight_inbound" | "storage_only" | "other",
  "monthly_volume": string | null,
  "skus": string | null,
  "origin": string | null,
  "destination": string | null,
  "product_type": string | null,
  "conversation_summary": string,
  "notes": string | null,
  "confidence": "high" | "medium" | "low"
}

Rules for extraction:

1. NAME: Full name only. If only first name given, that's fine. If unsure, null.

2. EMAIL: Must be valid email format. If unsure, null.

3. PHONE: WhatsApp number with country code if available. Format: +1XXXXXXXXXX. If only digits without country code, prepend the most likely code based on country (Mexico=+52, Colombia=+57, Argentina=+54, USA=+1, Brazil=+55, Peru=+51, Chile=+56). If unsure, null.

4. COUNTRY: ISO 3166-1 alpha-2 code (MX, CO, AR, US, BR, PE, CL, etc.). If unsure, null.

5. LANGUAGE: Detect from how the LEAD writes (not Liam). Spanish messages → "es". English → "en". Default "en" if unclear.

6. SERVICE: Match the lead's interest to ONE of the enum values:
   - "fba_prep" — Amazon FBA prep, FNSKU, polybag, labeling, prep center, Amazon shipments
   - "shopify_dtc" — Shopify, DTC, FBM, eBay, Walmart marketplace fulfillment
   - "cross_dock_latam" — LATAM imports, cross-docking, master case from Mexico/Colombia/etc to US
   - "ecopack_plus" — Package consolidation for LATAM buyers, casillero
   - "hold_for_pickup" — Receive and hold for customer pickup
   - "fnsku_relabel" — Relabeling FNSKU, removal orders
   - "freight_inbound" — China freight, container, ocean shipping, air freight
   - "storage_only" — Storage/warehousing without fulfillment
   - "other" — When none clearly match
   If multiple services mentioned, pick the PRIMARY one. If unclear, "other".

7. MONTHLY_VOLUME: Quoted exactly as the lead said it. "500 units/mo", "2000 orders weekly", "~3 pallets/month". If not mentioned, null.

8. SKUS: SKU count or approximation. "12 SKUs", "around 50". If not mentioned, null.

9. ORIGIN: Where their inventory comes from. "China", "Argentina", "Mexico". If not mentioned, null.

10. DESTINATION: Where shipments go. "Amazon FBA", "DTC customers", "MercadoLibre". If not mentioned, null.

11. PRODUCT_TYPE: Brief category. "skincare", "supplements", "electronics", "general", "fragile". If not mentioned, null.

12. CONVERSATION_SUMMARY: 2-4 sentence summary in ENGLISH (regardless of chat language) covering:
    - What the lead wants
    - Their key constraints or pain points
    - Any specific requests, deadlines, or objections
    Keep it factual, no marketing fluff.

13. NOTES: Internal observations the sales team should know but the lead shouldn't see. Examples: "Lead seemed price-sensitive", "Asked about competitors", "Has urgent timeline", "Existing 3PL is XYZ — wants to switch". Null if nothing notable.

14. CONFIDENCE:
    - "high" — most fields confidently extracted, clear conversation
    - "medium" — some ambiguity, sales should verify before sending quote
    - "low" — sparse data, mostly null fields, lead barely engaged

Return ONLY the JSON. No backticks. No "Here is the JSON:". Just { ... }.`;

function json(body, statusCode = 200) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) {
    console.error('[wa-leads-parse] Missing ANTHROPIC_API_KEY');
    return json({ error: 'Server misconfigured: ANTHROPIC_API_KEY missing' }, 500);
  }

  // Parse body
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const chat = String(body.chat || '').trim();
  if (!chat) {
    return json({ error: 'Field "chat" is required' }, 400);
  }
  if (chat.length > MAX_CHAT_LENGTH) {
    return json({
      error: `Chat too long (${chat.length} chars). Max allowed: ${MAX_CHAT_LENGTH}.`,
    }, 400);
  }

  // ─── Call Anthropic API ─────────────────────────────────────────────
  let parsed;
  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1500,
        system: EXTRACTION_PROMPT,
        messages: [
          {
            role: 'user',
            content: `<whatsapp_chat>\n${chat}\n</whatsapp_chat>\n\nExtract the lead data as JSON.`,
          },
        ],
      }),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error('[wa-leads-parse] Anthropic API error:', apiRes.status, errText);
      return json({
        error: 'AI extraction failed',
        details: `API returned ${apiRes.status}: ${errText.slice(0, 500)}`,
      }, 502);
    }

    const apiData = await apiRes.json();

    // Extract text from response content blocks
    const textBlocks = (apiData.content || []).filter(b => b.type === 'text');
    if (textBlocks.length === 0) {
      console.error('[wa-leads-parse] No text in response:', apiData);
      return json({ error: 'AI returned no text content' }, 502);
    }

    let rawText = textBlocks.map(b => b.text).join('').trim();

    // Strip markdown fences if AI ignored instructions
    rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      console.error('[wa-leads-parse] Could not parse AI JSON:', rawText.slice(0, 500));
      return json({
        error: 'AI returned invalid JSON',
        raw_response: rawText.slice(0, 500),
      }, 502);
    }
  } catch (e) {
    console.error('[wa-leads-parse] Exception:', e.message);
    return json({ error: 'Internal error', details: e.message }, 500);
  }

  // ─── Sanitize fields ────────────────────────────────────────────────
  const result = {
    name:                  parsed.name || '',
    email:                 parsed.email || '',
    phone:                 parsed.phone || '',
    country:               parsed.country || '',
    language:              parsed.language === 'es' ? 'es' : 'en',
    service:               parsed.service || 'other',
    monthly_volume:        parsed.monthly_volume || '',
    skus:                  parsed.skus || '',
    origin:                parsed.origin || '',
    destination:           parsed.destination || '',
    product_type:          parsed.product_type || '',
    conversation_summary:  parsed.conversation_summary || '',
    notes:                 parsed.notes || '',
    confidence:            parsed.confidence || 'medium',
  };

  console.log(`[wa-leads-parse] Extracted lead: ${result.name || '?'} · ${result.email || '?'} · ${result.service} · confidence=${result.confidence}`);

  return json(result);
};
