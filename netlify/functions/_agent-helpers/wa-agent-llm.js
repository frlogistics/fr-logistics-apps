// netlify/functions/_agent-helpers/wa-agent-llm.js
//
// Claude Haiku 4.5 client for Liam.
// 
// Public API:
//   - askLLM(ctx): returns { text, allowed, reason, cost?, latencyMs? }
//   - shouldRunLLM(): returns { allowed, reason, currentCost, cap }
//
// Design choices:
//   - Direct fetch to api.anthropic.com (no @anthropic-ai/sdk dependency to
//     keep the Netlify Function cold-start small).
//   - Kill switch checked BEFORE every call via SQL function fn_should_run_llm().
//   - Cost recorded immediately after each call via fn_record_llm_spend(),
//     which auto-disables LLM if the cap is reached (L3).
//   - Every call logged to wa_agent_llm_logs with existing schema.
//   - Errors are caught and logged; the router falls back to re-ask gracefully.

import { createClient } from "@supabase/supabase-js";
import { buildSystemPrompt, LLM_PROMPT_VERSION } from "./wa-agent-llm-prompt.js";

// ─────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────

const MODEL_ID = "claude-haiku-4-5-20251001";   // dated model for production stability
const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Pricing (USD per million tokens) — Haiku 4.5 as of May 2026
const PRICE_PER_M_INPUT = 1.00;
const PRICE_PER_M_OUTPUT = 5.00;

const MAX_TOKENS_OUT = 600;          // WhatsApp replies are short; cap to control cost
const REQUEST_TIMEOUT_MS = 15000;    // 15s — Haiku is fast, abort if it stalls
const MAX_HISTORY_MESSAGES = 5;      // last N user/assistant turns in context

// ─────────────────────────────────────────────────────────────────────
// SUPABASE CLIENT (lazy)
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
// KILL SWITCH CHECK
// ─────────────────────────────────────────────────────────────────────

/**
 * Check if the LLM should run RIGHT NOW.
 * Returns: { allowed, reason, currentCost, cap }
 */
export async function shouldRunLLM() {
  try {
    const { data, error } = await sb().rpc("fn_should_run_llm");
    if (error) {
      console.error("[llm] kill switch check failed:", error.message);
      return { allowed: false, reason: "kill_switch_check_failed", currentCost: 0, cap: 0 };
    }
    if (!Array.isArray(data) || data.length === 0) {
      return { allowed: false, reason: "kill_switch_no_data", currentCost: 0, cap: 0 };
    }
    const row = data[0];
    return {
      allowed: row.allowed === true,
      reason: row.reason || "unknown",
      currentCost: Number(row.current_cost || 0),
      cap: Number(row.cap || 0),
    };
  } catch (e) {
    console.error("[llm] kill switch check exception:", e.message);
    return { allowed: false, reason: "kill_switch_exception", currentCost: 0, cap: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────
// RECORD SPEND — increments monthly spend, auto-disables on cap
// ─────────────────────────────────────────────────────────────────────

async function recordSpend(costUsd) {
  if (!costUsd || costUsd <= 0) return;
  try {
    const { error } = await sb().rpc("fn_record_llm_spend", { p_cost: costUsd });
    if (error) console.error("[llm] record_spend failed:", error.message);
  } catch (e) {
    console.error("[llm] record_spend exception:", e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────
// CORE: askLLM
// ─────────────────────────────────────────────────────────────────────

/**
 * Asks Claude Haiku 4.5 to generate a reply for Liam.
 * 
 * @param {object} ctx
 * @param {string} ctx.userMessage - the latest user message
 * @param {string} ctx.language - 'es' | 'en'
 * @param {Array<{role,text}>} ctx.history - recent messages
 * @param {Array<object>} ctx.faqContext - top FAQ matches
 * @param {object} ctx.leadData - captured fields
 * @param {string} ctx.conversationId - for logging
 * @param {string} ctx.waNumber - for logging
 * 
 * @returns {Promise<{text, allowed, reason, latencyMs?, cost?}>}
 */
export async function askLLM(ctx) {
  const start = Date.now();
  
  // 1. Kill switch check
  const gate = await shouldRunLLM();
  if (!gate.allowed) {
    console.log(`[llm] gated: ${gate.reason} (cost $${gate.currentCost}/$${gate.cap})`);
    return { text: null, allowed: false, reason: gate.reason };
  }

  // 2. API key check
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[llm] ANTHROPIC_API_KEY missing");
    return { text: null, allowed: false, reason: "no_api_key" };
  }

  // 3. Build system prompt + messages
  const systemPrompt = buildSystemPrompt({
    language: ctx.language,
    history: (ctx.history || []).slice(-MAX_HISTORY_MESSAGES),
    faqContext: ctx.faqContext || [],
    leadData: ctx.leadData || {},
  });

  const messages = [
    { role: "user", content: ctx.userMessage },
  ];

  // 4. Call Anthropic API with timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL_ID,
        max_tokens: MAX_TOKENS_OUT,
        system: systemPrompt,
        messages,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeoutId);
    const errMsg = e.name === "AbortError" ? "timeout" : e.message;
    console.error(`[llm] fetch error: ${errMsg}`);
    await logCall({
      conversationId: ctx.conversationId,
      waNumber: ctx.waNumber,
      success: false,
      error: `fetch: ${errMsg}`,
      latencyMs: Date.now() - start,
    });
    return { text: null, allowed: true, reason: "fetch_failed" };
  }
  clearTimeout(timeoutId);

  // 5. Handle API errors
  if (!response.ok) {
    let errBody = "";
    try { errBody = await response.text(); } catch (_) {}
    const errMsg = `HTTP ${response.status}: ${errBody.slice(0, 300)}`;
    console.error(`[llm] api error: ${errMsg}`);
    await logCall({
      conversationId: ctx.conversationId,
      waNumber: ctx.waNumber,
      success: false,
      error: errMsg,
      latencyMs: Date.now() - start,
    });
    return { text: null, allowed: true, reason: `api_${response.status}` };
  }

  // 6. Parse response
  let body;
  try {
    body = await response.json();
  } catch (e) {
    console.error("[llm] parse error:", e.message);
    await logCall({
      conversationId: ctx.conversationId,
      waNumber: ctx.waNumber,
      success: false,
      error: `parse: ${e.message}`,
      latencyMs: Date.now() - start,
    });
    return { text: null, allowed: true, reason: "parse_failed" };
  }

  // 7. Extract assistant text
  const text = (body?.content || [])
    .filter(c => c.type === "text")
    .map(c => c.text)
    .join("\n")
    .trim();

  const inputTokens = body?.usage?.input_tokens || 0;
  const outputTokens = body?.usage?.output_tokens || 0;
  const cost = calculateCost(inputTokens, outputTokens);
  const latency = Date.now() - start;

  // 8. Record spend (this also triggers L3 auto-disable if cap reached)
  await recordSpend(cost);

  // 9. Log call
  await logCall({
    conversationId: ctx.conversationId,
    waNumber: ctx.waNumber,
    success: !!text,
    responseText: text,
    inputTokensTotal: inputTokens,
    responseTokens: outputTokens,
    costUsd: cost,
    latencyMs: latency,
    error: text ? null : "empty_reply",
  });

  if (!text) {
    console.warn("[llm] empty reply received");
    return { text: null, allowed: true, reason: "empty_reply", latencyMs: latency, cost };
  }

  console.log(`[llm] reply ok: ${inputTokens}in + ${outputTokens}out = $${cost.toFixed(6)} in ${latency}ms`);
  return { text, allowed: true, reason: "ok", latencyMs: latency, cost };
}

// ─────────────────────────────────────────────────────────────────────
// COST CALCULATION
// ─────────────────────────────────────────────────────────────────────

function calculateCost(inputTokens, outputTokens) {
  const inCost = (inputTokens / 1_000_000) * PRICE_PER_M_INPUT;
  const outCost = (outputTokens / 1_000_000) * PRICE_PER_M_OUTPUT;
  return Number((inCost + outCost).toFixed(6));
}

// ─────────────────────────────────────────────────────────────────────
// LOGGING — aligned with existing wa_agent_llm_logs schema
// ─────────────────────────────────────────────────────────────────────

async function logCall(payload) {
  try {
    await sb()
      .from("wa_agent_llm_logs")
      .insert({
        conversation_id: payload.conversationId || null,
        wa_number: payload.waNumber || null,
        model: MODEL_ID,
        // input_tokens_total is GENERATED column = sum of system+user+context.
        // We put the full input count in system_prompt_tokens (the majority).
        system_prompt_tokens: payload.inputTokensTotal || 0,
        user_message_tokens: 0,
        context_tokens: 0,
        response_tokens: payload.responseTokens || 0,
        cost_usd: payload.costUsd || 0,
        response_text: payload.responseText ? payload.responseText.slice(0, 4000) : null,
        response_time_ms: payload.latencyMs || null,
        success: payload.success === true,
        error_message: payload.error || null,
      });
  } catch (e) {
    console.error("[llm] log insert failed:", e.message);
  }
}
