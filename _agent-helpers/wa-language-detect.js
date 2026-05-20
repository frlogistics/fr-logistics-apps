// netlify/functions-helpers/wa-language-detect.js
//
// Pure utility — no Netlify Function wrapper, called by other functions.
// Detects ES vs EN vs UNKNOWN from first message + phone prefix.
//
// Usage:
//   import { detectLanguage } from './wa-language-detect.js';
//   const lang = detectLanguage('Hola, necesito FBA prep', '+573121234567');
//   // → 'ES'
//
// Returns: 'ES' | 'EN' | 'UNKNOWN'

// ─────────────────────────────────────────────────────────────────────
// LAYER 1 — Word-level Spanish/English detection
// ─────────────────────────────────────────────────────────────────────

const SPANISH_TELLS = [
  // Greetings & courtesy
  'hola', 'buenas', 'buenos', 'buena', 'gracias', 'saludos',
  'por favor', 'porfavor', 'disculpa', 'disculpe', 'perdon', 'perdón',
  // Common verbs/needs
  'necesito', 'quiero', 'quisiera', 'puedo', 'puedes', 'pueden',
  'tienen', 'tienes', 'tiene', 'hay', 'esta', 'están', 'estan',
  'soy', 'somos', 'son', 'estoy', 'estamos',
  // Commercial intent
  'cotización', 'cotizacion', 'cotizar', 'cotizame',
  'precio', 'precios', 'costo', 'costos', 'tarifa', 'tarifas',
  'cuánto', 'cuanto', 'cuanta', 'cuántos', 'cuantos',
  'información', 'informacion', 'info', 'detalles',
  // Logistics terms
  'envío', 'envio', 'envíos', 'envios', 'paquete', 'paquetes',
  'producto', 'productos', 'mercancía', 'mercancia',
  'almacén', 'almacen', 'bodega',
  // Common particles
  'sí', 'tal vez', 'quizás', 'quizas', 'también', 'tambien',
  'donde', 'dónde', 'cuando', 'cuándo', 'como', 'cómo', 'qué', 'que',
  'para', 'para mi', 'para mí', 'con', 'sin', 'desde', 'hasta',
  // Country-specific Spanish
  'mande', 'oiga', 'che', 'pues', 'vale'
];

const ENGLISH_TELLS = [
  // Greetings & courtesy
  'hi', 'hello', 'hey', 'good', 'morning', 'afternoon', 'evening',
  'thanks', 'thank', 'please', 'sorry',
  // Common verbs/needs
  'need', 'want', 'would', 'could', 'can', 'do', 'does',
  'have', 'has', 'is', 'are', 'am', 'was', 'were',
  // Commercial intent
  'quote', 'pricing', 'price', 'cost', 'rate', 'rates',
  'how much', 'howmuch',
  'info', 'information', 'details',
  // Logistics terms
  'shipping', 'shipment', 'package', 'packages',
  'product', 'products', 'inventory',
  'warehouse', 'fulfillment',
  // Common particles
  'yes', 'no', 'maybe', 'also', 'too',
  'where', 'when', 'how', 'what', 'why',
  'for', 'with', 'without', 'from', 'to'
];

// ─────────────────────────────────────────────────────────────────────
// LAYER 2 — Country code → likely language
// ─────────────────────────────────────────────────────────────────────

const SPANISH_COUNTRY_PREFIXES = [
  '+52',    // Mexico
  '+54',    // Argentina
  '+56',    // Chile
  '+57',    // Colombia
  '+51',    // Peru
  '+58',    // Venezuela
  '+593',   // Ecuador
  '+595',   // Paraguay
  '+598',   // Uruguay
  '+591',   // Bolivia
  '+506',   // Costa Rica
  '+507',   // Panama
  '+503',   // El Salvador
  '+502',   // Guatemala
  '+504',   // Honduras
  '+505',   // Nicaragua
  '+34',    // Spain
  '+53',    // Cuba
  '+1809', '+1829', '+1849',  // Dominican Republic
  '+1787', '+1939'             // Puerto Rico
];

// Note: +1 alone is ambiguous (USA + Canada + several Caribbean countries),
// so we don't auto-assume EN from it. We treat +1 as UNKNOWN at layer 2
// and rely on layer 3 (bilingual greeting) to disambiguate.

// ─────────────────────────────────────────────────────────────────────
// MAIN DETECTOR
// ─────────────────────────────────────────────────────────────────────

/**
 * Detects language from first message and phone number.
 * 
 * @param {string} text - The first message text from the user
 * @param {string} phoneNumber - E.164 format (+15551234567)
 * @returns {{ language: 'ES'|'EN'|'UNKNOWN', source: string, esScore: number, enScore: number }}
 */
export function detectLanguage(text, phoneNumber) {
  const result = {
    language: 'UNKNOWN',
    source: null,
    esScore: 0,
    enScore: 0
  };

  // Normalize input
  const lower = (text || '').toLowerCase().trim();
  const phone = (phoneNumber || '').trim();

  // ─── LAYER 1: text analysis ─────────────────────────────────────
  if (lower.length > 0) {
    // Use word boundaries to avoid false positives
    // (e.g. "info" in English shouldn't match "informacion" partial)
    const words = lower.split(/[\s,.!?¿¡()]+/).filter(Boolean);

    // Count matches as both single-word and multi-word phrases
    result.esScore = countMatches(lower, words, SPANISH_TELLS);
    result.enScore = countMatches(lower, words, ENGLISH_TELLS);

    // Decisive winner: at least 1 match AND difference >= 1
    if (result.esScore > result.enScore && result.esScore > 0) {
      result.language = 'ES';
      result.source = 'text_detect';
      return result;
    }
    if (result.enScore > result.esScore && result.enScore > 0) {
      result.language = 'EN';
      result.source = 'text_detect';
      return result;
    }

    // Tie or both zero → fall through to Layer 2
  }

  // ─── LAYER 2: phone prefix ──────────────────────────────────────
  if (phone) {
    // Try longest prefixes first (4-digit, then 3-digit, then 2-digit)
    const sortedPrefixes = [...SPANISH_COUNTRY_PREFIXES].sort(
      (a, b) => b.length - a.length
    );
    for (const prefix of sortedPrefixes) {
      if (phone.startsWith(prefix)) {
        result.language = 'ES';
        result.source = 'phone_prefix';
        return result;
      }
    }
    // +1 and others stay UNKNOWN — too ambiguous for confident default
  }

  // ─── LAYER 3: indeterminate → caller sends bilingual greeting ──
  return result;
}

// Helper: counts tell matches in text. Multi-word tells (with space)
// are checked as substrings; single-word tells must match whole words.
function countMatches(fullText, words, tells) {
  let count = 0;
  for (const tell of tells) {
    if (tell.includes(' ')) {
      // Multi-word phrase: substring match
      if (fullText.includes(tell)) count++;
    } else {
      // Single word: must be a whole word in the tokenized list
      if (words.includes(tell)) count++;
    }
  }
  return count;
}

/**
 * Parses an explicit user choice from a bilingual greeting reply.
 * Lead replied "EN", "ES", "english", "español", "1", "2", etc.
 * 
 * @param {string} text - User's reply
 * @returns {'ES'|'EN'|null} null if no clear choice
 */
export function parseLanguageChoice(text) {
  const lower = (text || '').toLowerCase().trim();
  
  // Exact matches first
  if (['en', 'english', 'ingles', 'inglés', 'eng', '🇺🇸'].includes(lower)) {
    return 'EN';
  }
  if (['es', 'español', 'espanol', 'spanish', 'esp', '🇪🇸', '🇲🇽', '🇨🇴', '🇦🇷'].includes(lower)) {
    return 'ES';
  }
  
  // Substring fallback (e.g. "en por favor" or "i want english")
  if (/\b(english|ingl[eé]s)\b/i.test(lower)) return 'EN';
  if (/\b(espa[ñn]ol|spanish)\b/i.test(lower)) return 'ES';
  
  // Letter-only fallback
  if (lower === 'e' || lower === 'i') return 'EN';
  if (lower === 's') return 'ES';
  
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// SELF-TEST (uncomment to run locally with: node wa-language-detect.js)
// ─────────────────────────────────────────────────────────────────────
/*
const tests = [
  // Layer 1 — clear text
  { text: 'Hola, necesito FBA prep', phone: '+15551234567', expected: 'ES' },
  { text: 'Hi, do you offer dropship?', phone: '+15551234567', expected: 'EN' },
  { text: 'Buenos días', phone: '+15551234567', expected: 'ES' },
  { text: 'Good morning', phone: '+15551234567', expected: 'EN' },
  { text: 'Quiero información de precios', phone: '+15551234567', expected: 'ES' },
  { text: 'Need a quote please', phone: '+15551234567', expected: 'EN' },
  
  // Layer 2 — country prefix fallback
  { text: '👋', phone: '+573121234567', expected: 'ES' },     // Colombia
  { text: '👋', phone: '+525512345678', expected: 'ES' },     // Mexico
  { text: '👋', phone: '+541112345678', expected: 'ES' },     // Argentina
  { text: '👋', phone: '+34911234567',  expected: 'ES' },     // Spain
  
  // Layer 3 — ambiguous → UNKNOWN
  { text: '👋', phone: '+15551234567', expected: 'UNKNOWN' },  // USA, no text signal
  { text: '', phone: '+15551234567',   expected: 'UNKNOWN' },
  { text: '?', phone: '+15551234567',  expected: 'UNKNOWN' },
  
  // Spanglish — winner by count
  { text: 'Hola, do you have FBA prep?', phone: '+15551234567', expected: 'EN' }, // hola=1, hi/do/have=2+ → EN
];

for (const t of tests) {
  const r = detectLanguage(t.text, t.phone);
  const pass = r.language === t.expected;
  console.log(
    pass ? '✅' : '❌',
    `"${t.text}" [${t.phone}] → ${r.language} (${r.source || '-'}, es:${r.esScore} en:${r.enScore})`,
    pass ? '' : `EXPECTED ${t.expected}`
  );
}
*/
