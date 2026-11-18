// netlify/functions/dropship-pack-suggest-background.js
// FR-Logistics · DropShipments — works out which packaging each order should
// leave in ("CAJA 3", "POLY 2"…), so the operator sees it when the package is
// scanned.
//
// Background function (the "-background" suffix): Netlify answers 202 at once
// and lets this run up to 15 minutes. A product lookup with web search takes
// 10–40 s, far too slow for the 2-hourly sync or for a click in the app.
//
// POST {}                    → every open order that has no suggestion yet
// POST { ids: [uuid, …] }    → only those orders (the "↻" button in the app)
// POST { limit: n }          → cap for the no-ids run (default 12, max 30)
//
// Who calls it:
//   * dropship-gmail-sync.js, at the end of every run (internal Bearer).
//   * dropshipments.html, when the operator asks for a new suggestion.
//
// How one order is resolved (the decisions live in Supabase, see
// db/migrations/20261118_ds_packaging_and_void.sql — testable with plain SQL):
//   1. ds_pack_from_memory(id)   FR's own product memory. If this description
//      was packed before, the packaging the operator confirmed wins. If we
//      already hold dimensions for it, the box is computed from them.
//   2. Only when memory has nothing: ask the model, with web search, for the
//      retail package dimensions, weight and fragility of the product in the
//      order's free-text description.
//   3. ds_pack_save_lookup(id, json) stores the dimensions in the memory and
//      picks the smallest packaging that fits, honouring the client's tier
//      (vip = always a box; standard = polymailer when the product allows).
//
// Design rules:
//   * Run by FR. Never depends on data the client must send (decision of Jose,
//     17-nov-2026): the only input is dropshipments.content.
//   * NEVER guesses silently. Low confidence or no dimensions → pack_status
//     'measure' and the app shows "MEDIR"; an API failure → 'failed' with the
//     reason in pack_info.error, and the order can be re-queued from the app.
//   * The suggestion is advice. What bills and what teaches the memory is the
//     packaging the operator confirms (ds_confirm_pack).
//   * Idempotent: re-running an order overwrites its own suggestion only.
//
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY (or
// CLAUDE_API_KEY) — all already set. Optional PACK_SUGGEST_MODEL. No new
// variables are required (the site is at the 4 KB env-var ceiling).

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const AI_KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;

// First entry is what the rest of the site already runs on. The others are
// only tried when the API answers that the model name does not exist.
const MODELS = [
  process.env.PACK_SUGGEST_MODEL || process.env.SLIP_EXTRACT_MODEL || 'claude-sonnet-5',
  'claude-sonnet-5-5',
  'claude-haiku-4-5-20251001',
].filter((m, i, a) => m && a.indexOf(m) === i);

const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 3 };
const MAX_TOKENS = 1500;
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 30;
const TIME_BUDGET_MS = 12 * 60 * 1000;      // stop taking new orders after 12 min
const NO_WEB_CONFIDENCE_CAP = 0.65;         // answer from model knowledge only
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_STATUSES = ['pending', 'received', 'labeled', 'exception'];

const SB_HEADERS = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
};

async function sb(path, init = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { ...SB_HEADERS, ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`supabase ${path.split('?')[0]} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
const rpc = (fn, args) => sb(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });

// ── the question ────────────────────────────────────────────────────────────
function buildPrompt(content) {
  return `You help a fulfilment warehouse in Miami choose a shipping box.

A client bought a product from a US retailer (Amazon, Walmart, Target…) and had it delivered to the warehouse. The only thing we know about it is this free-text line, usually in Spanish:

"""${content}"""

Work out which exact retail product this is, then find the size of its RETAIL PACKAGE as sold (the box or bag the product comes in — "package dimensions" on the retailer listing or the manufacturer's page), not the size of the assembled product. Use web search when you are not certain of the dimensions.

Rules:
- Dimensions in inches and weight in pounds, for ONE unit.
- "units" is how many units the line asks for (e.g. "- 2 UNIDADES" → 2; default 1).
- fragile: glass, ceramics, electronics with exposed screens or pins, collectibles whose box must arrive mint.
- liquid: liquids, creams, gels, aerosols.
- poly_ok: true only if the product can safely travel in a padded plastic mailer with no box (soft goods, plush toys, clothing, sealed sturdy small boxes). False for anything rigid-but-crushable, fragile or liquid.
- confidence: 0 to 1. Use 0.8+ only when you found the package dimensions for this exact product. Use 0.6–0.8 when you identified the product and the dimensions come from a near-identical variant. Below 0.6 when you are estimating. If you cannot identify the product, set "identified" to false and leave the dimensions null.
- Never invent a number to fill a field. null is a valid answer.

Answer with ONE JSON object and nothing else:
{"identified": true, "title": "…", "brand": "…", "model": "…", "canonical": "brand + model/set number, lowercase", "units": 1, "l_in": 0, "w_in": 0, "h_in": 0, "weight_lb": 0, "fragile": false, "liquid": false, "poly_ok": false, "confidence": 0.0, "why": "one short sentence in Spanish for the warehouse operator explaining the size or the doubt", "sources": ["https://…"]}`;
}

function parseModelJson(text) {
  const t = String(text || '');
  // The answer is the LAST {...} block: with web search the model may think
  // out loud before it.
  let depth = 0, end = -1, start = -1;
  for (let i = t.length - 1; i >= 0; i--) {
    const ch = t[i];
    if (ch === '}') { if (depth === 0) end = i; depth++; }
    else if (ch === '{') { depth--; if (depth === 0 && end !== -1) { start = i; break; } }
  }
  if (start === -1) throw new Error('no JSON in model answer');
  return JSON.parse(t.slice(start, end + 1));
}

const isModelMissing = (status, body) =>
  status === 404 || (status === 400 && /model/i.test(body) && /(not[_ ]found|invalid|does not exist|unknown)/i.test(body));
const isSearchUnavailable = (status, body) =>
  status === 400 && /web[_ ]?search/i.test(body);

async function callMessages(model, messages, useSearch) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      ...(useSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
      messages,
    }),
  });
  const body = await res.text();
  if (!res.ok) {
    const e = new Error(`anthropic ${res.status}: ${body.slice(0, 300)}`);
    e.status = res.status; e.body = body;
    throw e;
  }
  return JSON.parse(body);
}

// One product lookup. Tries web search first; if the organisation has web
// search turned off, answers from the model's own knowledge with a capped
// confidence so the app shows it as an estimate.
async function lookupProduct(content) {
  const prompt = buildPrompt(content);
  let lastErr = null;

  for (const model of MODELS) {
    for (const useSearch of [true, false]) {
      try {
        let messages = [{ role: 'user', content: prompt }];
        let j = await callMessages(model, messages, useSearch);
        // A long search turn can be paused by the API: send the assistant
        // turn back unchanged to let it finish (max 2 continuations).
        for (let i = 0; i < 2 && j.stop_reason === 'pause_turn'; i++) {
          messages = [...messages, { role: 'assistant', content: j.content }];
          j = await callMessages(model, messages, useSearch);
        }
        const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        const out = parseModelJson(text);
        const searches = (j.content || []).filter((b) => b.type === 'server_tool_use').length;
        out._model = model;
        out._web_search = useSearch;
        out._searches = searches;
        if (!useSearch) {
          out.confidence = Math.min(Number(out.confidence) || 0, NO_WEB_CONFIDENCE_CAP);
          out.why = `${out.why || ''} (estimado sin búsqueda web)`.trim();
        }
        return out;
      } catch (e) {
        lastErr = e;
        if (isModelMissing(e.status, e.body || '')) break;                 // next model
        if (useSearch && isSearchUnavailable(e.status, e.body || '')) continue;  // same model, no search
        if (useSearch && !e.status) continue;                              // bad JSON: retry once without search
        throw e;
      }
    }
  }
  throw lastErr || new Error('no model available');
}

// Keep only what the database function expects, with sane types.
function shapeForDb(o) {
  const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const identified = o.identified !== false;
  return {
    identified,
    title: o.title ? String(o.title).slice(0, 200) : null,
    brand: o.brand ? String(o.brand).slice(0, 80) : null,
    model: o.model ? String(o.model).slice(0, 80) : null,
    canonical: o.canonical ? String(o.canonical).slice(0, 120) : null,
    units: Math.max(1, Math.min(50, Math.round(num(o.units) || 1))),
    l_in: identified ? num(o.l_in) : null,
    w_in: identified ? num(o.w_in) : null,
    h_in: identified ? num(o.h_in) : null,
    weight_lb: num(o.weight_lb),
    fragile: o.fragile === true,
    liquid: o.liquid === true,
    poly_ok: o.poly_ok === true,
    confidence: identified ? Math.max(0, Math.min(1, num(o.confidence) || 0)) : 0,
    why: o.why ? String(o.why).slice(0, 240) : null,
    sources: Array.isArray(o.sources) ? o.sources.filter((u) => typeof u === 'string').slice(0, 5) : [],
    model_used: o._model || null,
    web_search: o._web_search === true,
    searches: o._searches || 0,
  };
}

async function processOne(id) {
  const mem = await rpc('ds_pack_from_memory', { p_id: id });
  if (mem && mem.done) return { id, via: 'memory', ...mem };

  if (!AI_KEY) {
    await rpc('ds_pack_save_lookup', { p_id: id, p: { error: 'ANTHROPIC_API_KEY not configured' } });
    return { id, via: 'none', status: 'failed' };
  }

  try {
    const found = await lookupProduct(mem.content);
    const saved = await rpc('ds_pack_save_lookup', { p_id: id, p: shapeForDb(found) });
    return { id, via: 'lookup', ...saved };
  } catch (e) {
    console.error(`[pack-suggest] ${id}: ${e.message}`);
    await rpc('ds_pack_save_lookup', { p_id: id, p: { error: String(e.message || e) } }).catch(() => {});
    return { id, via: 'lookup', status: 'failed', error: String(e.message || e).slice(0, 200) };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, body: '' };
  if (!SB_URL || !SB_KEY) {
    console.error('[pack-suggest] Supabase not configured');
    return { statusCode: 500, body: 'Supabase not configured' };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}') || {}; } catch (e) { body = {}; }

  const started = Date.now();
  const results = [];
  try {
    let ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string' && UUID_RE.test(x)).slice(0, MAX_LIMIT) : [];

    if (!ids.length) {
      const limit = Math.max(1, Math.min(MAX_LIMIT, parseInt(body.limit, 10) || DEFAULT_LIMIT));
      // Claim the rows first (null → queued) so two runs that overlap never
      // pay for the same lookup twice. A row left in 'queued' by a run that
      // died is taken again after 20 minutes (updated_at moves on every write).
      const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString();
      const open = `or=(pack_status.is.null,and(pack_status.eq.queued,updated_at.lt.${stale}))`;
      const todo = await sb(
        `dropshipments?${open}&pack_used=is.null&status=in.(${OPEN_STATUSES.join(',')})&select=id&order=created_at.desc&limit=${limit}`
      );
      for (const r of todo || []) {
        const claimed = await sb(`dropshipments?id=eq.${r.id}&${open}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ pack_status: 'queued' }),
        });
        if (claimed && claimed.length) ids.push(r.id);
      }
    }

    for (const id of ids) {
      if (Date.now() - started > TIME_BUDGET_MS) {
        // Out of time: hand the rest back so the next run takes them.
        await sb(`dropshipments?id=eq.${id}&pack_status=eq.queued`, {
          method: 'PATCH', body: JSON.stringify({ pack_status: null }),
        }).catch(() => {});
        continue;
      }
      results.push(await processOne(id));
    }

    console.log(`[pack-suggest] ${results.length} order(s) in ${Math.round((Date.now() - started) / 1000)}s · ` +
      results.map((r) => `${r.status || '?'}${r.pack ? ':' + r.pack : ''}`).join(', '));
    return { statusCode: 200, body: JSON.stringify({ ok: true, results }) };
  } catch (e) {
    console.error('[pack-suggest] fatal:', e.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message, results }) };
  }
};

// Exposed for tests only.
exports._test = { parseModelJson, shapeForDb, buildPrompt, isModelMissing, isSearchUnavailable };
