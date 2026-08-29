// netlify/functions-helpers/wa-agent-router.js
//
// THE AGENT ROUTER — called for every inbound WhatsApp message after
// the webhook has persisted to Blobs and fired email/push.
//
// Sprint 1 scope:
//   1. Kill switch check → send canned "high demand" message and exit
//   2. Existing client? → polite acknowledgment, no qualification
//   3. New lead, has active conversation? → handle in current state
//   4. New lead, no conversation? → detect language + greet
//
// Sprints 2-4 will add: qualification flow, FAQ matching, LLM calls.
//
// This function is BEST-EFFORT. It must NEVER throw. If anything fails,
// it returns silently — the webhook already handled Blobs/email/push.
//
// MULTICANAL (2026-08-22). El router NO se forkea por canal: la maquina de
// estados, el visit guard, el decay de menu, los reintentos y la politica
// de handoff son los mismos para WhatsApp, chat web e Instagram.
// Lo unico que cambia es POR DONDE SALE la respuesta, y eso se resuelve en
// los dos despachadores de abajo (sendAndRecord / sendOnce) leyendo el
// prefijo de la direccion. Por eso las ~30 llamadas de envio que hay en
// este archivo quedaron intactas.
//
// msg.from puede ser: "13055551234" (WhatsApp), "web:<sesion>", "ig:<IGSID>".

import { detectLanguage, parseLanguageChoice } from "./wa-language-detect.js";
import { TEMPLATES, parseMenuChoice } from "./wa-agent-templates.js";
import {
  lookupExistingClient,
  getActiveConversation,
  createConversation,
  updateConversationOnUserMessage,
  recordAgentMessage,
  isAgentDisabled,
  createLeadFromConversation,
  linkConversationToLead,
  markHandoff,
  pauseConversation,
  parseAddress,
  sendWebOutbound,
} from "./wa-agent-db.js";
import { sendAndRecord as sendWhatsAppAndRecord } from "./wa-agent-send.js";
import {
  extractEmail,
  isValidEmail,
  looksLikeName,
  cleanName,
  isCancellation,
  isHumanRequest,
  extractBoth,
} from "./wa-agent-capture.js";
import { sendHandoffEmail } from "./wa-agent-email-handoff.js";
import {
  QUALIFY_SEQUENCES,
  parseQualifyReply,
  getNextQuestion,
  getQuestionByIndex,
  getSequenceLength,
  buildQualificationSummary,
} from "./wa-agent-qualify.js";
import { matchFAQ, getFAQAnswer, getFAQQuestion, topNFAQs } from "./wa-agent-faq-match.js";
import { askLLM } from "./wa-agent-llm.js";
import {
  isMediaPlaceholder,
  mediaKind,
  isClosing,
  sendOnce as sendWhatsAppOnce,
  bumpRetry,
  resetRetry,
  maxedOut,
  nextMenuMode,
  MENU_FULL,
  MENU_SHORT,
} from "./wa-agent-guards.js";

// ─────────────────────────────────────────────────────────────────────
// DESPACHADORES DE ENVIO
//
// Toda salida del router pasa por aqui. El canal se deduce del prefijo de
// `to`, no de estado compartido del modulo: dos invocaciones concurrentes
// en el mismo contenedor Lambda (una de WhatsApp y una del sitio) no se
// pueden pisar, porque cada una lleva su canal dentro del propio valor.
//
// Contrato de retorno, identico para los tres canales:
//   { ok: boolean, suppressed?: boolean }
// ─────────────────────────────────────────────────────────────────────

async function sendAndRecord(args) {
  const { channel } = parseAddress(args.to);
  if (channel === "whatsapp") return await sendWhatsAppAndRecord(args);
  if (channel === "web") return await sendWebOutbound({ ...args, once: false });
  console.error(`[agent-router] sin transporte para el canal ${channel}`);
  return { ok: false, suppressed: false };
}

async function sendOnce(args) {
  const { channel } = parseAddress(args.to);
  if (channel === "whatsapp") return await sendWhatsAppOnce(args);
  if (channel === "web") return await sendWebOutbound({ ...args, once: true });
  console.error(`[agent-router] sin transporte para el canal ${channel}`);
  return { ok: false, suppressed: false };
}

/**
 * Main entry point — called per inbound message.
 * 
 * @param {object} msg - The parsed inbound message
 * @param {string} msg.from - E.164 without + (e.g. "15551234567")
 * @param {string} msg.text - The message body
 * @param {string} msg.clientName - WhatsApp profile name (or 'from' as fallback)
 * @param {string} msg.id - Meta message ID
 */
export async function routeIncomingMessage(msg) {
  try {
    const { from, text, clientName } = msg;
    if (!from || !text) {
      console.log("[agent-router] missing from or text, skipping");
      return;
    }

    // El prefijo telefonico solo sirve para detectar idioma en WhatsApp.
    // En web/Instagram va vacio para que detectLanguage caiga al texto en
    // vez de leer digitos de un uuid como si fueran un pais.
    const fromE164 = phonePrefixOf(from);

    // ─── STEP 0: Human shortcut ───────────────────────────────────
    // If user types "humano" / "human" / "quiero hablar con jose" from ANY
    // state, jump straight to handoff. This is a safety valve for users
    // who don't want to navigate menus.
    if (isHumanRequest(text)) {
      console.log("[agent-router] human shortcut triggered");
      return await handleHumanShortcut(msg);
    }

    // ─── STEP 1: Kill switch ──────────────────────────────────────
    const disabled = await isAgentDisabled();
    if (disabled) {
      console.log("[agent-router] kill switch active, sending canned response");
      // Try to detect language for the canned message; fallback to bilingual
      const lang = detectLanguage(text, fromE164).language;
      const message =
        lang === "ES"
          ? TEMPLATES.kill_switch_es()
          : lang === "EN"
            ? TEMPLATES.kill_switch_en()
            : TEMPLATES.greet_bilingual();   // unknown → bilingual short
      await sendAndRecord({ to: from, text: message, clientName: "Liam (high demand)" });
      return;
    }

    // ─── STEP 2: Existing client lookup ───────────────────────────
    const existingClient = await lookupExistingClient(from);

    // ─── STEP 3: Active conversation? ─────────────────────────────
    const existingConv = await getActiveConversation(from);

    // Branch A: paused (human took over) — agent stays silent
    if (existingConv?.paused_by_human) {
      console.log("[agent-router] conversation paused by human, agent silent");
      await updateConversationOnUserMessage(existingConv.id);
      return;
    }

    // ─── STEP 3.5: MEDIA GUARD ────────────────────────────────────
    // Added 2026-07-31. The webhook persists non-text messages as a
    // literal placeholder ("[image]", "[audio]", ...) in `body`. Without
    // this branch the router feeds that string into the capture flow and
    // tries to validate "[image]" as an email address — which is exactly
    // how a client ended up with ten identical "invalid email" replies.
    // Liam cannot see the file, so the only honest move is: acknowledge,
    // flag for a human, and stop.
    if (isMediaPlaceholder(text)) {
      const kind = mediaKind(text);
      console.log(`[agent-router] media message (${kind}) — acknowledging, no slot-filling`);

      const lang = (existingConv?.language || detectLanguage(text, fromE164).language || "en").toUpperCase();
      const ack = lang === "ES" ? TEMPLATES.media_ack_es(kind) : TEMPLATES.media_ack_en(kind);

      await sendOnce({ to: from, text: ack, clientName: "Liam" });

      if (existingConv) {
        await updateConversationOnUserMessage(existingConv.id);
        await resetRetry(existingConv.id);
        if (!existingConv.handoff_required) {
          await markHandoff(existingConv.id, `media_received_${kind}`, existingConv.state);
        }
      }
      return;
    }

    // ─── STEP 3.6: CLOSING GUARD ──────────────────────────────────
    // "Gracias" / "Ok" / "Me quedó claro" are conversation enders, not
    // answers to whatever slot we are waiting on. Acknowledge once and
    // stay quiet — never re-ask, never re-send the menu.
    if (existingConv && isClosing(text)) {
      console.log("[agent-router] closing phrase detected — soft acknowledgment, no re-ask");
      const lang = (existingConv.language || "en").toUpperCase();
      const bye = lang === "ES" ? TEMPLATES.closing_ack_es() : TEMPLATES.closing_ack_en();
      await sendOnce({ to: from, text: bye, clientName: "Liam" });
      await updateConversationOnUserMessage(existingConv.id);
      await resetRetry(existingConv.id);
      return;
    }

    // ─── STEP 3.7: VISIT GUARD ────────────────────────────────────
    // Added 2026-08-11 after Liam offered a prospect a next-day tour of
    // the Doral facility and handed him the Discovery Call link labelled
    // as "your visit". FR-Logistics does NOT receive prospects on site —
    // first contact is always the remote Discovery Call, and any on-site
    // visit is Jose's call, made personally, never promised in chat.
    // This runs BEFORE the FAQ matcher and before the LLM on purpose:
    // it is deterministic, so it cannot be talked around by a model that
    // is trying to be helpful.
    if (existingConv && isVisitRequest(text)) {
      const lang = (existingConv.language || detectLanguage(text, fromE164).language || "en").toUpperCase();
      console.log(`[agent-router] visit request detected — policy reply, no LLM (conv=${existingConv.id})`);

      const reply = existingClient
        ? visitReplyClient(lang)
        : visitPolicyText(lang);

      await sendOnce({ to: from, text: reply, clientName: "Liam" });
      await updateConversationOnUserMessage(existingConv.id);
      await resetRetry(existingConv.id);

      // Someone asking to come see the warehouse is a live lead. Flag it
      // so it surfaces in the inbox — but do NOT pause: Liam can still
      // answer the rest of their questions.
      if (!existingConv.handoff_required) {
        await markHandoff(existingConv.id, "visit_request", existingConv.state);
      }
      return;
    }

    // Branch B: active conversation in pending_language state
    //   → user is replying to bilingual greeting with EN/ES choice
    if (existingConv?.state === "pending_language") {
      return await handlePendingLanguageReply(existingConv, msg);
    }

    // Branch C: active conversation in greeted state
    //   → user is replying to menu (1-5)
    if (existingConv?.state === "greeted") {
      return await handleMenuReply(existingConv, msg);
    }

    // Branch C2: active conversation in qualifying state (Sprint 2)
    //   → user is answering a qualification question
    if (existingConv?.state === "qualifying") {
      return await handleQualifyReply(existingConv, msg);
    }

    // Branch D: active conversation in handoff_jose state
    //   → Day 3: capture name + email, then email info@
    if (existingConv?.state === "handoff_jose") {
      return await handleHandoffCapture(existingConv, msg);
    }

    // Branch D2: handoff already completed (handoff_email or completed)
    //   → soft acknowledgment, no further automated action
    if (existingConv && ["handoff_email", "completed"].includes(existingConv.state)) {
      console.log(`[agent-router] conv already in terminal state '${existingConv.state}', acknowledging silently`);
      await updateConversationOnUserMessage(existingConv.id);
      return;
    }

    // Branch D3: active conversation in another state (qualifying, etc.)
    //   → Sprint 2+ will handle these. For Sprint 1: silent, just log.
    if (existingConv) {
      console.log(`[agent-router] conv in state '${existingConv.state}', Sprint 1 does not handle yet`);
      await updateConversationOnUserMessage(existingConv.id);
      return;
    }

    // Branch E: NEW conversation
    //   → existing client path: simple acknowledgment, no qualification
    if (existingClient) {
      return await handleNewExistingClientMessage(existingClient, msg);
    }

    // Branch F: NEW conversation, NEW lead
    return await handleNewLeadMessage(msg);

  } catch (err) {
    // Safety net — NEVER let the router throw, webhook already returned 200
    console.error("[agent-router] uncaught error:", err?.message || err);
  }
}

// ─────────────────────────────────────────────────────────────────────
// HANDLER: existing client sends first message
// Sprint 1: polite acknowledgment in their preferred language. No qualif.
// (Full client operational flow is v2 / Sprint 7+.)
// ─────────────────────────────────────────────────────────────────────
async function handleNewExistingClientMessage(existingClient, msg) {
  const { from, text, clientName } = msg;
  const fromE164 = phonePrefixOf(from);

  // Use stored preferred_language if available; otherwise detect
  let language = existingClient.preferredLanguage;   // 'ES' | 'EN' | null
  let languageSource = "client_preference";

  if (!language || (language !== "ES" && language !== "EN")) {
    const detected = detectLanguage(text, fromE164);
    language = detected.language === "UNKNOWN" ? "EN" : detected.language;
    languageSource = detected.source || "fallback";
  }

  const conv = await createConversation({
    waNumber: from,
    waProfileName: clientName,
    firstMessage: text,
    language,
    languageSource,
    isExistingClient: true,
    clientId: existingClient.clientId,
  });
  if (!conv) return;

  const message =
    language === "ES"
      ? TEMPLATES.existing_client_redirect_es(existingClient.clientName)
      : TEMPLATES.existing_client_redirect_en(existingClient.clientName);

  const send = await sendAndRecord({
    to: from,
    text: message,
    clientName: "Liam",
  });

  if (send.ok) {
    // Existing clients don't go through qualification flow — mark completed
    await recordAgentMessage(conv.id, "completed");
  }
}

// ─────────────────────────────────────────────────────────────────────
// HANDLER: human shortcut — user typed "humano"/"human"/"hablar con jose"
// Works from ANY state. If conversation exists, transitions to handoff_jose
// and starts capture. If no conversation, creates new one straight in handoff_jose.
// ─────────────────────────────────────────────────────────────────────
async function handleHumanShortcut(msg) {
  const { from, text, clientName } = msg;
  const fromE164 = phonePrefixOf(from);

  // Look up existing conversation (any state, not just active)
  const existingConv = await getActiveConversation(from);

  // Detect language from this message or use existing conv's
  let language;
  if (existingConv?.language) {
    language = existingConv.language.toUpperCase();
  } else {
    const d = detectLanguage(text, fromE164);
    language = d.language === "UNKNOWN" ? "EN" : d.language;
  }

  // If conversation exists, transition it to handoff
  if (existingConv) {
    // If already in handoff capture, treat this as normal capture message
    if (existingConv.state === "handoff_jose") {
      return await handleHandoffCapture(existingConv, msg);
    }

    // Otherwise transition to handoff_jose
    await updateConversationOnUserMessage(existingConv.id);
    await markHandoff(existingConv.id, "human_shortcut", "handoff_jose");

    const ack =
      language === "ES"
        ? TEMPLATES.handoff_jose_ack_es()
        : TEMPLATES.handoff_jose_ack_en();
    const send = await sendAndRecord({ to: from, text: ack, clientName: "Liam" });
    if (send.ok) {
      await recordAgentMessage(existingConv.id, "handoff_jose");
      await setSubStateAndService(existingConv.id, "awaiting_name", "jose_handoff");
    }
    return;
  }

  // No conversation — create one straight in handoff_jose
  // El STEP 0 (atajo humano) corre antes del lookup de cliente del STEP 2,
  // asi que esta rama necesita consultarlo por su cuenta. Sin esto, un
  // cliente activo que escribe "hablar con Jose" se registra como lead nuevo.
  const existingClient = await lookupExistingClient(from);

  const conv = await createConversation({
    waNumber: from,
    waProfileName: clientName,
    firstMessage: text,
    language,
    languageSource: existingConv?.language ? "existing_conv" : "text_detect",
    isExistingClient: !!existingClient,
    clientId: existingClient?.clientId || null,
  });
  if (!conv) return;

  // Lead row solo si NO es un cliente existente
  if (!existingClient) {
    const leadId = await createLeadFromConversation({
      waNumber: from,
      waProfileName: clientName,
      language: language.toLowerCase(),
      firstMessage: text,
    });
    if (leadId) await linkConversationToLead(conv.id, leadId);
  }

  await markHandoff(conv.id, "human_shortcut", "handoff_jose");

  const ack =
    language === "ES"
      ? TEMPLATES.handoff_jose_ack_es()
      : TEMPLATES.handoff_jose_ack_en();
  const send = await sendAndRecord({ to: from, text: ack, clientName: "Liam" });
  if (send.ok) {
    await recordAgentMessage(conv.id, "handoff_jose");
    await setSubStateAndService(conv.id, "awaiting_name", "jose_handoff");
  }
}

// ─────────────────────────────────────────────────────────────────────
// HANDLER: new lead, first message ever
// Detect language → greet OR bilingual prompt.
// ─────────────────────────────────────────────────────────────────────
async function handleNewLeadMessage(msg) {
  const { from, text, clientName } = msg;
  const fromE164 = phonePrefixOf(from);

  const detected = detectLanguage(text, fromE164);
  // detected.language: 'ES' | 'EN' | 'UNKNOWN'

  const lang = detected.language === "UNKNOWN" ? null : detected.language;
  const source = detected.source;

  // Create conversation (with language if known, null if UNKNOWN)
  const conv = await createConversation({
    waNumber: from,
    waProfileName: clientName,
    firstMessage: text,
    language: lang,
    languageSource: source,
    isExistingClient: false,
    clientId: null,
  });
  if (!conv) return;

  // Create lead row and link
  const leadId = await createLeadFromConversation({
    waNumber: from,
    waProfileName: clientName,
    language: lang || "en",
    firstMessage: text,
  });
  if (leadId) {
    await linkConversationToLead(conv.id, leadId);
  }

  // Send appropriate greeting
  let greeting;
  let nextState;
  if (lang === "ES") {
    greeting = TEMPLATES.greet_es();
    nextState = "greeted";
  } else if (lang === "EN") {
    greeting = TEMPLATES.greet_en();
    nextState = "greeted";
  } else {
    greeting = TEMPLATES.greet_bilingual();
    nextState = "pending_language";
  }

  const send = await sendAndRecord({
    to: from,
    text: greeting,
    clientName: "Liam",
  });

  if (send.ok) {
    await recordAgentMessage(conv.id, nextState);
  }
}

// ─────────────────────────────────────────────────────────────────────
// HANDLER: user replied to bilingual greeting
// Parse their choice → confirm and show menu.
// ─────────────────────────────────────────────────────────────────────
async function handlePendingLanguageReply(conv, msg) {
  const { from, text } = msg;

  // Update message_count and last_user_message_at
  await updateConversationOnUserMessage(conv.id);

  const choice = parseLanguageChoice(text);

  // Couldn't parse → retry once
  if (!choice) {
    // Check if we've already retried — if so, default to EN
    // (We use message_count as proxy: if >=4 messages exchanged, give up)
    if (conv.message_count >= 3) {
      const send = await sendAndRecord({
        to: from,
        text: TEMPLATES.fallback_to_en(),
        clientName: "Liam",
      });
      if (send.ok) {
        await recordAgentMessage(conv.id, "greeted");
        await updateConversationLanguage(conv.id, "en", "fallback");
      }
      return;
    }

    // First retry
    const send = await sendAndRecord({
      to: from,
      text: TEMPLATES.retry_language_choice(),
      clientName: "Liam",
    });
    if (send.ok) {
      await recordAgentMessage(conv.id);  // stay in pending_language
    }
    return;
  }

  // Got a clear choice — confirm + show menu
  const confirmation =
    choice === "ES" ? TEMPLATES.confirm_es() : TEMPLATES.confirm_en();

  const send = await sendAndRecord({
    to: from,
    text: confirmation,
    clientName: "Liam",
  });

  if (send.ok) {
    await recordAgentMessage(conv.id, "greeted");
    await updateConversationLanguage(conv.id, choice.toLowerCase(), "user_choice");
  }
}

// ─────────────────────────────────────────────────────────────────────
// HANDLER: user replied to greeting menu (1-5)
// Sprint 1: only handle option 5 (Jose handoff). Options 1-4 acknowledge
// but defer the real qualification to Sprint 2.
// ─────────────────────────────────────────────────────────────────────
async function handleMenuReply(conv, msg) {
  const { from, text } = msg;
  const language = (conv.language || "en").toUpperCase();  // 'ES' | 'EN'

  await updateConversationOnUserMessage(conv.id);

  const choice = parseMenuChoice(text);

  // Option 5 — Jose handoff (FULLY implemented in Sprint 1)
  if (choice === "jose_handoff") {
    const ack =
      language === "ES"
        ? TEMPLATES.handoff_jose_ack_es()
        : TEMPLATES.handoff_jose_ack_en();

    const send = await sendAndRecord({
      to: from,
      text: ack,
      clientName: "Liam",
    });

    if (send.ok) {
      await recordAgentMessage(conv.id, "handoff_jose");
      await markHandoff(conv.id, "user_request_jose", "handoff_jose");
      // Day 3: enter capture flow waiting for name
      await setSubStateAndService(conv.id, "awaiting_name", "jose_handoff");
    }
    return;
  }

  // Options 1-4 — services. Sprint 2: enter qualification flow.
  if (choice && ["fba_prep", "master_case", "dropship", "ecopack"].includes(choice)) {
    // Send intro template for the chosen service
    const introKey = `qualify_intro_${choice}`;
    const introMsg =
      language === "ES"
        ? TEMPLATES[`${introKey}_es`]()
        : TEMPLATES[`${introKey}_en`]();

    const sendIntro = await sendAndRecord({
      to: from,
      text: introMsg,
      clientName: "Liam",
    });

    if (!sendIntro.ok) {
      console.error("[router] failed to send qualify intro, aborting");
      return;
    }

    // Send Q1 immediately after the intro
    const q1 = getQuestionByIndex(choice, 1);
    const q1Msg = language === "ES" ? q1.prompts.es : q1.prompts.en;
    const sendQ1 = await sendAndRecord({
      to: from,
      text: q1Msg,
      clientName: "Liam",
    });

    if (sendQ1.ok) {
      // Transition: state = 'qualifying', sub_state = 'awaiting_q1', captured_service = choice
      await recordAgentMessage(conv.id, "qualifying");
      await setSubStateAndService(conv.id, "awaiting_q1", choice);
    }
    return;
  }

  // ───────────────────────────────────────────────────────────────
  // Sprint 3: free-text reply (not 1-5) — try FAQ match before re-asking
  // ───────────────────────────────────────────────────────────────
  const langLower = language.toLowerCase();
  const faqHit = await matchFAQ(text, langLower);

  if (faqHit) {
    console.log(`[router] FAQ matched in greeted state: id=${faqHit.id} score=${faqHit.score} q="${getFAQQuestion(faqHit, langLower)}"`);

    const answer = getFAQAnswer(faqHit, langLower);
    const sendAns = await sendAndRecord({ to: from, text: answer, clientName: "Liam" });
    if (!sendAns.ok) {
      console.error("[router] FAQ answer send failed");
      return;
    }

    // After the FAQ answer, offer the menu — but with DECAY.
    // Full menu once, then a one-liner, then nothing. Re-sending the full
    // block after every answer is what made Liam read as spam: 11 people
    // received the identical menu 3-9 times in a single day.
    const followup = await buildFollowup(conv.id, language);
    if (followup) {
      const sendMenu = await sendOnce({ to: from, text: followup, clientName: "Liam" });
      if (sendMenu.ok && !sendMenu.suppressed) await recordAgentMessage(conv.id);
    }
    await updateConversationFAQHit(conv.id, faqHit.id);
    return;
  }

  // ───────────────────────────────────────────────────────────────
  // Sprint 4: FAQ matcher didn't find a strong match. Try LLM.
  // LLM is invisible to the lead — same Liam voice.
  // If LLM is gated (kill switch) or errors, fall through to re-ask.
  // ───────────────────────────────────────────────────────────────
  
  // Build LLM context: top 3 FAQ candidates + lead data + history
  const llmTopFAQs = await topNFAQs(text, langLower, 3);
  const llmHistory = await loadRecentHistory(from, 5);
  const llmLeadData = {
    name:       conv.captured_name || null,
    email:      conv.captured_email || null,
    service:    conv.captured_service || null,
    volume:     conv.captured_volume || conv.captured_volume_raw || null,
    country:    conv.captured_country || conv.captured_country_raw || null,
    platforms:  conv.captured_platforms || conv.captured_platforms_raw || null,
  };

  const llmResult = await askLLM({
    userMessage: text,
    language: langLower,
    history: llmHistory,
    faqContext: llmTopFAQs,
    leadData: llmLeadData,
    conversationId: conv.id,
    waNumber: from,
  });

  if (llmResult.text) {
    // Backstop for the visit policy. STEP 3.7 catches the question; this
    // catches the answer — an LLM can drift into offering a tour while
    // replying to something else entirely (it did exactly that on
    // 2026-08-11: "Jose is the one who coordinates visits to our Doral
    // facility"). If the draft offers a visit, the whole reply is
    // replaced by the policy text rather than edited.
    const llmText = stripVisitOffer(llmResult.text, language);

    // LLM produced a reply — send it, then re-offer menu (Sprint 3 pattern)
    const sendLlm = await sendAndRecord({ to: from, text: llmText, clientName: "Liam" });
    if (!sendLlm.ok) {
      console.error("[router] LLM reply send failed");
      return;
    }

    // Offer the menu with the same decay rule as the FAQ path.
    const followup = await buildFollowup(conv.id, language);
    if (followup) {
      const sendMenu = await sendOnce({ to: from, text: followup, clientName: "Liam" });
      if (sendMenu.ok && !sendMenu.suppressed) await recordAgentMessage(conv.id);
    }
    return;
  }

  console.log(`[router] LLM unavailable (reason=${llmResult.reason}), falling back to re-ask`);

  // LLM not available — gentle re-ask (original Sprint 3 fallback)
  const retry =
    language === "ES"
      ? "No te entendí 🤔 Responde 1, 2, 3, 4 o 5 para continuar."
      : "Didn't catch that 🤔 Reply 1, 2, 3, 4 or 5 to continue.";

  const send = await sendAndRecord({ to: from, text: retry, clientName: "Liam" });
  if (send.ok) {
    await recordAgentMessage(conv.id);  // stay in greeted
  }
}

// Returns the follow-up text for this conversation, or null when the menu
// has already been shown enough times. Full menu → short nudge → silence.
async function buildFollowup(conversationId, language) {
  const mode = await nextMenuMode(conversationId);
  if (mode === MENU_FULL) {
    return language === "ES"
      ? TEMPLATES.faq_followup_menu_es()
      : TEMPLATES.faq_followup_menu_en();
  }
  if (mode === MENU_SHORT) {
    return language === "ES"
      ? TEMPLATES.faq_followup_short_es()
      : TEMPLATES.faq_followup_short_en();
  }
  return null;  // already nudged twice — say nothing
}

// Load the last N user/assistant messages from wa_messages for LLM context.
// Se filtra por la DIRECCION en from_number/to_number, que ahora puede ser
// un numero, "web:<sesion>" o "ig:<IGSID>" — el filtro es el mismo para los
// tres porque el canal ya viene embebido en el valor.
async function loadRecentHistory(waNumber, n = 5) {
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      { auth: { persistSession: false } }
    );
    // Inbound = from lead; outbound = from Liam. Filter by the lead's number on
    // either side of the conversation. Last N*2 messages, then take last N
    // (oldest first for LLM context).
    const { data, error } = await sb
      .from("wa_messages")
      .select("direction, body, from_number, to_number, timestamp")
      .or(`from_number.eq.${waNumber},to_number.eq.${waNumber}`)
      .order("timestamp", { ascending: false })
      .limit(n * 2);

    if (error || !data) return [];

    return data
      .reverse()
      .map(m => ({
        role: m.direction === "inbound" ? "user" : "assistant",
        text: m.body || "",
      }))
      .filter(m => m.text)
      .slice(-n);
  } catch (e) {
    console.log(`[router] history load failed: ${e.message}`);
    return [];
  }
}

// Lightweight audit — track the last FAQ Liam served (if column exists)
// Soft-fail if the column isn't there yet (migration optional).
async function updateConversationFAQHit(conversationId, faqId) {
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      { auth: { persistSession: false } }
    );
    await sb
      .from("wa_agent_conversations")
      .update({ last_faq_id: faqId })
      .eq("id", conversationId);
  } catch (e) {
    // Column may not exist yet — non-fatal, audit only
    console.log(`[router] last_faq_id update skipped: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────

// Devuelve la direccion en E.164 SOLO si el canal es telefonico.
// detectLanguage() usa el prefijo de pais como pista; alimentarlo con los
// digitos sueltos de un uuid de sesion web daria un idioma al azar.
function phonePrefixOf(address) {
  const addr = parseAddress(address);
  if (addr.channel !== "whatsapp" || !addr.waNumber) return "";
  return `+${addr.waNumber}`;
}

function labelService(key, lang) {
  const map = {
    fba_prep:    { ES: "FBA Prep",        EN: "FBA Prep" },
    master_case: { ES: "Master Case",     EN: "Master Case" },
    dropship:    { ES: "Dropshipment",    EN: "Dropshipment" },
    ecopack:     { ES: "EcoPack+",        EN: "EcoPack+" },
  };
  return map[key]?.[lang] || key;
}

// Direct DB update for language (used after pending_language is resolved)
async function updateConversationLanguage(conversationId, lang, source) {
  // Inline because wa-agent-db doesn't export this specific helper
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );
  await sb
    .from("wa_agent_conversations")
    .update({ language: lang, language_source: source })
    .eq("id", conversationId);
}

// Sets sub_state + captured_service in one call (Day 3 capture flow)
async function setSubStateAndService(conversationId, subState, service) {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );
  await sb
    .from("wa_agent_conversations")
    .update({ sub_state: subState, captured_service: service })
    .eq("id", conversationId);
}

// Sets just sub_state
async function setSubState(conversationId, subState) {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );
  await sb
    .from("wa_agent_conversations")
    .update({ sub_state: subState })
    .eq("id", conversationId);
}

// Updates captured name + email on the conversation
// Reject junk names before they become the chat title. captured_name has
// stored whole pasted paragraphs ("Sure! My name is X and my email is...")
// which the inbox then shows as the conversation title. A real name is
// short: <=40 chars, <=4 words, no @, no line breaks, no "?" and no long
// digit runs. When the value isn't a plausible name we skip it (keep any
// existing name) rather than overwrite with garbage.
function isPlausibleName(raw) {
  // Delegates to the capture module so the router and the parser can never
  // disagree about what a name is.
  return looksLikeName(String(raw || "").trim());
}

async function setCapturedNameEmail(conversationId, name, email) {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );
  const patch = {};
  if (name && isPlausibleName(name)) patch.captured_name = name;
  else if (name) console.log(`[router] setCapturedNameEmail: rejected junk name for conv ${conversationId}`);
  if (email) patch.captured_email = email;
  if (Object.keys(patch).length === 0) return;
  await sb
    .from("wa_agent_conversations")
    .update(patch)
    .eq("id", conversationId);
}

// Updates the linked wa_leads row with real name + email (replacing placeholder)
async function updateLeadFromCapture(leadId, { name, email }) {
  if (!leadId) return;
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );
  const patch = {};
  // Same guard as setCapturedNameEmail. Without it wa_leads.name accepted
  // whatever the parser returned, which is how entire messages ended up as
  // lead names while wa_agent_conversations stayed clean.
  if (name && isPlausibleName(name)) patch.name = name;
  else if (name) console.log(`[router] updateLeadFromCapture: rejected junk name for lead ${leadId}`);
  if (email) patch.email = email;
  if (Object.keys(patch).length === 0) return;
  await sb
    .from("wa_leads")
    .update(patch)
    .eq("id", leadId);
}

// Marks the email_sent_at timestamp (idempotency: don't email twice)
async function markInfoEmailSent(conversationId) {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );
  await sb
    .from("wa_agent_conversations")
    .update({
      info_email_sent_at: new Date().toISOString(),
      sub_state: "completed",
      state: "handoff_email",
    })
    .eq("id", conversationId);
}

// ─────────────────────────────────────────────────────────────────────
// HANDLER: capture flow — user is in handoff_jose state
// We track sub_state: 'awaiting_name' → 'awaiting_email' → completed.
// ─────────────────────────────────────────────────────────────────────
async function handleHandoffCapture(conv, msg) {
  const { from, text } = msg;
  const language = (conv.language || "en").toUpperCase();

  await updateConversationOnUserMessage(conv.id);

  // Cancellation → graceful exit, partial email if any data captured
  if (isCancellation(text)) {
    const farewell =
      language === "ES"
        ? "Entendido. Si cambias de opinión, escríbeme cuando quieras."
        : "Got it. If you change your mind, message me anytime.";
    await sendAndRecord({ to: from, text: farewell, clientName: "Liam" });

    // Send partial-info email so Jose knows someone reached out
    if (!conv.info_email_sent_at) {
      await sendHandoffEmail({
        waNumber: from,
        name: conv.captured_name || msg.clientName || "Lead (no name)",
        email: conv.captured_email || "(no proporcionado)",
        language: language.toLowerCase(),
        serviceInterest: conv.captured_service || "other",
        firstMessage: conv.first_message || "",
        handoffReason: `${conv.handoff_reason || "user_request_jose"}_cancelled_capture`,
        conversationId: conv.id,
      });
      await markInfoEmailSent(conv.id);
    }
    return;
  }

  // Try to extract both name and email from the message at once
  const both = extractBoth(text);

  // ─── SUB-STATE: awaiting_name ───────────────────────────────────
  if (!conv.sub_state || conv.sub_state === "awaiting_name") {
    // If user sent ONLY an email (no name yet), capture email and ask for name
    if (both.email && !both.name) {
      await setCapturedNameEmail(conv.id, null, both.email);
      const askName =
        language === "ES"
          ? `Gracias. Solo me falta tu nombre, ¿cuál es?`
          : `Thanks. I just need your name now — what is it?`;
      const send = await sendAndRecord({ to: from, text: askName, clientName: "Liam" });
      if (send.ok) {
        await recordAgentMessage(conv.id);
        await setSubState(conv.id, "awaiting_name_after_email");
      }
      return;
    }

    // If user sent BOTH name and email in one message — jackpot, finish
    if (both.name && both.email) {
      await setCapturedNameEmail(conv.id, both.name, both.email);
      await updateLeadFromCapture(conv.lead_id, { name: both.name, email: both.email });
      return await completeHandoff(conv, msg, both.name, both.email);
    }

    // Only a name? Save it and ask for email
    if (both.name) {
      await resetRetry(conv.id);
      await setCapturedNameEmail(conv.id, both.name, null);
      await updateLeadFromCapture(conv.lead_id, { name: both.name });
      const askEmail =
        language === "ES"
          ? TEMPLATES.handoff_jose_ask_email_es(both.name)
          : TEMPLATES.handoff_jose_ask_email_en(both.name);
      const send = await sendAndRecord({ to: from, text: askEmail, clientName: "Liam" });
      if (send.ok) {
        await recordAgentMessage(conv.id);
        await setSubState(conv.id, "awaiting_email");
      }
      return;
    }

    // Couldn't extract anything → re-ask politely, AT MOST twice.
    const triesName = await bumpRetry(conv.id);
    if (maxedOut(triesName)) {
      return await escalateToHuman(conv, msg, language, "name_capture_failed");
    }
    const reAsk =
      language === "ES"
        ? "¿Puedes darme tu nombre completo, por favor?"
        : "Could you share your full name, please?";
    const send = await sendOnce({ to: from, text: reAsk, clientName: "Liam" });
    if (send.ok && !send.suppressed) await recordAgentMessage(conv.id);
    return;
  }

  // ─── SUB-STATE: awaiting_name_after_email ───────────────────────
  // We already have email, just need name
  if (conv.sub_state === "awaiting_name_after_email") {
    if (both.name) {
      await setCapturedNameEmail(conv.id, both.name, null);
      await updateLeadFromCapture(conv.lead_id, { name: both.name });
      return await completeHandoff(conv, msg, both.name, conv.captured_email);
    }

    const triesAfter = await bumpRetry(conv.id);
    if (maxedOut(triesAfter)) {
      return await escalateToHuman(conv, msg, language, "name_capture_failed");
    }
    const reAsk =
      language === "ES"
        ? "Solo necesito tu nombre, ¿puedes escribírmelo?"
        : "I just need your name — could you type it out?";
    const send = await sendOnce({ to: from, text: reAsk, clientName: "Liam" });
    if (send.ok && !send.suppressed) await recordAgentMessage(conv.id);
    return;
  }

  // ─── SUB-STATE: awaiting_email ──────────────────────────────────
  if (conv.sub_state === "awaiting_email") {
    if (both.email && isValidEmail(both.email)) {
      await resetRetry(conv.id);
      await setCapturedNameEmail(conv.id, null, both.email);
      await updateLeadFromCapture(conv.lead_id, { email: both.email });
      return await completeHandoff(conv, msg, conv.captured_name, both.email);
    }

    // No email or invalid format — re-ask, but AT MOST twice.
    // This is the loop that sent one client ten identical replies on
    // 2026-07-31: she was asking an operational question, not giving an
    // email, and every single message got the same validation error.
    const tries = await bumpRetry(conv.id);
    if (maxedOut(tries)) {
      return await escalateToHuman(conv, msg, language, "email_capture_failed");
    }

    const reAsk =
      language === "ES"
        ? "No reconozco eso como un email válido. ¿Puedes verificarlo? (ej. nombre@empresa.com)"
        : "I don't recognize that as a valid email. Could you double-check? (e.g. name@company.com)";
    const send = await sendOnce({ to: from, text: reAsk, clientName: "Liam" });
    if (send.ok && !send.suppressed) await recordAgentMessage(conv.id);
    return;
  }

  // ─── SUB-STATE: completed or unknown ────────────────────────────
  // Already finished capture — just acknowledge and stay silent
  console.log(`[agent-router] handoff_jose with sub_state '${conv.sub_state}' — no action`);
}

// ─────────────────────────────────────────────────────────────────────
// HANDLER: qualification flow — user is in state='qualifying'
// Tracks sub_state: awaiting_q1 → awaiting_q2 → awaiting_q3 → 
//   transition to handoff_jose with sub_state='awaiting_name'
// Cancellation at any point → graceful exit + partial email to info@
// Human shortcut at any point → already handled by STEP 0 in router
// ─────────────────────────────────────────────────────────────────────
async function handleQualifyReply(conv, msg) {
  const { from, text } = msg;
  const language = (conv.language || "en").toUpperCase();
  const service = conv.captured_service;

  await updateConversationOnUserMessage(conv.id);

  // Cancellation — partial email, graceful exit
  if (isCancellation(text)) {
    const farewell =
      language === "ES"
        ? "Entendido. Si cambias de opinión, escríbeme cuando quieras."
        : "Got it. If you change your mind, message me anytime.";
    await sendAndRecord({ to: from, text: farewell, clientName: "Liam" });

    if (!conv.info_email_sent_at) {
      const summary = buildQualificationSummary(conv);
      await sendHandoffEmail({
        waNumber: from,
        name: conv.captured_name || msg.clientName || "Lead (no name)",
        email: conv.captured_email || "(no proporcionado)",
        language: language.toLowerCase(),
        serviceInterest: service || "other",
        firstMessage: conv.first_message || "",
        handoffReason: `${service}_cancelled_qualify`,
        conversationId: conv.id,
        qualification: summary,
      });
      await markInfoEmailSent(conv.id);
    }
    return;
  }

  // Determine which question we're answering
  const subState = conv.sub_state || "awaiting_q1";
  if (!subState.startsWith("awaiting_q")) {
    console.error(`[router] unexpected sub_state '${subState}' in qualifying`);
    return;
  }
  const currentIdx = parseInt(subState.replace("awaiting_q", ""), 10);
  const currentQuestion = getQuestionByIndex(service, currentIdx);
  if (!currentQuestion) {
    console.error(`[router] no question at index ${currentIdx} for service ${service}`);
    return;
  }

  // Parse the reply: { normalized, raw }
  const { normalized, raw } = parseQualifyReply(text, currentQuestion);

  // Persist the answer (both normalized and raw)
  await saveQualifyField(conv.id, currentQuestion.field, currentQuestion.rawField, normalized, raw);

  // Get the next question (or null if sequence complete)
  const nextQuestion = getNextQuestion(service, subState);

  if (nextQuestion) {
    // Send next question
    const nextMsg = language === "ES" ? nextQuestion.prompts.es : nextQuestion.prompts.en;
    const send = await sendAndRecord({ to: from, text: nextMsg, clientName: "Liam" });
    if (send.ok) {
      await recordAgentMessage(conv.id);
      await setSubState(conv.id, `awaiting_${nextQuestion.id}`);
    }
    return;
  }

  // Sequence complete → bridge to contact capture
  const doneMsg =
    language === "ES" ? TEMPLATES.qualify_done_es() : TEMPLATES.qualify_done_en();
  const send = await sendAndRecord({ to: from, text: doneMsg, clientName: "Liam" });
  if (send.ok) {
    await recordAgentMessage(conv.id, "handoff_jose");
    await markHandoff(conv.id, `qualified_${service}`, "handoff_jose");
    await setSubState(conv.id, "awaiting_name");
  }
}

// DB helper — save a captured qualify field + its _raw companion
async function saveQualifyField(conversationId, field, rawField, normalizedValue, rawValue) {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );
  const patch = {};
  if (normalizedValue !== null && normalizedValue !== undefined) {
    patch[field] = normalizedValue;
  }
  if (rawValue) {
    patch[rawField] = rawValue;
  }
  if (Object.keys(patch).length === 0) return;
  await sb
    .from("wa_agent_conversations")
    .update(patch)
    .eq("id", conversationId);
}

// Final step of the capture flow: send confirmation + email info@
// ─────────────────────────────────────────────────────────────────────
// ESCALATION (added 2026-07-31)
// ─────────────────────────────────────────────────────────────────────
// VISIT POLICY (added 2026-08-11)
//
// Business rule, from Jose: FR-Logistics does not receive any client or
// prospect on site on first contact — and never next-day. First contact
// is ALWAYS the remote Discovery Call. An on-site visit is not a
// decision made up front; it can come up during that call, and only
// Jose Fuentes handles it, personally. Liam never offers one.
// ─────────────────────────────────────────────────────────────────────

// Unambiguous: the person is asking about coming here in person.
const VISIT_STRONG = [
  /\bvisit(a|as|ar|arlos|arlas|arte|arnos|amos|aremos|ando|[aá]ndolos)\b/i,
  /\bvisit(s|ed|ing)?\b/i,
  /\bwalk[-\s]?ins?\b/i,
  /\bsin\s+cita\b/i,
  /\bcita\s+presencial\b/i,
  /\bpresencial(mente)?\b/i,
  /\ben\s+persona\b/i,
  /\bin\s+person\b/i,
  /\brecorrido\b/i,
  /\btours?\b/i,
  /\bwithout\s+an?\s+appointment\b/i,
  /\b(conocer|ver|visitar)\s+(la|el|su|sus|tu|tus)?\s*(bodega|almac[eé]n|warehouse|instalaciones|operaci[oó]n|oficina|planta)\b/i,
  /\b(ir|pasar|llegar|acercar(me|nos)|venir)\s+(por|a|hasta|al)\s+(la|el|su|sus|tu)?\s*(bodega|almac[eé]n|warehouse|oficina|instalaciones|local|planta)\b/i,
  /\bpuedo\s+(ir|pasar|llegar|venir|visitar|acercarme)\b/i,
  /\bpodemos\s+(ir|pasar|llegar|venir|visitar|acercarnos)\b/i,
  /\b(see|check\s+out)\s+(the|your)\s+(warehouse|facility|operation|place)\b/i,
  /\b(stop|drop|come|swing)\s+by\b/i,
];

// Suggestive but not conclusive — "can you see me tomorrow?" is usually a
// walk-in question here, but it is also how someone asks for service. These
// only fire when the message is NOT about moving freight.
const VISIT_WEAK = [
  /\b(me|nos)\s+(pueden|puede|podr[ií]an|podr[ií]a)\s+atender\b/i,
  /\b(atenderme|atendernos|atendernos)\b/i,
  /\bon[-\s]?site\b/i,
  /\bconocer(los|las|te|nos)\b/i,
  /\bcome\s+(over|in)\b/i,
  /\bmeet\s+in\s+person\b/i,
];

// An active client asking where to send a pallet is not asking for a tour.
const FREIGHT_CONTEXT =
  /\b(env[ií]\w*|enviar|mandar|manda|despach\w*|remit\w*|carga|mercanc[ií]a|shipment|inbound|contenedor|pallet|paquete|caja|tracking|etiqueta|label|fnsku)\b/i;

// Phrases that mean Liam is OFFERING a visit — used to filter LLM drafts.
const VISIT_OFFER = [
  /\bvisita\s+(a\s+)?(nuestras?|las?|tus?|sus?)\s*(instalaciones|oficinas|bodega)\b/i,
  /\bvisita\s+presencial\b/i,
  /\b(coordinar|agendar|programar)\s+(una|la|tu)\s+visita\b/i,
  /\bcoordina\s+las\s+visitas\b/i,
  /\bmostrarte\s+la\s+operaci[oó]n\b/i,
  /\bte\s+esperamos\s+en\s+(la\s+)?(bodega|doral|nuestras)\b/i,
  /\b(schedule|arrange|book|coordinate)\s+(a|your|the)\s+(visit|tour|walkthrough)\b/i,
  /\bin[-\s]person\s+(visit|meeting|tour)\b/i,
  /\bfacility\s+tour\b/i,
  /\bshow\s+you\s+(the|our)\s+(warehouse|facility|operation)\b/i,
];

/**
 * True when the inbound message is asking to come to the facility.
 * Fail-safe by design: a false positive costs one canned (and correct)
 * policy answer; a false negative is what put a prospect on our doorstep.
 */
function isVisitRequest(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.trim();
  if (!t || t.length > 600) return false;

  if (VISIT_STRONG.some((re) => re.test(t))) return true;
  if (FREIGHT_CONTEXT.test(t)) return false;   // freight question, not a tour
  return VISIT_WEAK.some((re) => re.test(t));
}

// The one answer Liam gives about visits. No "maybe later", no "Jose
// coordinates visits" — those are the exact phrasings that created the
// misunderstanding.
function visitPolicyText(language) {
  return (language || "EN").toUpperCase() === "ES"
    ? "El primer contacto siempre es una videollamada de Discovery Call con nuestro equipo 📹\n\n" +
        "No agendamos visitas a nuestras instalaciones por este chat. Nuestra dirección en Doral es el punto de recepción de mercancía de clientes activos, no atendemos walk-ins.\n\n" +
        "Déjame tu nombre y email y nuestro equipo te contacta para coordinar la llamada, donde revisamos tu operación, volúmenes, servicios y costos."
    : "First contact is always a Discovery Call over video with our team 📹\n\n" +
        "We don't schedule on-site appointments through this chat. Our Doral address is the receiving point for active clients' freight — we don't take walk-ins.\n\n" +
        "Share your name and email and our team will reach out to set up the call, where we go over your operation, volumes, services and pricing.";
}

// Same rule for an existing client, minus the sales link: it goes to Jose.
function visitReplyClient(language) {
  return (language || "EN").toUpperCase() === "ES"
    ? "Eso lo coordina nuestro equipo directamente 🤝 Le paso tu mensaje ahora y te confirman por aquí."
    : "That's coordinated by our team directly 🤝 I'm passing your message along now and they'll confirm here.";
}

/**
 * Backstop on generated text. If a draft offers a visit, the entire reply
 * is swapped for the policy text — editing a sentence out of an LLM reply
 * tends to leave the promise implied somewhere else.
 */
function stripVisitOffer(text, language) {
  if (!text) return text;
  if (!VISIT_OFFER.some((re) => re.test(text))) return text;
  console.warn("[agent-router] LLM draft offered a facility visit — replaced with policy text");
  return visitPolicyText(language);
}

// Called when a capture slot has been re-asked MAX_RETRIES times without
// a usable answer. Instead of asking forever, Liam explains himself,
// emails what he has to info@, and goes silent so a human can take over.
//
// Setting paused_by_human here is deliberate: STEP 3 Branch A in
// routeIncomingMessage() already honours that flag, so this single write
// guarantees the agent stops talking to this person immediately.
// ─────────────────────────────────────────────────────────────────────
async function escalateToHuman(conv, msg, language, reason) {
  const { from } = msg;
  console.warn(`[agent-router] ESCALATING to human: conv=${conv.id} reason=${reason}`);

  const note =
    language === "ES"
      ? "Disculpa, creo que no te estoy entendiendo bien. Le paso tu mensaje al equipo para que te responda una persona directamente. 🤝"
      : "Sorry — I don't think I'm understanding you correctly. I'm passing your message to the team so a person can reply directly. 🤝";

  await sendOnce({ to: from, text: note, clientName: "Liam" });

  try {
    if (!conv.info_email_sent_at) {
      await sendHandoffEmail({
        waNumber: from,
        name: conv.captured_name || msg.clientName || "Lead (no name)",
        email: conv.captured_email || "(no proporcionado)",
        language: (language || "en").toLowerCase(),
        serviceInterest: conv.captured_service || "other",
        firstMessage: conv.first_message || "",
        handoffReason: reason,
        conversationId: conv.id,
      });
      await markInfoEmailSent(conv.id);
    }
  } catch (e) {
    console.error(`[agent-router] escalation email failed: ${e.message}`);
  }

  try {
    const { createClient } = await import("@supabase/supabase-js");
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      { auth: { persistSession: false } }
    );
    await sb
      .from("wa_agent_conversations")
      .update({
        handoff_required: true,
        handoff_reason: reason,
        handoff_at: new Date().toISOString(),
        sub_state: "completed",
        paused_by_human: true,
        paused_at: new Date().toISOString(),
        paused_by: "agent_escalation",
        retry_count: 0,
      })
      .eq("id", conv.id);
  } catch (e) {
    console.error(`[agent-router] escalation state update failed: ${e.message}`);
  }
}

async function completeHandoff(conv, msg, name, email) {
  const { from } = msg;
  const language = (conv.language || "en").toUpperCase();

  // 1. Send final confirmation to user
  const done =
    language === "ES"
      ? TEMPLATES.handoff_jose_complete_es(name)
      : TEMPLATES.handoff_jose_complete_en(name);
  await sendAndRecord({ to: from, text: done, clientName: "Liam" });

  // 2. Email info@fr-logistics.net (idempotency check)
  if (!conv.info_email_sent_at) {
    // Refetch conv to get latest captured_* values
    const { createClient } = await import("@supabase/supabase-js");
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      { auth: { persistSession: false } }
    );
    const { data: freshConv } = await sb
      .from("wa_agent_conversations")
      .select("*")
      .eq("id", conv.id)
      .single();
    const summary = freshConv ? buildQualificationSummary(freshConv) : {};

    const emailResult = await sendHandoffEmail({
      waNumber: from,
      name,
      email,
      language: language.toLowerCase(),
      serviceInterest: conv.captured_service || "other",
      firstMessage: conv.first_message || "",
      handoffReason: conv.handoff_reason || "user_request_jose",
      conversationId: conv.id,
      qualification: summary,
    });

    if (emailResult.ok) {
      console.log(`[agent-router] handoff email sent for conv ${conv.id}`);
    } else {
      console.error(`[agent-router] handoff email FAILED for conv ${conv.id}: ${emailResult.error}`);
    }
  } else {
    console.log(`[agent-router] info_email already sent for conv ${conv.id}, skipping`);
  }

  // 3. Mark conversation as completed (state=handoff_email, sub_state=completed)
  //    AND pause the agent. The farewell above has already been sent, so
  //    setting paused_by_human here silences Liam without swallowing the
  //    goodbye. This is the code-level fix for the 2026-08-20 regression:
  //    handoff_required alone never stopped the bot, so Liam and a human
  //    could both message the same prospect. STEP 3 Branch A in the router
  //    honors paused_by_human, so this is what actually enforces silence.
  await markInfoEmailSent(conv.id);
  await pauseConversation(conv.id, "handoff_complete");
}
