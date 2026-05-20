// netlify/functions/_agent-helpers/wa-agent-qualify.js
//
// Sprint 2 qualification flow — pure data + parsing.
// Defines the 3-question sequence for each service, with bilingual prompts,
// numbered options, and normalizers for the user's reply.
//
// The router imports this to drive the state machine and persist answers.
// Open-text fallback: if user doesn't match a numbered option, we save
// their literal text in the _raw column and Liam moves on (we don't pester).

// ─────────────────────────────────────────────────────────────────────
// QUESTION DEFINITIONS — one set per service
// Each question has: id, field, raw_field, prompts (es/en), options (es/en)
// ─────────────────────────────────────────────────────────────────────

export const QUALIFY_SEQUENCES = {

  // ═══════════════════════════════════════════════════════════════════
  // FBA PREP — Amazon sellers
  // ═══════════════════════════════════════════════════════════════════
  fba_prep: [
    {
      id: 'q1',
      field: 'captured_volume',
      rawField: 'captured_volume_raw',
      prompts: {
        es: '*1 de 3* — ¿Cuántas unidades por mes manejas (aprox)?\n\n1️⃣ Menos de 500\n2️⃣ 500 – 2,000\n3️⃣ 2,000 – 10,000\n4️⃣ Más de 10,000\n\n_(O escríbelo en tus palabras)_',
        en: '*1 of 3* — How many units per month do you handle (approx)?\n\n1️⃣ Under 500\n2️⃣ 500 – 2,000\n3️⃣ 2,000 – 10,000\n4️⃣ Over 10,000\n\n_(Or describe it in your own words)_',
      },
      options: {
        '1': '<500',
        '2': '500-2K',
        '3': '2K-10K',
        '4': '+10K',
      },
    },
    {
      id: 'q2',
      field: 'captured_country',
      rawField: 'captured_country_raw',
      prompts: {
        es: '*2 de 3* — ¿De qué país vienen tus productos?\n\n1️⃣ México\n2️⃣ Colombia\n3️⃣ China\n4️⃣ USA\n5️⃣ Otro\n\n_(O escríbelo)_',
        en: '*2 of 3* — Which country do your products come from?\n\n1️⃣ Mexico\n2️⃣ Colombia\n3️⃣ China\n4️⃣ USA\n5️⃣ Other\n\n_(Or just type it)_',
      },
      options: {
        '1': 'Mexico',
        '2': 'Colombia',
        '3': 'China',
        '4': 'USA',
        '5': 'Other',
      },
    },
    {
      id: 'q3',
      field: 'captured_stage',
      rawField: 'captured_stage_raw',
      prompts: {
        es: '*3 de 3* — ¿Ya estás vendiendo en Amazon?\n\n1️⃣ Sí, activo y vendiendo\n2️⃣ Sí, recién empezando\n3️⃣ No, voy a empezar pronto\n\n_(O cuéntame tu situación)_',
        en: '*3 of 3* — Are you already selling on Amazon?\n\n1️⃣ Yes, active and selling\n2️⃣ Yes, just starting\n3️⃣ No, about to start\n\n_(Or tell me your situation)_',
      },
      options: {
        '1': 'active_seller',
        '2': 'just_started',
        '3': 'pre_launch',
      },
    },
  ],

  // ═══════════════════════════════════════════════════════════════════
  // MASTER CASE — Container receiving
  // ═══════════════════════════════════════════════════════════════════
  master_case: [
    {
      id: 'q1',
      field: 'captured_volume',
      rawField: 'captured_volume_raw',
      prompts: {
        es: '*1 de 3* — ¿Cuántos contenedores por mes (aprox)?\n\n1️⃣ 1 al mes\n2️⃣ 2 – 5\n3️⃣ 6 – 10\n4️⃣ Más de 10\n\n_(O escríbelo)_',
        en: '*1 of 3* — How many containers per month (approx)?\n\n1️⃣ 1 per month\n2️⃣ 2 – 5\n3️⃣ 6 – 10\n4️⃣ Over 10\n\n_(Or describe it)_',
      },
      options: {
        '1': '1/mo',
        '2': '2-5/mo',
        '3': '6-10/mo',
        '4': '+10/mo',
      },
    },
    {
      id: 'q2',
      field: 'captured_country',
      rawField: 'captured_country_raw',
      prompts: {
        es: '*2 de 3* — ¿De qué países importas?\n\n1️⃣ China\n2️⃣ México\n3️⃣ Colombia\n4️⃣ Otros LATAM\n5️⃣ Otro\n\n_(Puedes escribir varios)_',
        en: '*2 of 3* — Which countries do you import from?\n\n1️⃣ China\n2️⃣ Mexico\n3️⃣ Colombia\n4️⃣ Other LATAM\n5️⃣ Other\n\n_(You can list multiple)_',
      },
      options: {
        '1': 'China',
        '2': 'Mexico',
        '3': 'Colombia',
        '4': 'LATAM',
        '5': 'Other',
      },
    },
    {
      id: 'q3',
      field: 'captured_product_type',
      rawField: 'captured_product_type_raw',
      prompts: {
        es: '*3 de 3* — ¿Qué tipo de mercancía?\n\n1️⃣ Electrónica\n2️⃣ Ropa / Textil\n3️⃣ Hogar\n4️⃣ FMCG / Consumo\n5️⃣ Otro\n\n_(O cuéntame)_',
        en: '*3 of 3* — What type of merchandise?\n\n1️⃣ Electronics\n2️⃣ Apparel / Textile\n3️⃣ Home goods\n4️⃣ FMCG / Consumer\n5️⃣ Other\n\n_(Or describe it)_',
      },
      options: {
        '1': 'electronics',
        '2': 'apparel',
        '3': 'home',
        '4': 'fmcg',
        '5': 'other',
      },
    },
  ],

  // ═══════════════════════════════════════════════════════════════════
  // DROPSHIP — Sellers without inventory
  // ═══════════════════════════════════════════════════════════════════
  dropship: [
    {
      id: 'q1',
      field: 'captured_volume',
      rawField: 'captured_volume_raw',
      prompts: {
        es: '*1 de 3* — ¿Cuántas órdenes por día (aprox)?\n\n1️⃣ Menos de 10\n2️⃣ 10 – 50\n3️⃣ 50 – 200\n4️⃣ Más de 200\n\n_(O escríbelo)_',
        en: '*1 of 3* — How many orders per day (approx)?\n\n1️⃣ Under 10\n2️⃣ 10 – 50\n3️⃣ 50 – 200\n4️⃣ Over 200\n\n_(Or describe it)_',
      },
      options: {
        '1': '<10/day',
        '2': '10-50/day',
        '3': '50-200/day',
        '4': '+200/day',
      },
    },
    {
      id: 'q2',
      field: 'captured_platforms',
      rawField: 'captured_platforms_raw',
      prompts: {
        es: '*2 de 3* — ¿En qué plataformas vendes?\n\n1️⃣ Amazon\n2️⃣ Shopify\n3️⃣ Walmart\n4️⃣ eBay\n5️⃣ Mercado Libre\n6️⃣ Múltiples\n\n_(O cuéntame cuáles)_',
        en: '*2 of 3* — Which platforms do you sell on?\n\n1️⃣ Amazon\n2️⃣ Shopify\n3️⃣ Walmart\n4️⃣ eBay\n5️⃣ Mercado Libre\n6️⃣ Multiple\n\n_(Or list them)_',
      },
      options: {
        '1': 'Amazon',
        '2': 'Shopify',
        '3': 'Walmart',
        '4': 'eBay',
        '5': 'MercadoLibre',
        '6': 'Multiple',
      },
    },
    {
      id: 'q3',
      field: 'captured_integration',
      rawField: 'captured_integration_raw',
      prompts: {
        es: '*3 de 3* — ¿Necesitas integración automática o subes órdenes manualmente?\n\n1️⃣ Integración automática (API)\n2️⃣ Manual (CSV / portal)\n3️⃣ No sé aún\n\n_(O cuéntame)_',
        en: '*3 of 3* — Do you need automatic integration or upload orders manually?\n\n1️⃣ Automatic (API integration)\n2️⃣ Manual (CSV / portal)\n3️⃣ Not sure yet\n\n_(Or describe it)_',
      },
      options: {
        '1': 'auto_api',
        '2': 'manual',
        '3': 'undecided',
      },
    },
  ],

  // ═══════════════════════════════════════════════════════════════════
  // ECOPACK+ — Sustainable shipping
  // ═══════════════════════════════════════════════════════════════════
  ecopack: [
    {
      id: 'q1',
      field: 'captured_volume',
      rawField: 'captured_volume_raw',
      prompts: {
        es: '*1 de 3* — ¿Cuántos envíos por mes (aprox)?\n\n1️⃣ Menos de 100\n2️⃣ 100 – 500\n3️⃣ 500 – 2,000\n4️⃣ Más de 2,000\n\n_(O escríbelo)_',
        en: '*1 of 3* — How many shipments per month (approx)?\n\n1️⃣ Under 100\n2️⃣ 100 – 500\n3️⃣ 500 – 2,000\n4️⃣ Over 2,000\n\n_(Or describe it)_',
      },
      options: {
        '1': '<100/mo',
        '2': '100-500/mo',
        '3': '500-2K/mo',
        '4': '+2K/mo',
      },
    },
    {
      id: 'q2',
      field: 'captured_product_type',
      rawField: 'captured_product_type_raw',
      prompts: {
        es: '*2 de 3* — ¿Qué tipo de producto envías?\n\n1️⃣ Cosmética\n2️⃣ Ropa\n3️⃣ Suplementos\n4️⃣ Tecnología\n5️⃣ Otro\n\n_(O cuéntame)_',
        en: '*2 of 3* — What type of product do you ship?\n\n1️⃣ Cosmetics\n2️⃣ Apparel\n3️⃣ Supplements\n4️⃣ Tech\n5️⃣ Other\n\n_(Or describe it)_',
      },
      options: {
        '1': 'cosmetics',
        '2': 'apparel',
        '3': 'supplements',
        '4': 'tech',
        '5': 'other',
      },
    },
    {
      id: 'q3',
      field: 'captured_eco_focus',
      rawField: 'captured_eco_focus_raw',
      prompts: {
        es: '*3 de 3* — ¿Tu marca ya tiene mensaje eco-friendly o lo estás explorando?\n\n1️⃣ Ya tenemos posicionamiento eco\n2️⃣ Lo estamos explorando\n3️⃣ Solo busco packaging sostenible\n\n_(O cuéntame)_',
        en: '*3 of 3* — Does your brand have eco messaging or are you exploring it?\n\n1️⃣ Already have eco positioning\n2️⃣ Exploring it\n3️⃣ Just want sustainable packaging\n\n_(Or describe it)_',
      },
      options: {
        '1': 'established_eco',
        '2': 'exploring',
        '3': 'packaging_only',
      },
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────
// PARSING — given user reply + question, return { normalized, raw }
// If reply matches a numbered option, normalized = mapped value.
// Otherwise normalized = null and we keep raw text.
// ─────────────────────────────────────────────────────────────────────

/**
 * Parses a user's reply to a qualification question.
 * @param {string} text - User's reply
 * @param {object} question - The question definition from QUALIFY_SEQUENCES
 * @returns {{ normalized: string|null, raw: string }}
 */
export function parseQualifyReply(text, question) {
  const trimmed = (text || '').trim();
  const raw = trimmed.slice(0, 500); // cap at 500 chars for safety

  // Try to match a numbered option (1, 2, 3, 4, 5, 6)
  // Accept: "1", "1.", "1 ", "1️⃣", "Option 1", etc.
  for (const optKey of Object.keys(question.options)) {
    const escapedKey = optKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`^${escapedKey}\\b`),       // starts with "1"
      new RegExp(`^${escapedKey}[.)\\s]`),   // "1." or "1)" or "1 "
      new RegExp(`${escapedKey}️⃣`),           // emoji
    ];
    if (patterns.some(p => p.test(trimmed))) {
      return { normalized: question.options[optKey], raw };
    }
  }

  // No match — save raw text, no normalization
  return { normalized: null, raw };
}

// ─────────────────────────────────────────────────────────────────────
// HELPER — get the next question in a sequence (or null if done)
// ─────────────────────────────────────────────────────────────────────

/**
 * Returns the next question in the sequence, or null if sequence complete.
 * @param {string} service - 'fba_prep' | 'master_case' | 'dropship' | 'ecopack'
 * @param {string} currentSubState - 'awaiting_q1' | 'awaiting_q2' | 'awaiting_q3' | null
 * @returns {object|null} Next question definition or null
 */
export function getNextQuestion(service, currentSubState) {
  const seq = QUALIFY_SEQUENCES[service];
  if (!seq) return null;

  // If no sub_state yet, return first question
  if (!currentSubState || !currentSubState.startsWith('awaiting_q')) {
    return seq[0];
  }

  // Extract index from sub_state ('awaiting_q1' → 1, 'awaiting_q2' → 2)
  const currentIdx = parseInt(currentSubState.replace('awaiting_q', ''), 10);
  if (isNaN(currentIdx) || currentIdx < 1) return seq[0];

  // Return next (0-indexed in array, sub_state is 1-indexed)
  return seq[currentIdx] || null;
}

/**
 * Returns the question by index (1-based).
 */
export function getQuestionByIndex(service, idx) {
  const seq = QUALIFY_SEQUENCES[service];
  if (!seq) return null;
  return seq[idx - 1] || null;
}

/**
 * Total questions in a service's sequence.
 */
export function getSequenceLength(service) {
  return QUALIFY_SEQUENCES[service]?.length || 0;
}

// ─────────────────────────────────────────────────────────────────────
// HELPER — build a summary object for the handoff email
// Returns a clean dict of all captured qualification data
// ─────────────────────────────────────────────────────────────────────

export function buildQualificationSummary(conv) {
  const summary = {};
  const fields = [
    ['volume', 'captured_volume', 'captured_volume_raw'],
    ['country', 'captured_country', 'captured_country_raw'],
    ['platforms', 'captured_platforms', 'captured_platforms_raw'],
    ['stage', 'captured_stage', 'captured_stage_raw'],
    ['product_type', 'captured_product_type', 'captured_product_type_raw'],
    ['integration', 'captured_integration', 'captured_integration_raw'],
    ['eco_focus', 'captured_eco_focus', 'captured_eco_focus_raw'],
  ];

  for (const [key, field, rawField] of fields) {
    const normalized = conv[field];
    const raw = conv[rawField];
    if (normalized || raw) {
      summary[key] = { normalized, raw };
    }
  }

  return summary;
}
