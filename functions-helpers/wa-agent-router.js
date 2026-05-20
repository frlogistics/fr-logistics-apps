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

    // Branch D: active conversation in another state (qualifying, handoff_*)
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
    }
    // Capturing name + email in 2 more turns is Sprint 1 Day 3.
    return;
  }

  // Options 1-4 — services. Sprint 1: simple acknowledgment.
  // Sprint 2 will replace this with the full qualification flow.
  if (choice && ["fba_prep", "master_case", "dropship", "ecopack"].includes(choice)) {
    const placeholderMsg =
      language === "ES"
        ? `¡Genial! Para darte la mejor info de ${labelService(choice, "ES")}, te paso con Jose Fuentes.\n\n¿Podés dejarme tu nombre y email así él te contacta?`
        : `Awesome! To give you the best info on ${labelService(choice, "EN")}, I'm connecting you with Jose Fuentes.\n\nCould you share your name and email so he can reach out?`;

    const send = await sendAndRecord({
      to: from,
      text: placeholderMsg,
      clientName: "Liam",
    });

    if (send.ok) {
      await recordAgentMessage(conv.id, "handoff_jose");
      await markHandoff(conv.id, `service_interest_${choice}`, "handoff_jose");
    }
    return;
  }

  // Unparseable reply to menu — gentle re-ask
  const retry =
    language === "ES"
      ? "No te entendí 🤔 Responde 1, 2, 3, 4 o 5 para continuar."
      : "Didn't catch that 🤔 Reply 1, 2, 3, 4 or 5 to continue.";

  const send = await sendAndRecord({ to: from, text: retry, clientName: "Liam" });
  if (send.ok) {
    await recordAgentMessage(conv.id);  // stay in greeted
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
