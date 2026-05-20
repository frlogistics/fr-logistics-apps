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
} from "./wa-agent-db.js";
import { sendAndRecord } from "./wa-agent-send.js";
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
import { matchFAQ, getFAQAnswer, getFAQQuestion } from "./wa-agent-faq-match.js";

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

    const fromE164 = from.startsWith("+") ? from : `+${from}`;

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
  const fromE164 = from.startsWith("+") ? from : `+${from}`;

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
  const fromE164 = from.startsWith("+") ? from : `+${from}`;

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
  const conv = await createConversation({
    waNumber: from,
    waProfileName: clientName,
    firstMessage: text,
    language,
    languageSource: existingConv?.language ? "existing_conv" : "text_detect",
    isExistingClient: false,
    clientId: null,
  });
  if (!conv) return;

  // Create lead row
  const leadId = await createLeadFromConversation({
    waNumber: from,
    waProfileName: clientName,
    language: language.toLowerCase(),
    firstMessage: text,
  });
  if (leadId) await linkConversationToLead(conv.id, leadId);

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
  const fromE164 = from.startsWith("+") ? from : `+${from}`;

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

    // After the FAQ answer, re-offer the menu (decision: Path B — keep lead engaged)
    const followup =
      language === "ES"
        ? TEMPLATES.faq_followup_menu_es()
        : TEMPLATES.faq_followup_menu_en();
    const sendMenu = await sendAndRecord({ to: from, text: followup, clientName: "Liam" });
    if (sendMenu.ok) {
      await recordAgentMessage(conv.id);  // stay in 'greeted'
      // Record which FAQ was served (lightweight audit — no new column needed)
      await updateConversationFAQHit(conv.id, faqHit.id);
    }
    return;
  }

  // No FAQ match either — gentle re-ask
  const retry =
    language === "ES"
      ? "No te entendí 🤔 Responde 1, 2, 3, 4 o 5 para continuar."
      : "Didn't catch that 🤔 Reply 1, 2, 3, 4 or 5 to continue.";

  const send = await sendAndRecord({ to: from, text: retry, clientName: "Liam" });
  if (send.ok) {
    await recordAgentMessage(conv.id);  // stay in greeted
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
async function setCapturedNameEmail(conversationId, name, email) {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );
  const patch = {};
  if (name) patch.captured_name = name;
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
  if (name) patch.name = name;
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

    // Couldn't extract anything → re-ask politely
    const reAsk =
      language === "ES"
        ? "¿Puedes darme tu nombre completo, por favor?"
        : "Could you share your full name, please?";
    const send = await sendAndRecord({ to: from, text: reAsk, clientName: "Liam" });
    if (send.ok) await recordAgentMessage(conv.id);
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

    const reAsk =
      language === "ES"
        ? "Solo necesito tu nombre, ¿puedes escribírmelo?"
        : "I just need your name — could you type it out?";
    const send = await sendAndRecord({ to: from, text: reAsk, clientName: "Liam" });
    if (send.ok) await recordAgentMessage(conv.id);
    return;
  }

  // ─── SUB-STATE: awaiting_email ──────────────────────────────────
  if (conv.sub_state === "awaiting_email") {
    if (both.email && isValidEmail(both.email)) {
      await setCapturedNameEmail(conv.id, null, both.email);
      await updateLeadFromCapture(conv.lead_id, { email: both.email });
      return await completeHandoff(conv, msg, conv.captured_name, both.email);
    }

    // No email or invalid format — re-ask
    const reAsk =
      language === "ES"
        ? "No reconozco eso como un email válido. ¿Puedes verificarlo? (ej. nombre@empresa.com)"
        : "I don't recognize that as a valid email. Could you double-check? (e.g. name@company.com)";
    const send = await sendAndRecord({ to: from, text: reAsk, clientName: "Liam" });
    if (send.ok) await recordAgentMessage(conv.id);
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
  await markInfoEmailSent(conv.id);
}
