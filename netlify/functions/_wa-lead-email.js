// netlify/functions/_wa-lead-email.js
//
// Email HTML template builder for WA lead forwards (used by wa-leads-create.js).
// Uses Resend's REST API directly (no SDK).
// Underscore prefix means Netlify won't deploy this as a public function.

const SERVICE_LABELS = {
  fba_prep:         { en: 'Amazon FBA Prep',          es: 'Amazon FBA Prep',                  emoji: '📦' },
  shopify_dtc:      { en: 'Shopify / DTC Fulfillment', es: 'Shopify / DTC Fulfillment',       emoji: '🛒' },
  cross_dock_latam: { en: 'LATAM Cross-Docking',      es: 'Cross-Docking LATAM',              emoji: '🌎' },
  ecopack_plus:     { en: 'EcoPack+ Package Reception', es: 'EcoPack+ Recepción de Paquetes', emoji: '📬' },
  hold_for_pickup:  { en: 'Receive + Hold for Pickup', es: 'Recibir + Mantener para Pickup',  emoji: '🚚' },
  fnsku_relabel:    { en: 'FNSKU Relabel + Removal',  es: 'Relabel FNSKU + Removal',          emoji: '🏷️' },
  freight_inbound:  { en: 'Freight Inbound',          es: 'Freight Inbound',                  emoji: '✈️' },
  storage_only:     { en: 'Storage Only',             es: 'Almacenaje',                       emoji: '🏬' },
  other:            { en: 'Other',                    es: 'Otro',                              emoji: '💬' },
};

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function buildSubject(lead) {
  const svc = SERVICE_LABELS[lead.service] || SERVICE_LABELS.other;
  return `🆕 New WA Lead — ${svc.emoji} ${svc.en} — ${lead.name}`;
}

function buildEmailHtml(lead) {
  const svc = SERVICE_LABELS[lead.service] || SERVICE_LABELS.other;
  const phoneClean = String(lead.phone || '').replace(/[^0-9]/g, '');
  const waLink = `https://wa.me/${phoneClean}`;
  const langBadge = lead.language === 'es' ? '🇪🇸 ES' : '🇺🇸 EN';
  const created = new Date(lead.created_at).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'medium',
    timeStyle: 'short',
  }) + ' EST';

  const row = (label, value) => value
    ? `<tr><td style="padding:6px 14px 6px 0;color:#64748B;font-size:12px;text-transform:uppercase;letter-spacing:.06em;font-weight:600;white-space:nowrap;vertical-align:top;">${label}</td><td style="padding:6px 0;color:#0F172A;font-size:14px;">${value}</td></tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>New WhatsApp Lead — FR-Logistics</title>
</head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0F172A;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F8FAFC;padding:32px 16px;">
<tr><td align="center">

<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 4px 16px rgba(15,23,42,.08);">

<tr><td style="background:linear-gradient(90deg,#10B981 0%,#14B8A6 50%,#0EA5E9 100%);padding:28px 32px;color:#FFFFFF;">
  <div style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;opacity:.92;font-weight:700;margin-bottom:6px;">New Lead · WhatsApp Commercial</div>
  <div style="font-size:24px;font-weight:700;line-height:1.2;">${svc.emoji}&nbsp;&nbsp;${escapeHtml(svc.en)}</div>
  <div style="font-size:14px;opacity:.92;margin-top:4px;">From <strong>${escapeHtml(lead.name)}</strong> · ${langBadge}</div>
</td></tr>

<tr><td style="padding:28px 32px 8px;">
  <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#94A3B8;font-weight:700;margin-bottom:12px;">👤 Lead Identity</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    ${row('Name', escapeHtml(lead.name))}
    ${row('Email', `<a href="mailto:${escapeHtml(lead.email)}" style="color:#059669;text-decoration:none;font-weight:600;">${escapeHtml(lead.email)}</a>`)}
    ${row('WhatsApp', `<a href="${waLink}" style="color:#059669;text-decoration:none;font-weight:600;">${escapeHtml(lead.phone)}</a>`)}
    ${row('Country', escapeHtml(lead.country))}
    ${row('Language', langBadge)}
    ${row('Captured', created)}
    ${row('Captured by', escapeHtml(lead.captured_by))}
  </table>
</td></tr>

<tr><td style="padding:8px 32px;">
  <div style="height:1px;background:#E2E8F0;margin:8px 0;"></div>
  <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#94A3B8;font-weight:700;margin:16px 0 12px;">${svc.emoji} Service Interest</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    ${row('Service', `${escapeHtml(svc.en)} (${escapeHtml(svc.es)})`)}
    ${row('Detail', escapeHtml(lead.service_detail))}
  </table>
</td></tr>

${(lead.monthly_volume || lead.skus || lead.product_type || lead.origin || lead.destination) ? `
<tr><td style="padding:8px 32px;">
  <div style="height:1px;background:#E2E8F0;margin:8px 0;"></div>
  <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#94A3B8;font-weight:700;margin:16px 0 12px;">📊 Qualification Data</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    ${row('Monthly volume', escapeHtml(lead.monthly_volume))}
    ${row('SKUs', escapeHtml(lead.skus))}
    ${row('Product type', escapeHtml(lead.product_type))}
    ${row('Origin', escapeHtml(lead.origin))}
    ${row('Destination', escapeHtml(lead.destination))}
  </table>
</td></tr>` : ''}

${lead.conversation_summary ? `
<tr><td style="padding:8px 32px;">
  <div style="height:1px;background:#E2E8F0;margin:8px 0;"></div>
  <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#94A3B8;font-weight:700;margin:16px 0 8px;">💬 Conversation Summary</div>
  <div style="background:#F1F5F9;border-left:3px solid #10B981;padding:12px 14px;border-radius:6px;font-size:14px;line-height:1.55;color:#334155;white-space:pre-wrap;">${escapeHtml(lead.conversation_summary)}</div>
</td></tr>` : ''}

${lead.notes ? `
<tr><td style="padding:8px 32px;">
  <div style="height:1px;background:#E2E8F0;margin:8px 0;"></div>
  <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#94A3B8;font-weight:700;margin:16px 0 8px;">📝 Internal Notes</div>
  <div style="font-size:14px;color:#334155;white-space:pre-wrap;">${escapeHtml(lead.notes)}</div>
</td></tr>` : ''}

<tr><td style="padding:24px 32px 8px;">
  <div style="height:1px;background:#E2E8F0;margin:8px 0 20px;"></div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td align="center">
      <a href="${waLink}" style="display:inline-block;background:#25D366;color:#FFFFFF;text-decoration:none;font-weight:600;font-size:15px;padding:14px 28px;border-radius:10px;box-shadow:0 4px 12px rgba(37,211,102,.3);">💬 Reply to ${escapeHtml(lead.name)} on WhatsApp</a>
    </td></tr>
    <tr><td align="center" style="padding-top:12px;">
      <a href="mailto:${escapeHtml(lead.email)}" style="display:inline-block;color:#059669;text-decoration:none;font-weight:500;font-size:13px;">✉️ Or reply via email</a>
    </td></tr>
  </table>
</td></tr>

<tr><td style="padding:24px 32px;background:#F8FAFC;border-top:1px solid #E2E8F0;">
  <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#94A3B8;font-weight:700;margin-bottom:10px;">⚡ Next Steps</div>
  <ol style="margin:0;padding-left:20px;font-size:13px;color:#475569;line-height:1.7;">
    <li>Send formal quote to <strong>${escapeHtml(lead.email)}</strong> within 24 business hours</li>
    <li>CC <code style="background:#E2E8F0;padding:1px 5px;border-radius:3px;font-size:12px;">josefuentes@fr-logistics.net</code></li>
    <li>If signed → add to <code style="background:#E2E8F0;padding:1px 5px;border-radius:3px;font-size:12px;">fr_clients</code> table</li>
    <li>Update lead status to <strong style="color:#059669;">won</strong> in WA Comercial pipeline</li>
  </ol>
</td></tr>

<tr><td style="padding:20px 32px;text-align:center;background:#0F172A;color:#94A3B8;font-size:12px;">
  <div style="font-weight:600;color:#FFFFFF;margin-bottom:4px;">FR-Logistics Miami · Amazon SPN-Certified 3PL</div>
  <div>Auto-generated by LIAM from <strong style="color:#10B981;">+1 786-300-1443</strong></div>
  <div style="margin-top:8px;font-size:11px;opacity:.7;">Lead ID: ${escapeHtml(lead.id)}</div>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

module.exports = { buildSubject, buildEmailHtml, SERVICE_LABELS };
