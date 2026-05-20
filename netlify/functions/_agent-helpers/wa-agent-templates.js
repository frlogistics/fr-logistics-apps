// netlify/functions/_agent-helpers/wa-agent-templates.js
//
// Hardcoded message templates for Liam, FR-Logistics WhatsApp agent.
// These DO NOT call the LLM — they're deterministic templates.
// Used by: wa-agent-router.js, wa-agent-greet.js, wa-agent-state.js
//
// All templates are locked per Sprint 1 spec.
// Tone: professional + friendly. Personality: Liam.
// Brand voice: warm, capable, never overpromising.
//
// SPANISH STYLE (locked v2 — May 2026):
//   - Neutral LATAM Spanish — works for MX, CO, AR, PE, CL, VE, EC, ES.
//   - Tuteo with "tú" implicit: puedes, tienes, quieres, necesitas, avísame.
//   - NEVER rioplatense: no vos, podés, tenés, querés, sos.
//   - NEVER vosotros (Spain): no tenéis, podéis.
//   - No regional slang: no chévere, vale, bárbaro, padre.
//   - "aquí" not "acá".

// ─────────────────────────────────────────────────────────────────────
// INITIAL GREETINGS (Sprint 1)
// ─────────────────────────────────────────────────────────────────────

export const TEMPLATES = {

  // When language is detected confidently
  greet_es: () =>
`¡Hola! 👋

Soy Liam, asistente logístico de FR-Logistics Miami.
Estoy aquí 24/7 para ayudarte.

Podemos hablar de:
1️⃣ FBA Prep (preparación para Amazon)
2️⃣ Master Case (recepción de contenedores)
3️⃣ Dropshipment (sin inventario)
4️⃣ EcoPack+ (envíos sostenibles)
5️⃣ Otro / hablar con Jose

¿Cómo te puedo ayudar hoy?`,

  greet_en: () =>
`Hi there! 👋

I'm Liam, FR-Logistics Miami's virtual assistant.
I'm here 24/7 to help you.

We can talk about:
1️⃣ FBA Prep (Amazon prep services)
2️⃣ Master Case (container receiving)
3️⃣ Dropshipment (no inventory)
4️⃣ EcoPack+ (sustainable shipping)
5️⃣ Other / talk to Jose

How can I help you today?`,

  // When language is UNKNOWN → bilingual short greeting
  greet_bilingual: () =>
`👋 Hi / Hola

I'm Liam — FR-Logistics assistant.
Soy Liam — asistente logístico de FR-Logistics.

Reply EN or ES?`,

  // After user picks EN explicitly
  confirm_en: () =>
`Got it! I'll continue in English. 👍

We can talk about:
1️⃣ FBA Prep
2️⃣ Master Case
3️⃣ Dropshipment
4️⃣ EcoPack+
5️⃣ Other / talk to Jose

How can I help?`,

  // After user picks ES explicitly
  confirm_es: () =>
`¡Perfecto! Sigo en español. 👍

Podemos hablar de:
1️⃣ FBA Prep
2️⃣ Master Case
3️⃣ Dropshipment
4️⃣ EcoPack+
5️⃣ Otro / hablar con Jose

¿Cómo te puedo ayudar?`,

  // If user replies to bilingual greeting with something we can't parse
  retry_language_choice: () =>
`Sorry, didn't catch that — please reply EN or ES.
Perdón, no entendí — responde EN o ES.`,

  // After 2 failed retries, default to English
  fallback_to_en: () =>
`No problem! I'll continue in English. If you prefer Spanish at any time, just type "ES".

1️⃣ FBA Prep
2️⃣ Master Case
3️⃣ Dropshipment
4️⃣ EcoPack+
5️⃣ Other / talk to Jose

How can I help?`,

  // ───────────────────────────────────────────────────────────────
  // QUALIFICATION FLOW (Sprint 2) — intros + transitions
  // The actual questions live in wa-agent-qualify.js (one per service).
  // These templates wrap the flow with friendly text.
  // ───────────────────────────────────────────────────────────────

  // After user picks 1-4 from main menu — intro to the 3 questions
  qualify_intro_fba_prep_es: () =>
`¡Excelente elección! 📦

Para darte la mejor info sobre *FBA Prep*, déjame hacerte 3 preguntas rápidas. Después te conecto con Jose Fuentes para que te dé una cotización personalizada.`,

  qualify_intro_fba_prep_en: () =>
`Excellent choice! 📦

To give you the best info on *FBA Prep*, let me ask you 3 quick questions. Then I'll connect you with Jose Fuentes for a personalized quote.`,

  qualify_intro_master_case_es: () =>
`¡Excelente! 📥

Para darte la mejor info sobre *Master Case Receiving*, déjame hacerte 3 preguntas rápidas. Después te conecto con Jose Fuentes para una cotización.`,

  qualify_intro_master_case_en: () =>
`Excellent! 📥

To give you the best info on *Master Case Receiving*, let me ask you 3 quick questions. Then I'll connect you with Jose Fuentes for a quote.`,

  qualify_intro_dropship_es: () =>
`¡Genial! 🚚

Para darte la mejor info sobre *Dropshipment*, déjame hacerte 3 preguntas rápidas. Después te conecto con Jose Fuentes para una cotización.`,

  qualify_intro_dropship_en: () =>
`Awesome! 🚚

To give you the best info on *Dropshipment*, let me ask you 3 quick questions. Then I'll connect you with Jose Fuentes for a quote.`,

  qualify_intro_ecopack_es: () =>
`¡Me encanta! 🌱

Para darte la mejor info sobre *EcoPack+*, déjame hacerte 3 preguntas rápidas. Después te conecto con Jose Fuentes para una cotización.`,

  qualify_intro_ecopack_en: () =>
`Love it! 🌱

To give you the best info on *EcoPack+*, let me ask you 3 quick questions. Then I'll connect you with Jose Fuentes for a quote.`,

  // After Q3 answered — bridge to contact capture
  qualify_done_es: () =>
`¡Perfecto, gracias! 🙏

Ya tengo lo que necesito para que Jose Fuentes te prepare una propuesta personalizada.

¿Me dejas tu nombre y email para que te contacte?`,

  qualify_done_en: () =>
`Perfect, thanks! 🙏

I have everything Jose Fuentes needs to prepare a personalized proposal for you.

Could you share your name and email so he can reach out?`,

  // ───────────────────────────────────────────────────────────────
  // FAQ FOLLOW-UP (Sprint 3)
  // After Liam answers a free-text question with a FAQ, re-offer
  // the main menu to keep the lead engaged toward conversion.
  // ───────────────────────────────────────────────────────────────

  faq_followup_menu_es: () =>
`¿Hay algo más en lo que te pueda ayudar? 🤝

1️⃣ FBA Prep — Amazon SPN-Certified
2️⃣ Master Case — Recepción de contenedores
3️⃣ Dropshipment — Sellers sin inventario
4️⃣ EcoPack+ — Envíos sostenibles
5️⃣ Hablar con Jose Fuentes

_(O escríbeme tu pregunta y te respondo)_`,

  faq_followup_menu_en: () =>
`Anything else I can help with? 🤝

1️⃣ FBA Prep — Amazon SPN-Certified
2️⃣ Master Case — Container receiving
3️⃣ Dropshipment — Sellers without inventory
4️⃣ EcoPack+ — Sustainable shipping
5️⃣ Talk to Jose Fuentes

_(Or just ask me anything)_`,

  // ───────────────────────────────────────────────────────────────
  // HANDOFF TO JOSE (option 5 or explicit request)
  // ───────────────────────────────────────────────────────────────

  handoff_jose_ack_es: () =>
`Perfecto, le aviso a Jose Fuentes ahora mismo.

Mientras tanto, ¿puedes dejarme tu nombre y email para que él pueda contactarte?`,

  handoff_jose_ack_en: () =>
`Got it — I'm notifying Jose Fuentes right now.

In the meantime, could you share your name and email so he can reach out?`,

  handoff_jose_ask_name_es: () =>
`¿Cuál es tu nombre?`,

  handoff_jose_ask_name_en: () =>
`What's your name?`,

  handoff_jose_ask_email_es: (name) =>
`Gracias, ${name}. ¿Cuál es tu email?`,

  handoff_jose_ask_email_en: (name) =>
`Thanks, ${name}. What's your email?`,

  handoff_jose_complete_es: (name) =>
`Listo, ${name}. Jose Fuentes te contactará lo antes posible al email que dejaste.

Si necesitas algo urgente, puedes llamarnos al +1 786-300-1443.`,

  handoff_jose_complete_en: (name) =>
`All set, ${name}. Jose Fuentes will reach out asap to the email you provided.

If you need something urgent, you can call us at +1 786-300-1443.`,

  // ───────────────────────────────────────────────────────────────
  // KILL SWITCH — agent disabled (monthly cap reached)
  // ───────────────────────────────────────────────────────────────

  kill_switch_es: () =>
`¡Hola! Soy Liam de FR-Logistics.

En este momento estamos con alta demanda.
Nuestro equipo te contactará pronto a través de info@fr-logistics.net.

Si es urgente, puedes llamar al +1 786-300-1443.`,

  kill_switch_en: () =>
`Hi! I'm Liam from FR-Logistics.

We're experiencing high demand right now.
Our team will contact you shortly via info@fr-logistics.net.

If urgent, call +1 786-300-1443.`,

  // ───────────────────────────────────────────────────────────────
  // EXISTING CLIENT — bot doesn't qualify, redirects to human inbox
  // (full operational client flow is Sprint 7+, v2)
  // ───────────────────────────────────────────────────────────────

  existing_client_redirect_es: (clientName) =>
`¡Hola ${clientName}! 👋

Tu mensaje fue recibido. El equipo de FR-Logistics te responderá pronto.

Si es urgente, puedes llamar al +1 786-300-1443.`,

  existing_client_redirect_en: (clientName) =>
`Hi ${clientName}! 👋

We received your message. The FR-Logistics team will reply soon.

If urgent, you can call +1 786-300-1443.`,

  // ───────────────────────────────────────────────────────────────
  // PAUSED — Jose took over manually
  // ───────────────────────────────────────────────────────────────

  paused_silent: () => null,  // No message sent; agent just stops responding.

  // ───────────────────────────────────────────────────────────────
  // INACTIVITY TIMEOUT (24h)
  // ───────────────────────────────────────────────────────────────

  timeout_es: () =>
`Veo que no pudimos continuar la conversación.

Cuando estés listo para retomarla, solo escríbeme aquí y te ayudo.
Mientras tanto, puedes visitar fr-logistics.net o llamar al +1 786-300-1443.`,

  timeout_en: () =>
`Looks like we couldn't continue the conversation.

Whenever you're ready to pick it back up, just message me here.
Meanwhile, you can visit fr-logistics.net or call +1 786-300-1443.`,
};

// ─────────────────────────────────────────────────────────────────────
// HELPER: pick template based on language code
// ─────────────────────────────────────────────────────────────────────

/**
 * Returns the right template for the language.
 * @param {string} key - Template key without _es/_en suffix (e.g. 'greet')
 * @param {string} language - 'ES' or 'EN'
 * @param {...any} args - Args to pass to the template fn
 * @returns {string}
 */
export function pickTemplate(key, language, ...args) {
  const suffix = language === 'ES' ? '_es' : '_en';
  const fn = TEMPLATES[key + suffix];
  if (!fn) {
    throw new Error(`Template not found: ${key}${suffix}`);
  }
  return fn(...args);
}

// ─────────────────────────────────────────────────────────────────────
// MENU PARSER — interpret user reply to greeting menu (1-5)
// ─────────────────────────────────────────────────────────────────────

/**
 * Parses user's reply to the greeting menu into a service intent.
 * @param {string} text - User's reply
 * @returns {string|null} 'fba_prep'|'master_case'|'dropship'|'ecopack'|'jose_handoff'|null
 */
export function parseMenuChoice(text) {
  const lower = (text || '').toLowerCase().trim();

  // Number replies
  if (/^1\b/.test(lower) || /1️⃣/.test(text)) return 'fba_prep';
  if (/^2\b/.test(lower) || /2️⃣/.test(text)) return 'master_case';
  if (/^3\b/.test(lower) || /3️⃣/.test(text)) return 'dropship';
  if (/^4\b/.test(lower) || /4️⃣/.test(text)) return 'ecopack';
  if (/^5\b/.test(lower) || /5️⃣/.test(text)) return 'jose_handoff';

  // Keyword fallback
  if (/\bfba\b|prep|amazon/i.test(text)) return 'fba_prep';
  if (/master ?case|container|contenedor/i.test(text)) return 'master_case';
  if (/drop ?ship/i.test(text)) return 'dropship';
  if (/eco ?pack/i.test(text)) return 'ecopack';
  if (/jose|hablar|talk to|human|humano|persona|owner/i.test(text)) return 'jose_handoff';

  return null;
}
