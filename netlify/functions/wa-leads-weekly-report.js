// netlify/functions/wa-leads-weekly-report.js
//
// Scheduled function — runs every Monday at 11 PM UTC (= Sunday 7 PM Miami / EST).
// Aggregates the past 7 days of wa_leads activity and sends a branded report
// to josefuentes@fr-logistics.net + info@fr-logistics.net via Resend.
//
// Style: CommonJS + direct fetch (matches daily-summary.js convention).
// Schedule wired in netlify.toml — see WEEKLY-REPORT-SETUP.md.

const SUPA_URL  = process.env.SUPABASE_URL;
const SUPA_KEY  = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;

const REPORT_TO = ['josefuentes@fr-logistics.net', 'info@fr-logistics.net'];
const FROM      = 'FR-Logistics LIAM <reports@fr-logistics.net>';

// Service display labels
const SVC = {
  fba_prep:         { label: 'Amazon FBA Prep',          emoji: '📦' },
  shopify_dtc:      { label: 'Shopify / DTC',            emoji: '🛒' },
  cross_dock_latam: { label: 'LATAM Cross-Dock',         emoji: '🌎' },
  ecopack_plus:     { label: 'EcoPack+',                 emoji: '📬' },
  hold_for_pickup:  { label: 'Hold for Pickup',          emoji: '🚚' },
  fnsku_relabel:    { label: 'FNSKU Relabel',            emoji: '🏷️' },
  freight_inbound:  { label: 'Freight Inbound',          emoji: '✈️' },
  storage_only:     { label: 'Storage Only',             emoji: '🏬' },
  other:            { label: 'Other',                    emoji: '💬' },
};

// ─── helpers ─────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function daysAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.floor(ms / 86400000);
}

async function fetchLeadsSince(sinceIso) {
  const url = `${SUPA_URL}/rest/v1/wa_leads?created_at=gte.${sinceIso}&order=created_at.desc&limit=500`;
  const res = await fetch(url, {
    headers: {
      'apikey':        SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchStaleLeads() {
  // sent_to_sales for >2 days, no won/lost yet — these are the "hot pending"
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
  const url = `${SUPA_URL}/rest/v1/wa_leads?status=eq.sent_to_sales&created_at=lt.${twoDaysAgo}&order=created_at.asc&limit=10`;
  const res = await fetch(url, {
    headers: {
      'apikey':        SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`,
    },
  });
  if (!res.ok) return [];
  return res.json();
}

// Group leads by a given key, return sorted top N
function topN(leads, keyFn, n = 3) {
  const counts = {};
  for (const l of leads) {
    const k = keyFn(l);
    if (!k) continue;
    counts[k] = (counts[k] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

// ─── HTML template ──────────────────────────────────────────────────
function buildEmailHtml(data) {
  const { weekStart, weekEnd, leads, stale, kpis, topServices, topCountries, topLanguages } = data;

  const kpiCard = (num, label, color = '#0F172A') => `
    <td style="padding:0 6px;" align="center" width="20%">
      <div style="background:#FFFFFF;border:1px solid #E2E8F0;border-radius:10px;padding:14px 8px;">
        <div style="font-size:26px;font-weight:700;color:${color};line-height:1;font-family:Georgia,serif;">${num}</div>
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#94A3B8;font-weight:700;margin-top:4px;">${label}</div>
      </div>
    </td>`;

  const topRow = ([key, count], formatter) => `
    <tr>
      <td style="padding:8px 12px;font-size:14px;color:#0F172A;">${formatter(key)}</td>
      <td style="padding:8px 12px;font-size:14px;color:#475569;font-weight:600;text-align:right;">${count} ${count === 1 ? 'lead' : 'leads'}</td>
    </tr>`;

  const staleRow = (l) => {
    const phoneClean = String(l.phone || '').replace(/[^0-9]/g, '');
    const svc = SVC[l.service] || SVC.other;
    return `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;">
          <div style="font-weight:600;color:#0F172A;font-size:13px;">${escapeHtml(l.name)}</div>
          <div style="font-size:11px;color:#64748B;">${escapeHtml(l.email)}</div>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-size:12px;color:#475569;">${svc.emoji} ${escapeHtml(svc.label)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-size:12px;color:#DC2626;font-weight:600;">${daysAgo(l.created_at)}d ago</td>
        <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;text-align:right;">
          <a href="https://wa.me/${phoneClean}" style="background:#25D366;color:#FFF;text-decoration:none;font-size:11px;font-weight:600;padding:5px 10px;border-radius:5px;">💬 WA</a>
        </td>
      </tr>`;
  };

  const conversionRate = kpis.won + kpis.lost > 0
    ? Math.round((kpis.won / (kpis.won + kpis.lost)) * 100)
    : 0;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WA Leads Weekly Report</title></head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0F172A;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F8FAFC;padding:32px 16px;">
<tr><td align="center">

<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;background:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 4px 16px rgba(15,23,42,.08);">

<!-- Brand gradient header -->
<tr><td style="background:linear-gradient(90deg,#10B981 0%,#14B8A6 50%,#0EA5E9 100%);padding:32px 32px 28px;color:#FFFFFF;">
  <div style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;opacity:.92;font-weight:700;margin-bottom:8px;">WA Commercial · Weekly Report</div>
  <div style="font-size:26px;font-weight:700;line-height:1.15;">📊 Week of ${weekStart} — ${weekEnd}</div>
  <div style="font-size:14px;opacity:.92;margin-top:6px;">+1 786-300-1443 · LIAM-fronted sales channel</div>
</td></tr>

<!-- KPIs row -->
<tr><td style="padding:24px 24px 8px;background:#F8FAFC;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      ${kpiCard(kpis.total, 'Total', '#0F172A')}
      ${kpiCard(kpis.new, 'New', '#94A3B8')}
      ${kpiCard(kpis.sent, 'Sent', '#1E40AF')}
      ${kpiCard(kpis.won, 'Won', '#059669')}
      ${kpiCard(kpis.lost, 'Lost', '#DC2626')}
    </tr>
  </table>
  ${kpis.won + kpis.lost > 0 ? `
  <div style="text-align:center;margin-top:16px;padding:10px;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:10px;">
    <span style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#94A3B8;font-weight:700;">Conversion rate</span>
    <span style="font-size:18px;font-weight:700;color:${conversionRate >= 25 ? '#059669' : '#B45309'};margin-left:8px;font-family:Georgia,serif;">${conversionRate}%</span>
    <span style="font-size:11px;color:#94A3B8;margin-left:6px;">(target: 25%)</span>
  </div>` : ''}
</td></tr>

${kpis.total === 0 ? `
<tr><td style="padding:40px 32px;text-align:center;color:#64748B;">
  <div style="font-size:48px;margin-bottom:12px;opacity:.4;">📭</div>
  <div style="font-size:16px;font-weight:600;color:#0F172A;">No leads captured this week</div>
  <div style="font-size:13px;margin-top:6px;">Make sure operators are using the WA Lead Capture tab when LIAM completes the qualification flow.</div>
</td></tr>
` : `

<!-- Top services -->
${topServices.length > 0 ? `
<tr><td style="padding:24px 32px 8px;">
  <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#94A3B8;font-weight:700;margin-bottom:10px;">📦 Top Services Requested</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFFFF;border:1px solid #E2E8F0;border-radius:10px;overflow:hidden;">
    ${topServices.map(([k, n]) => topRow([k, n], (key) => {
      const s = SVC[key] || SVC.other;
      return `${s.emoji} ${escapeHtml(s.label)}`;
    })).join('')}
  </table>
</td></tr>` : ''}

<!-- Top countries -->
${topCountries.length > 0 ? `
<tr><td style="padding:16px 32px 8px;">
  <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#94A3B8;font-weight:700;margin-bottom:10px;">🌍 Top Countries</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFFFF;border:1px solid #E2E8F0;border-radius:10px;overflow:hidden;">
    ${topCountries.map(([k, n]) => topRow([k, n], (key) => `🏳️ ${escapeHtml(key.toUpperCase())}`)).join('')}
  </table>
</td></tr>` : ''}

<!-- Language split -->
${topLanguages.length > 0 ? `
<tr><td style="padding:16px 32px 8px;">
  <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#94A3B8;font-weight:700;margin-bottom:10px;">🗣️ Language Split</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFFFF;border:1px solid #E2E8F0;border-radius:10px;overflow:hidden;">
    ${topLanguages.map(([k, n]) => topRow([k, n], (key) => key === 'es' ? '🇪🇸 Spanish' : '🇺🇸 English')).join('')}
  </table>
</td></tr>` : ''}

`}

<!-- Hot pending leads (always shown if any exist, regardless of weekly activity) -->
${stale.length > 0 ? `
<tr><td style="padding:24px 32px 8px;">
  <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#DC2626;font-weight:700;margin-bottom:10px;">🔥 Hot Pending Follow-ups (sent to sales 2+ days ago)</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFFFF;border:1px solid #E2E8F0;border-radius:10px;overflow:hidden;">
    <thead>
      <tr style="background:#F8FAFC;">
        <th style="padding:8px 12px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#94A3B8;font-weight:700;">Lead</th>
        <th style="padding:8px 12px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#94A3B8;font-weight:700;">Service</th>
        <th style="padding:8px 12px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#94A3B8;font-weight:700;">Age</th>
        <th style="padding:8px 12px;text-align:right;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#94A3B8;font-weight:700;">Action</th>
      </tr>
    </thead>
    <tbody>
      ${stale.slice(0, 5).map(staleRow).join('')}
    </tbody>
  </table>
  ${stale.length > 5 ? `<div style="font-size:12px;color:#94A3B8;margin-top:8px;text-align:right;">+${stale.length - 5} more in pipeline</div>` : ''}
</td></tr>` : ''}

<!-- CTA -->
<tr><td style="padding:24px 32px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td align="center">
      <a href="https://apps.fr-logistics.net/portal.html#app=wa-lead-capture.html" style="display:inline-block;background:#0F172A;color:#FFFFFF;text-decoration:none;font-weight:600;font-size:14px;padding:12px 24px;border-radius:10px;">📲 Open WA Lead Capture</a>
    </td></tr>
  </table>
</td></tr>

<!-- Footer -->
<tr><td style="padding:20px 32px;text-align:center;background:#0F172A;color:#94A3B8;font-size:12px;">
  <div style="font-weight:600;color:#FFFFFF;margin-bottom:4px;">FR-Logistics Miami · Amazon SPN-Certified 3PL</div>
  <div>Auto-generated weekly · Mondays 11 PM UTC (Sundays 7 PM Miami)</div>
  <div style="margin-top:8px;font-size:11px;opacity:.7;">apps.fr-logistics.net · LIAM Reports</div>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

// ─── Main handler ───────────────────────────────────────────────────
exports.handler = async function(event) {
  // Allow manual trigger via HTTP for testing (GET /.netlify/functions/wa-leads-weekly-report)
  // and scheduled invocation (no event.httpMethod set).
  console.log('[wa-leads-weekly-report] Starting report generation');

  if (!SUPA_URL || !SUPA_KEY || !RESEND_KEY) {
    const missing = [];
    if (!SUPA_URL) missing.push('SUPABASE_URL');
    if (!SUPA_KEY) missing.push('SUPABASE_SERVICE_KEY');
    if (!RESEND_KEY) missing.push('RESEND_API_KEY');
    console.error('[wa-leads-weekly-report] Missing env:', missing.join(', '));
    return { statusCode: 500, body: `Missing env: ${missing.join(', ')}` };
  }

  try {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    const weekStart = fmtDate(weekAgo);
    const weekEnd   = fmtDate(now);

    // Fetch this week's leads + stale pending
    const [leads, stale] = await Promise.all([
      fetchLeadsSince(weekAgo.toISOString()),
      fetchStaleLeads(),
    ]);

    console.log(`[wa-leads-weekly-report] ${leads.length} leads this week, ${stale.length} stale pending`);

    // KPIs
    const kpis = { total: leads.length, new: 0, qualifying: 0, sent: 0, won: 0, lost: 0 };
    for (const l of leads) {
      if (l.status === 'sent_to_sales') kpis.sent++;
      else if (l.status in kpis) kpis[l.status]++;
    }

    // Top breakdowns
    const topServices  = topN(leads, l => l.service, 5);
    const topCountries = topN(leads, l => l.country, 5);
    const topLanguages = topN(leads, l => l.language, 2);

    const html = buildEmailHtml({
      weekStart, weekEnd, leads, stale, kpis,
      topServices, topCountries, topLanguages,
    });

    const subject = leads.length > 0
      ? `📊 WA Weekly Report — ${weekStart} to ${weekEnd} — ${leads.length} new lead${leads.length === 1 ? '' : 's'}`
      : `📊 WA Weekly Report — ${weekStart} to ${weekEnd} — No new leads`;

    // Send via Resend
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    FROM,
        to:      REPORT_TO,
        subject: subject,
        html:    html,
        headers: { 'X-Report-Type': 'wa-leads-weekly' },
      }),
    });

    const resendData = await resendRes.json();
    if (!resendRes.ok) {
      console.error('[wa-leads-weekly-report] Resend error:', resendData);
      return { statusCode: 500, body: JSON.stringify(resendData) };
    }

    console.log(`[wa-leads-weekly-report] ✓ Sent — Resend id: ${resendData.id}`);
    return {
      statusCode: 200,
      body: JSON.stringify({
        sent: true,
        resend_id: resendData.id,
        leads_count: leads.length,
        stale_count: stale.length,
        week_range: `${weekStart} — ${weekEnd}`,
      }),
    };
  } catch (e) {
    console.error('[wa-leads-weekly-report] Fatal:', e.message, e.stack);
    return { statusCode: 500, body: e.message };
  }
};
