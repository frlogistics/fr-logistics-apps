// netlify/functions/_agent-helpers/wa-agent-capture.js
//
// Parsing utilities for the handoff capture flow (name + email).
// Pure functions, no side effects. Tested.
//
// 2026-08-29 — FIX: whole paragraphs were landing in wa_leads.name.
//   extractBoth() used to take "everything left after removing the email"
//   as the name, and looksLikeName() had no length or word-count limit, so
//   a 180-character message passed straight through. extractBoth() now
//   SEARCHES for the name with labelled patterns ("my name is X", "soy X")
//   anywhere in the message, and only falls back to the leftover text when
//   that leftover is already short enough to be a name.

// ─────────────────────────────────────────────────────────────────────
// EMAIL DETECTION & VALIDATION
// ─────────────────────────────────────────────────────────────────────

// RFC 5322 simplified — good enough for our purposes
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
// Less strict — used to *detect* email anywhere in a message
const EMAIL_DETECT_REGEX = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/;

/**
 * Returns the first valid-looking email found in the text, or null.
 */
export function extractEmail(text) {
  const match = (text || "").match(EMAIL_DETECT_REGEX);
  return match ? match[0].toLowerCase() : null;
}

/**
 * Validates that a string is a proper email.
 */
export function isValidEmail(email) {
  return EMAIL_REGEX.test((email || "").trim());
}

// ─────────────────────────────────────────────────────────────────────
// NAME DETECTION & VALIDATION
// ─────────────────────────────────────────────────────────────────────

export const MAX_NAME_LEN = 40;
export const MAX_NAME_WORDS = 4;

// Words that never appear inside a person's name. If one shows up we are
// looking at a sentence, not a name.
const SENTENCE_WORDS = /\b(hola|hello|hi|hey|buenos|buenas|gracias|thanks?|thank|please|favor|quiero|necesito|need|want|looking|busco|buscando|servicio|service|cotiza|cotizacion|quote|precio|price|empresa|company|amazon|shopify|whatsapp|email|correo|informacion|information|consulta|question|would|could|should|puede|puedo|somos|tenemos|estoy|estamos|disabled|boss|expecting)\b/i;

/**
 * Heuristic to decide whether a string is a plausible PERSON NAME.
 *   - Between 2 and MAX_NAME_LEN characters
 *   - At most MAX_NAME_WORDS words
 *   - No line breaks, @ signs or sentence punctuation
 *   - No digit runs
 *   - Not a menu reply, a yes/no, or a sentence
 */
export function looksLikeName(text) {
  const t = (text || "").trim();
  if (t.length < 2 || t.length > MAX_NAME_LEN) return false;
  if (t.includes("@")) return false;
  if (/[\n\r]/.test(t)) return false;
  if (/[?!¿¡*_/\\<>()[\]{}]/.test(t)) return false;  // sentence / markup punctuation
  if (/\d{2,}/.test(t)) return false;                // phone numbers, years
  if (/^[1-5][.\s]?$/.test(t)) return false;         // menu reply
  if (/^(yes|no|si|s\u00ed|ok|cancel|cancelar|nope)$/i.test(t)) return false;
  if (SENTENCE_WORDS.test(deaccent(t))) return false;
  // A name is letters, spaces, apostrophes, hyphens and dots only.
  if (!/^[\p{L}][\p{L}\s'\u2019.\-]*$/u.test(t)) return false;
  return t.split(/\s+/).filter(Boolean).length <= MAX_NAME_WORDS;
}

// Strips accents so the sentence-word list matches "informacion" and
// "información" alike.
function deaccent(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Cleans a captured name: trims, removes excess whitespace, capitalizes
 * (without being aggressive — preserve user's casing if it looks intentional).
 */
export function cleanName(text) {
  let t = (text || "").trim().replace(/\s+/g, " ").replace(/[,;.]+$/, "").trim();
  // If user typed in all lowercase or all uppercase, do Title Case.
  // If they used mixed case, respect it.
  const isAllLower = t === t.toLowerCase();
  const isAllUpper = t === t.toUpperCase();
  if (isAllLower || isAllUpper) {
    t = t.toLowerCase().split(" ").map(
      (w) => w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w
    ).join(" ");
  }
  return t;
}

// ─────────────────────────────────────────────────────────────────────
// CANCEL / SKIP DETECTION
// ─────────────────────────────────────────────────────────────────────

const CANCEL_PATTERNS = [
  /\bno\s+(quiero|deseo|gracias)\b/i,
  /\bdon'?t\s+(want|need)\b/i,
  /\bcancel(ar)?\b/i,
  /\bskip\b/i,
  /\bnunca\s+mente\b/i,
  /\bnevermind\b/i,
  /\bolv[i\u00ed]d[a-z\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1]*\b/i,
  /\bno\s+thanks?\b/i,
];

export function isCancellation(text) {
  const t = (text || "").trim();
  if (!t) return false;
  return CANCEL_PATTERNS.some((re) => re.test(t));
}

// ─────────────────────────────────────────────────────────────────────
// "I WANT HUMAN" SHORTCUT — triggers handoff from ANY state
// ─────────────────────────────────────────────────────────────────────

const HUMAN_PATTERNS = [
  /^\s*humano\s*$/i,
  /^\s*human\s*$/i,
  /\bhablar\s+con\s+(jose|alguien|humano|persona)\b/i,
  /\btalk\s+to\s+(jose|someone|a\s+human|a\s+person)\b/i,
  /\bspeak\s+to\s+(jose|someone|a\s+human|a\s+person)\b/i,
];

export function isHumanRequest(text) {
  const t = (text || "").trim();
  if (!t) return false;
  return HUMAN_PATTERNS.some((re) => re.test(t));
}

// ─────────────────────────────────────────────────────────────────────
// COMBINED PARSER — for "name + email in one message"
// ─────────────────────────────────────────────────────────────────────

// "my name is Idan Chen and ..." / "soy Juan Perez," / "me llamo Ana"
// The "name" forms require the copula ("is"/"es") so that a phrase like
// "an address in my name in the United States" can never match.
const NAME_LABELS = [
  /\b(?:my\s+name\s+is|his\s+name\s+is|her\s+name\s+is)\s+([\p{L}][\p{L}\s'\u2019.\-]{1,39})/iu,
  /\b(?:mi\s+nombre\s+es|me\s+llamo)\s+([\p{L}][\p{L}\s'\u2019.\-]{1,39})/iu,
  /\bsoy\s+([\p{L}][\p{L}\s'\u2019.\-]{1,39})/iu,
  /\b(?:i\s?am|i'?m)\s+([\p{L}][\p{L}\s'\u2019.\-]{1,39})/iu,
  /^\s*(?:nombre|name)\s*:\s*([\p{L}][\p{L}\s'\u2019.\-]{1,39})/iu,
];

// A captured name ends where one of these connectors begins.
const NAME_STOP = /\s+(?:and|y|e|my|mi|from|de|del|con|with|at|en|the|el|la|for|para|que|but|pero|so|then|luego|thank|thanks|gracias|email|e-mail|correo|is|es|owner|of|a|an|in)\b/iu;

function trimAtStopWord(raw) {
  let s = String(raw || "").replace(/\s+/g, " ").trim();
  const m = s.match(NAME_STOP);
  if (m && m.index > 0) s = s.slice(0, m.index);
  let words = s.split(/\s+/).filter(Boolean).slice(0, MAX_NAME_WORDS);

  // Capitalisation boundary: in a mixed-case segment like
  // "Aldo Calieris recibi un correo", the name is the leading run of
  // capitalised words. Only applied when the writer actually capitalises —
  // an all-lowercase segment ("juan perez") is left alone.
  const isCap = (w) => /^[\p{Lu}]/u.test(w);
  if (words.some(isCap)) {
    const run = [];
    for (const w of words) {
      if (!isCap(w)) break;
      run.push(w);
    }
    if (run.length) words = run;
  }
  return words.join(" ").replace(/[,;.]+$/, "").trim();
}

/**
 * Tries to extract BOTH name and email from a single message.
 * E.g. "I'm Juan Perez, juan@example.com" or "Juan juan@example.com"
 * Returns { name, email } where either can be null.
 *
 * Order matters: a labelled pattern anywhere in the message wins over the
 * leftover text, because real messages wrap the name in a sentence.
 */
export function extractBoth(text) {
  const raw = String(text || "");
  const email = extractEmail(raw);
  let name = null;

  // The email is stripped first: otherwise its local part reads as another
  // word of the name ("His name is Josh josh@..." captured "Josh josh").
  const noEmail = email ? raw.split(email).join(" ") : raw;

  // 1) Labelled patterns, anywhere in the message.
  for (const re of NAME_LABELS) {
    const m = noEmail.match(re);
    if (!m) continue;
    const candidate = trimAtStopWord(m[1]);
    if (candidate && looksLikeName(candidate)) {
      name = cleanName(candidate);
      break;
    }
  }

  // 2) Fallback: whatever is left once the email is removed — but ONLY if
  //    that leftover is already short enough to be a name. This is the step
  //    that used to swallow entire paragraphs.
  if (!name) {
    const remainder = (email ? raw.replace(email, "") : raw)
      .replace(/[,;:|]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^(soy|me\s+llamo|i'?m|my\s+name\s+is|name:?|nombre:?)\s+/i, "")
      .replace(/^(email|correo):?\s*/i, "")
      .replace(/\s+(and\s+)?(my\s+)?(email|e-mail|correo)\s*(is|es)?\s*:?\s*$/i, "")
      .replace(/[,;.]\s*$/, "")
      .trim();
    if (remainder && looksLikeName(remainder)) {
      name = cleanName(remainder);
    }
  }

  return { name, email };
}
