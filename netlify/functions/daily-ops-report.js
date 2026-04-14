// netlify/functions/daily-ops-report.js
// FR-Logistics Daily Ops Report — for Jose Fuentes
// Scheduled: 7PM EST daily (23:00 UTC during EDT, adjust +1hr Nov-Mar)
// Sends HTML email to josefuentes@fr-logistics.net via Resend with:
//   1. Inbound/Outbound summary from shipments_general (Supabase)
//   2. Inventory KPIs from SKUVault (via inventory.js)

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY");
const RESEND_KEY   = Netlify.env.get("RESEND_API_KEY");
const SITE_URL     = Netlify.env.get("URL") || "https://apps.fr-logistics.net";
const TO_EMAIL     = "josefuentes@fr-logistics.net";
const FROM_EMAIL   = "FR-Logistics Ops <info@fr-logistics.net>";

// ── Date range: today in Miami time → UTC equivalents ───────────
function getTodayRange() {
  const now      = new Date();
  const miamiNow = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const y = miamiNow.getFullYear();
  const m = String(miamiNow.getMonth() + 1).padStart(2, "0");
  const d = String(miamiNow.getDate()).padStart(2, "0");
  const dateStr  = `${y}-${m}-${d}`;
  const offsetMs = now.getTime() - miamiNow.getTime(); // EDT=-14400000 / EST=-18000000
  const startUTC = new Date(new Date(`${dateStr}T00:00:00`).getTime() + offsetMs);
  const endUTC   = new Date(new Date(`${dateStr}T23:59:59`).getTime() + offsetMs);
  const label    = miamiNow.toLocaleDateString("en-US", {
    timeZone: "America/New_York", weekday: "long",
    year: "numeric", month: "long", day: "numeric"
  });
  return { start: startUTC.toISOString(), end: endUTC.toISOString(), label, dateStr };
}

// ── Supabase: get today's shipments ─────────────────────────────
async function getTodayShipments(start, end) {
  const url = `${SUPABASE_URL}/rest/v1/shipments_general` +
    `?received_at=gte.${encodeURIComponent(start)}` +
    `&received_at=lte.${encodeURIComponent(end)}` +
    `&order=received_at.asc&limit=500`;
  const res = await fetch(url, {
    headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
  });
  if (!res.ok) throw new Error(`Supabase error: ${res.status}`);
  return res.json();
}

// ── Inventory KPIs via internal inventory.js function ───────────
async function getInventoryKPIs() {
  try {
    const res = await fetch(`${SITE_URL}/.netlify/functions/inventory`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.kpis || null;
  } catch(e) {
    console.warn("[daily-ops-report] Inventory unavailable:", e.message);
    return null;
  }
}

// ── Build HTML + plain text email ───────────────────────────────
function buildEmail(label, shipments, kpis) {
  const inbound  = shipments.filter(r => r.direction === "Inbound");
  const outbound = shipments.filter(r => r.direction === "Outbound");

  // Group by client, sorted by total activity desc
  const byClient = {};
  shipments.forEach(r => {
    const name = (r.client || "Unknown").trim();
    if (!byClient[name]) byClient[name] = { in: 0, out: 0 };
    if (r.direction === "Inbound") byClient[name].in++;
    else byClient[name].out++;
  });
  const clientsSorted = Object.entries(byClient)
    .sort((a, b) => (b[1].in + b[1].out) - (a[1].in + a[1].out));

  const clientRows = clientsSorted.map(([name, c]) => `
    <tr>
      <td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;font-size:13px">${name}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;text-align:center;font-weight:800;color:#16a34a">${c.in}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;text-align:center;font-weight:800;color:#d97706">${c.out}</td>
    </tr>`).join("");

  const noActivity = `<p style="color:#94a3b8;font-size:13px;text-align:center;padding:12px 0;margin:0">No movements recorded today.</p>`;

  const ok       = kpis ? (kpis.totalSKUs - (kpis.outOfStock || 0) - (kpis.reorderAlerts || 0)) : 0;
  const reorder  = kpis ? (kpis.reorderAlerts || 0) : 0;
  const oos      = kpis ? (kpis.outOfStock || 0) : 0;
  const total    = kpis ? (kpis.totalSKUs || 0) : 0;

  const invSection = kpis ? `
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin-bottom:20px">
      <h2 style="margin:0 0 14px;font-size:15px;color:#0f172a;font-weight:900">📊 SKUVault Inventory</h2>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr style="background:#f0fdf4">
          <td style="padding:9px 12px;border-radius:8px 0 0 8px">✅ OK (above reorder point)</td>
          <td style="padding:9px 12px;text-align:right;font-weight:900;color:#16a34a;border-radius:0 8px 8px 0">${ok} SKUs</td>
        </tr>
        <tr><td colspan="2" style="padding:2px 0"></td></tr>
        <tr style="background:#fffbeb">
          <td style="padding:9px 12px;border-radius:8px 0 0 8px">⚠️ Needs Reorder</td>
          <td style="padding:9px 12px;text-align:right;font-weight:900;color:#d97706;border-radius:0 8px 8px 0">${reorder} SKUs</td>
        </tr>
        <tr><td colspan="2" style="padding:2px 0"></td></tr>
        <tr style="background:#fef2f2">
          <td style="padding:9px 12px;border-radius:8px 0 0 8px">🚨 Out of Stock</td>
          <td style="padding:9px 12px;text-align:right;font-weight:900;color:#dc2626;border-radius:0 8px 8px 0">${oos} SKUs</td>
        </tr>
        <tr><td colspan="2" style="padding:6px 0"></td></tr>
        <tr style="border-top:2px solid #e2e8f0">
          <td style="padding:9px 0;font-weight:900;color:#0f172a">Total tracked</td>
          <td style="padding:9px 0;text-align:right;font-weight:900;color:#0f172a">${total} SKUs</td>
        </tr>
      </table>
      <a href="https://apps.fr-logistics.net/dashboard-inventory.html"
         style="display:inline-block;margin-top:10px;font-size:12px;color:#16a3b5;text-decoration:none">
        View full inventory dashboard →
      </a>
    </div>` :
    `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px;margin-bottom:20px;color:#94a3b8;font-size:12px;text-align:center">
       📊 Inventory data unavailable — check SKUVault connection.
    </div>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f6f7fb;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#0f1d35 0%,#1fa463 60%,#16a3b5 100%);border-radius:16px;padding:22px 24px;margin-bottom:20px">
    <div style="color:#fff;font-size:20px;font-weight:900;letter-spacing:-.3px">📦 FR-Logistics Ops Report</div>
    <div style="color:rgba(255,255,255,.80);font-size:13px;margin-top:5px;font-weight:600">${label}</div>
    <div style="color:rgba(255,255,255,.60);font-size:11px;margin-top:3px">Warehouse WH01 • Doral, FL 33172</div>
  </div>

  <!-- Inbound / Outbound counters -->
  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin-bottom:20px">
    <h2 style="margin:0 0 14px;font-size:15px;color:#0f172a;font-weight:900">🚚 Inbound / Outbound Today</h2>
    <div style="display:flex;gap:10px;margin-bottom:${clientsSorted.length ? "16px" : "0"}">
      <div style="flex:1;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:32px;font-weight:900;color:#16a34a;line-height:1">${inbound.length}</div>
        <div style="font-size:11px;color:#166534;font-weight:800;margin-top:5px;letter-spacing:.5px">INBOUND</div>
      </div>
      <div style="flex:1;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:32px;font-weight:900;color:#d97706;line-height:1">${outbound.length}</div>
        <div style="font-size:11px;color:#92400e;font-weight:800;margin-top:5px;letter-spacing:.5px">OUTBOUND</div>
      </div>
      <div style="flex:1;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:32px;font-weight:900;color:#0f172a;line-height:1">${shipments.length}</div>
        <div style="font-size:11px;color:#475569;font-weight:800;margin-top:5px;letter-spacing:.5px">TOTAL</div>
      </div>
    </div>
    ${clientsSorted.length ? `
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="background:#f8fafc">
          <th style="padding:8px 10px;text-align:left;color:#475569;font-weight:800;font-size:11px;text-transform:uppercase;letter-spacing:.4px;border-bottom:2px solid #e2e8f0">Client</th>
          <th style="padding:8px 10px;text-align:center;color:#16a34a;font-weight:800;font-size:11px;text-transform:uppercase;letter-spacing:.4px;border-bottom:2px solid #e2e8f0">IN</th>
          <th style="padding:8px 10px;text-align:center;color:#d97706;font-weight:800;font-size:11px;text-transform:uppercase;letter-spacing:.4px;border-bottom:2px solid #e2e8f0">OUT</th>
        </tr>
      </thead>
      <tbody>${clientRows}</tbody>
    </table>
    <a href="https://apps.fr-logistics.net/portal.html#app=Inbound_Outbound.html"
       style="display:inline-block;margin-top:10px;font-size:12px;color:#16a3b5;text-decoration:none">
      View full log in portal →
    </a>` : noActivity}
  </div>

  <!-- Inventory -->
  ${invSection}

  <!-- Footer -->
  <div style="text-align:center;color:#94a3b8;font-size:11px;padding-top:4px;line-height:1.8">
    FR-Logistics Miami • 10893 NW 17th St, Unit 121, Doral FL 33172<br>
    <a href="https://apps.fr-logistics.net/portal.html" style="color:#16a3b5;text-decoration:none">Open Operations Portal</a>
    &nbsp;•&nbsp;
    <a href="https://apps.fr-logistics.net/dashboard-inventory.html" style="color:#16a3b5;text-decoration:none">Inventory Dashboard</a>
  </div>

</div>
</body>
</html>`;

  const text = [
    `FR-Logistics Ops Report — ${label}`,
    ``,
    `INBOUND / OUTBOUND TODAY`,
    `Inbound:   ${inbound.length}`,
    `Outbound:  ${outbound.length}`,
    `Total:     ${shipments.length}`,
    ``,
    clientsSorted.length
      ? clientsSorted.map(([n, c]) => `  ${n}: IN ${c.in}  OUT ${c.out}`).join("\n")
      : `  No movements today.`,
    ``,
    kpis ? [
      `SKUVAULT INVENTORY`,
      `  OK (above reorder):  ${ok} SKUs`,
      `  Needs Reorder:       ${reorder} SKUs`,
      `  Out of Stock:        ${oos} SKUs`,
      `  Total tracked:       ${total} SKUs`,
    ].join("\n") : `INVENTORY: data unavailable.`,
    ``,
    `Portal: https://apps.fr-logistics.net/portal.html`,
    `Inventory: https://apps.fr-logistics.net/dashboard-inventory.html`,
  ].join("\n");

  return { html, text };
}

// ── Send via Resend ──────────────────────────────────────────────
async function sendEmail(html, text, label) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from:    FROM_EMAIL,
      to:      [TO_EMAIL],
      subject: `📦 FR-Logistics Ops Report — ${label}`,
      html,
      text
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Resend error: ${JSON.stringify(data)}`);
  return data;
}

// ── Handler ──────────────────────────────────────────────────────
export default async (req) => {
  console.log("[daily-ops-report] Starting at", new Date().toISOString());
  try {
    const { start, end, label } = getTodayRange();
    console.log("[daily-ops-report] Range:", start, "→", end);

    const [shipments, kpis] = await Promise.all([
      getTodayShipments(start, end),
      getInventoryKPIs()
    ]);

    console.log(`[daily-ops-report] ${shipments.length} shipments | KPIs: ${kpis ? "ok" : "unavailable"}`);

    const { html, text } = buildEmail(label, shipments, kpis);
    const result = await sendEmail(html, text, label);

    console.log("[daily-ops-report] Email sent →", result.id || JSON.stringify(result));
    return new Response(JSON.stringify({ success: true, shipments: shipments.length, resend: result }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  } catch(e) {
    console.error("[daily-ops-report] Error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};

export const config = {
  schedule: "0 23 * * *"  // 7:00 PM EDT (UTC-4) / 6:00 PM EST (UTC-5) Nov-Mar
};
