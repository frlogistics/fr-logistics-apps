// netlify/functions/_agent-helpers/wa-agent-email-handoff.js
//
// Sends the qualified-lead notification email to info@fr-logistics.net.
// Triggered when:
//   - User completes capture flow (provides name + email)
//   - User explicitly requests "humano" / "human"
//   - 24h timeout with partial data
//
// Pattern matches the existing wa-leads-create.js Resend integration.
// Best-effort — errors are logged but never thrown.

const RESEND_KEY = process.env.RESEND_API_KEY;

const SERVICE_LABELS = {
  fba_prep:    { es: "FBA Prep",        en: "FBA Prep" },
  master_case: { es: "Master Case",     en: "Master Case" },
  dropship:    { es: "Dropshipment",    en: "Dropshipment" },
  ecopack:     { es: "EcoPack+",        en: "EcoPack+" },
  other:       { es: "Otro / general",  en: "Other / general" },
  jose_handoff:{ es: "Hablar con Jose", en: "Talk to Jose" },
};

/**
 * Sends the handoff notification email to info@fr-logistics.net.
 * 
 * @param {object} payload
 * @param {string} payload.waNumber       — E.164 with or without +
 * @param {string} payload.name           — Captured lead name
 * @param {string} payload.email          — Captured lead email
 * @param {string} payload.language       — 'es' | 'en'
 * @param {string} payload.serviceInterest— 'fba_prep' | 'master_case' | etc.
 * @param {string} payload.firstMessage   — The original message that started conv
 * @param {string} payload.handoffReason  — 'user_request_jose' | 'service_interest_*' etc
 * @param {string} payload.conversationId — UUID for traceability
 * @param {object} payload.qualification — Optional Sprint 2 captured data
 *   {
 *     volume?: { normalized, raw },
 *     country?: { normalized, raw },
 *     platforms?: { normalized, raw },
 *     stage?: { normalized, raw },
 *     product_type?: { normalized, raw },
 *     integration?: { normalized, raw },
 *     eco_focus?: { normalized, raw },
 *   }
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function sendHandoffEmail(payload) {
  if (!RESEND_KEY) {
    console.log("[handoff-email] no RESEND_API_KEY, skipping");
    return { ok: false, error: "RESEND_API_KEY missing" };
  }

  const {
    waNumber,
    name = "Lead sin nombre",
    email = "(no proporcionado)",
    language = "es",
    serviceInterest = "other",
    firstMessage = "",
    handoffReason = "unknown",
    conversationId = "",
    qualification = {},
  } = payload;

  const phoneClean = waNumber.startsWith("+") ? waNumber : `+${waNumber}`;
  const phoneRaw = waNumber.replace(/^\+/, "");
  const langLabel = language === "es" ? "Spanish 🇲🇽🇨🇴🇦🇷" : "English 🇺🇸";
  const serviceLabel =
    SERVICE_LABELS[serviceInterest]?.[language] ||
    SERVICE_LABELS[serviceInterest]?.es ||
    serviceInterest;

  // Direct deep link to reply on WhatsApp
  const waReplyLink = `https://wa.me/${phoneRaw}`;
  // Direct link to portal WA Inbox
  const portalLink = "https://apps.fr-logistics.net/portal.html#wa-inbox";
  // Direct link to lead in WA Lead Capture
  const leadCaptureLink = "https://apps.fr-logistics.net/wa-lead-capture.html";

  const subject = `🆕 New Lead from Liam — ${name} — ${serviceLabel}`;

  const html = renderEmailHtml({
    name,
    email,
    phone: phoneClean,
    phoneRaw,
    language: langLabel,
    serviceLabel,
    firstMessage,
    handoffReason,
    waReplyLink,
    portalLink,
    leadCaptureLink,
    conversationId,
    qualification,
  });

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "FR-Logistics Liam <noreply@fr-logistics.net>",
        to: ["info@fr-logistics.net"],
        cc: ["josefuentes@fr-logistics.net"],
        subject,
        html,
        reply_to: email !== "(no proporcionado)" ? email : undefined,
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error("[handoff-email] Resend error:", r.status, errText);
      return { ok: false, error: `Resend ${r.status}` };
    }

    const data = await r.json();
    console.log("[handoff-email] sent — Resend ID:", data.id);
    return { ok: true, resendId: data.id };
  } catch (err) {
    console.error("[handoff-email] fetch error:", err.message);
    return { ok: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Email HTML — brand-aligned (teal/green gradient header)
// ─────────────────────────────────────────────────────────────────────

function renderEmailHtml({
  name, email, phone, phoneRaw, language, serviceLabel,
  firstMessage, handoffReason, waReplyLink, portalLink, leadCaptureLink,
  conversationId, qualification = {},
}) {
  const esc = (s) => String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // Build qualification HTML if any data is present
  const qualifyFields = [
    { key: 'volume',       label: 'Volume / Volumen' },
    { key: 'country',      label: 'Country / País' },
    { key: 'platforms',    label: 'Platforms / Plataformas' },
    { key: 'stage',        label: 'Stage / Etapa' },
    { key: 'product_type', label: 'Product type / Tipo de producto' },
    { key: 'integration',  label: 'Integration / Integración' },
    { key: 'eco_focus',    label: 'Eco focus / Foco eco' },
  ];
  const presentFields = qualifyFields.filter(f => qualification[f.key]);
  
  let qualifySectionHtml = '';
  if (presentFields.length > 0) {
    qualifySectionHtml = `
      <!-- Qualification section -->
      <tr><td style="padding:8px 32px 16px;">
        <div style="font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">📋 Qualification details</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;overflow:hidden;">
          ${presentFields.map((f, i) => {
            const q = qualification[f.key];
            const norm = q.normalized;
            const raw = q.raw;
            const value = norm
              ? `<span style="font-weight:600;color:#065f46;">${esc(norm)}</span>${raw && raw !== norm ? ` <span style="color:#6b7280;font-size:12px;">(user said: "${esc(raw)}")</span>` : ''}`
              : `<span style="color:#374151;font-style:italic;">"${esc(raw)}"</span> <span style="color:#9ca3af;font-size:12px;">— not normalized</span>`;
            const borderStyle = i < presentFields.length - 1 ? 'border-bottom:1px solid #d1fae5;' : '';
            return `<tr>
              <td style="padding:10px 14px;${borderStyle}width:180px;color:#065f46;font-size:13px;font-weight:600;">${esc(f.label)}</td>
              <td style="padding:10px 14px;${borderStyle}font-size:14px;color:#111827;">${value}</td>
            </tr>`;
          }).join('')}
        </table>
      </td></tr>`;
  }

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f3f4f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.08);">
      
      <!-- Header gradient -->
      <tr><td style="background:linear-gradient(135deg,#10b981 0%,#0ea5e9 100%);padding:32px 32px 24px;color:#ffffff;">
        <div style="font-size:13px;font-weight:600;opacity:0.85;letter-spacing:0.5px;text-transform:uppercase;">FR-Logistics · Liam Agent</div>
        <div style="font-size:24px;font-weight:700;margin-top:6px;">🆕 New Lead from WhatsApp</div>
        <div style="font-size:14px;opacity:0.9;margin-top:8px;">Captured 24/7 — ready for follow-up</div>
      </td></tr>

      <!-- Lead summary table -->
      <tr><td style="padding:28px 32px 8px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          <tr><td style="padding:10px 0;border-bottom:1px solid #e5e7eb;width:140px;color:#6b7280;font-size:13px;font-weight:600;">Name</td>
              <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;font-size:15px;color:#111827;font-weight:600;">${esc(name)}</td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:13px;font-weight:600;">Email</td>
              <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;font-size:15px;color:#111827;"><a href="mailto:${esc(email)}" style="color:#0ea5e9;text-decoration:none;">${esc(email)}</a></td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:13px;font-weight:600;">WhatsApp</td>
              <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;font-size:15px;color:#111827;font-family:monospace;">${esc(phone)}</td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:13px;font-weight:600;">Language</td>
              <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;font-size:15px;color:#111827;">${esc(language)}</td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:13px;font-weight:600;">Service Interest</td>
              <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;font-size:15px;color:#111827;font-weight:600;">${esc(serviceLabel)}</td></tr>
          <tr><td style="padding:10px 0;color:#6b7280;font-size:13px;font-weight:600;">Handoff Reason</td>
              <td style="padding:10px 0;font-size:13px;color:#6b7280;font-family:monospace;">${esc(handoffReason)}</td></tr>
        </table>
      </td></tr>

      ${qualifySectionHtml}

      <!-- Original message -->
      <tr><td style="padding:8px 32px 16px;">
        <div style="font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Original message</div>
        <div style="background:#f9fafb;border-left:3px solid #10b981;padding:14px 16px;border-radius:6px;font-size:14px;color:#374151;line-height:1.5;">${esc(firstMessage) || "<em style='color:#9ca3af;'>(empty)</em>"}</div>
      </td></tr>

      <!-- Action buttons -->
      <tr><td style="padding:16px 32px 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td align="center" style="padding:0 4px;">
              <a href="${esc(waReplyLink)}" style="display:inline-block;background:#25d366;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px;font-weight:600;">💬 Reply on WhatsApp</a>
            </td>
            <td align="center" style="padding:0 4px;">
              <a href="${esc(portalLink)}" style="display:inline-block;background:#0ea5e9;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px;font-weight:600;">📥 Open Inbox</a>
            </td>
            <td align="center" style="padding:0 4px;">
              <a href="${esc(leadCaptureLink)}" style="display:inline-block;background:#8b5cf6;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px;font-weight:600;">📋 View Lead</a>
            </td>
          </tr>
        </table>
      </td></tr>

      <!-- Footer -->
      <tr><td style="background:#f9fafb;padding:16px 32px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:11px;text-align:center;">
        Conversation ID: ${esc(conversationId)}<br>
        Sent automatically by Liam · FR-Logistics WhatsApp Agent
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}
