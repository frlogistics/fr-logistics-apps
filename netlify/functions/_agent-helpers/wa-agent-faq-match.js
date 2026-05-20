// netlify/functions/_agent-helpers/wa-agent-faq-match.js
//
// FAQ matcher — finds the best FAQ answer for a free-text user message
// using simple keyword scoring against the active fr_faqs catalog.
//
// Strategy:
//   1. Load all active FAQs from Supabase (lazy-cached per Lambda warm cycle)
//   2. Tokenize user text into normalized words
//   3. For each FAQ, count overlap with its keywords (es and en)
//   4. Return the highest-scoring FAQ above MIN_SCORE_THRESHOLD, or null
//
// Honest about limits: this is keyword matching, not semantic search.
// If a user phrases something with synonyms not in our keywords list,
// we'll miss it. That's a known gap that Sprint 4 (LLM layer) fixes.

import { createClient } from "@supabase/supabase-js";

// ─────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────

// Minimum number of keyword matches to consider a FAQ "hit"
// Set to 1 — single strong keyword is enough (e.g. "hazmat" → hazmat FAQ).
// We bias toward responding rather than escalating.
const MIN_SCORE_THRESHOLD = 1;

// Cache active FAQs for the warm Lambda lifecycle (~5-15 min between cold starts)
let _faqCache = null;
let _faqCacheLoadedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;  // 5 minutes

// ─────────────────────────────────────────────────────────────────────
// SUPABASE CLIENT
// ─────────────────────────────────────────────────────────────────────

let _sbClient = null;
function sb() {
  if (_sbClient) return _sbClient;
  _sbClient = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );
  return _sbClient;
}

// ─────────────────────────────────────────────────────────────────────
// LOAD FAQ CATALOG (cached)
// ─────────────────────────────────────────────────────────────────────

async function loadActiveFAQs() {
  const now = Date.now();
  if (_faqCache && (now - _faqCacheLoadedAt) < CACHE_TTL_MS) {
    return _faqCache;
  }

  const { data, error } = await sb()
    .from("fr_faqs")
    .select("id, category, question_es, question_en, answer_es, answer_en, keywords_es, keywords_en, priority")
    .eq("active", true)
    .order("priority", { ascending: false });

  if (error) {
    console.error("[faq-match] load error:", error.message);
    return _faqCache || [];  // fall back to stale cache if available
  }

  _faqCache = data || [];
  _faqCacheLoadedAt = now;
  console.log(`[faq-match] cache refreshed: ${_faqCache.length} active FAQs`);
  return _faqCache;
}

// ─────────────────────────────────────────────────────────────────────
// TEXT NORMALIZATION
// ─────────────────────────────────────────────────────────────────────

/**
 * Normalizes text for matching:
 *  - lowercase
 *  - strip accents (é → e, ñ → n)
 *  - replace punctuation with spaces
 *  - collapse whitespace
 */
function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")  // strip diacritics
    .replace(/[^a-z0-9\s]/g, " ")                       // punctuation → space
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tokenize into a set of unique words (≥2 chars)
 */
function tokenize(text) {
  const norm = normalize(text);
  if (!norm) return new Set();
  return new Set(norm.split(" ").filter(w => w.length >= 2));
}

/**
 * Tokenize a keywords field (comma-separated) into a set of normalized phrases.
 * Returns BOTH single tokens AND multi-word phrases for "shipping cost" matching.
 */
function parseKeywords(keywordStr) {
  if (!keywordStr) return { tokens: new Set(), phrases: [] };
  const items = String(keywordStr).split(",").map(s => s.trim()).filter(Boolean);
  const tokens = new Set();
  const phrases = [];
  for (const item of items) {
    const norm = normalize(item);
    if (!norm) continue;
    if (norm.includes(" ")) {
      phrases.push(norm);   // multi-word like "shipping cost"
    } else {
      tokens.add(norm);     // single word
    }
  }
  return { tokens, phrases };
}

// ─────────────────────────────────────────────────────────────────────
// SCORING
// ─────────────────────────────────────────────────────────────────────

/**
 * Scores a single FAQ against the user's text.
 * Score = number of keyword tokens or phrases found.
 * Phrases count as 2 (more specific signal than single words).
 * Priority is used as tiebreaker, not added to raw score.
 */
function scoreFAQ(faq, userText, userTokens, language) {
  const keywordStr = language === "es" ? faq.keywords_es : faq.keywords_en;
  if (!keywordStr) return 0;

  const { tokens: kwTokens, phrases: kwPhrases } = parseKeywords(keywordStr);
  const userTextNorm = normalize(userText);

  let score = 0;

  // Single-token matches
  for (const tok of kwTokens) {
    if (userTokens.has(tok)) score += 1;
  }

  // Multi-word phrase matches (weighted higher)
  for (const phrase of kwPhrases) {
    if (userTextNorm.includes(phrase)) score += 2;
  }

  return score;
}

// ─────────────────────────────────────────────────────────────────────
// MAIN MATCHER
// ─────────────────────────────────────────────────────────────────────

/**
 * Finds the best matching FAQ for a user message.
 * 
 * @param {string} text - User's message
 * @param {string} language - 'es' or 'en' (lowercase)
 * @returns {Promise<object|null>} The matched FAQ or null
 *   { id, category, question_*, answer_*, score, priority }
 */
export async function matchFAQ(text, language) {
  if (!text || text.trim().length < 3) return null;

  const lang = (language || "en").toLowerCase();
  const userTokens = tokenize(text);
  if (userTokens.size === 0) return null;

  const faqs = await loadActiveFAQs();
  if (!faqs.length) return null;

  // Score each FAQ
  const scored = faqs.map(faq => ({
    ...faq,
    score: scoreFAQ(faq, text, userTokens, lang),
  }));

  // Filter to those at or above threshold
  const candidates = scored.filter(f => f.score >= MIN_SCORE_THRESHOLD);
  if (!candidates.length) return null;

  // Sort by score DESC, then priority DESC
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.priority || 0) - (a.priority || 0);
  });

  const best = candidates[0];
  console.log(`[faq-match] hit: "${best.question_en}" score=${best.score} priority=${best.priority}`);
  return best;
}

/**
 * Returns the localized answer for a matched FAQ.
 * @param {object} faq - The FAQ row
 * @param {string} language - 'es' or 'en' lowercase, OR 'ES'/'EN' uppercase
 */
export function getFAQAnswer(faq, language) {
  const lang = (language || "en").toLowerCase();
  return lang === "es" ? faq.answer_es : faq.answer_en;
}

/**
 * Returns the localized question text (for logging/audit).
 */
export function getFAQQuestion(faq, language) {
  const lang = (language || "en").toLowerCase();
  return lang === "es" ? faq.question_es : faq.question_en;
}

/**
 * Manually invalidates the cache. Useful from admin tools when FAQs are edited.
 * Not exposed via HTTP yet — Sprint 5 will add a portal admin tab.
 */
export function invalidateFAQCache() {
  _faqCache = null;
  _faqCacheLoadedAt = 0;
}
