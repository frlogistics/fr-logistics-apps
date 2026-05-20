// netlify/functions/_agent-helpers/wa-agent-capture.js
//
// Parsing utilities for the handoff capture flow (name + email).
// Pure functions, no side effects. Tested.

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

/**
 * Heuristic to decide whether a string is a plausible name.
 *   - Has at least 2 characters (no single-letter names)
 *   - No email-like @ chars
 *   - No phone-like digit runs (4+ digits in a row)
 *   - Not a known menu number reply
 */
export function looksLikeName(text) {
  const t = (text || "").trim();
  if (t.length < 2) return false;
  if (t.includes("@")) return false;
  if (/\d{4,}/.test(t)) return false;        // phone numbers
  if (/^[1-5][.\s]?$/.test(t)) return false; // menu reply
  if (/^(yes|no|si|sí|ok|cancel|cancelar|nope)$/i.test(t)) return false;
  return true;
}

/**
 * Cleans a captured name: trims, removes excess whitespace, capitalizes
 * (without being aggressive — preserve user's casing if it looks intentional).
 */
export function cleanName(text) {
  let t = (text || "").trim().replace(/\s+/g, " ");
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
  /\bolv[ií]d[a-záéíóúñ]*\b/i,
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

/**
 * Tries to extract BOTH name and email from a single message.
 * E.g. "I'm Juan Pérez, juan@example.com" or "Juan juan@example.com"
 * Returns { name, email } where either can be null.
 */
export function extractBoth(text) {
  const email = extractEmail(text);
  let name = null;

  if (email) {
    // Remove the email from the text, then see if what's left looks like a name
    const remainder = text.replace(email, "")
      .replace(/[,;:|\.]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    // Strip common prefixes & connectors
    const stripped = remainder
      .replace(/^(soy|me\s+llamo|i'?m|my\s+name\s+is|name:?)\s+/i, "")
      .replace(/^(email|correo):?\s*/i, "")
      .replace(/\s+(and\s+)?(my\s+)?(email|e-mail|correo)\s+(is|es)?\s*$/i, "")
      .replace(/\s+(and\s+)?(my\s+)?(email|e-mail|correo)\s*:?\s*$/i, "")
      .replace(/[,;]\s*$/, "")
      .trim();
    if (stripped && looksLikeName(stripped)) {
      name = cleanName(stripped);
    }
  } else {
    // No email — see if the whole text is a name
    if (looksLikeName(text)) {
      name = cleanName(text);
    }
  }

  return { name, email };
}
