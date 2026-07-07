// netlify/functions/moc-crossmap-data.js
//
// MOC × SRJ cross-map data source.
// Aggregates the srj_cfi_daily view into weekly buckets aligned to the
// MOC training calendar (Week 1 = Jul 6, 2026 ... through the NYC block).
//
// For each MOC week it returns the REAL averaged metrics from your Garmin/
// Strava pipeline when data exists for that week's date range, and null when
// the week is still in the future (projection handled client-side).
//
// Read-only. Never mutates any table. Uses SUPABASE_SERVICE_KEY held
// server-side (same pattern as billing-generator.js / dashboard-kpis.js), so
// the key is never exposed to the browser.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

// MOC calendar: each week starts on a Monday. Week 1 = Jul 6, 2026.
// We anchor NYC to Sunday Nov 1, 2026 (end of MOC Week 16 / start of Week 17).
const MOC_WEEK1_MONDAY = "2026-07-06";

function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Average a numeric field over a list of rows, ignoring nulls.
function avg(rows, field) {
  const vals = rows
    .map((r) => (r[field] === null || r[field] === undefined ? null : Number(r[field])))
    .filter((v) => v !== null && !Number.isNaN(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// Most common band label in a list of rows for a text field.
function modeBand(rows, field) {
  const counts = {};
  rows.forEach((r) => {
    const v = r[field];
    if (v) counts[v] = (counts[v] || 0) + 1;
  });
  let best = null;
  let bestN = 0;
  Object.entries(counts).forEach(([k, n]) => {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  });
  return best;
}

async function fetchView(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase ${res.status}: ${txt}`);
  }
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }

  try {
    // How many MOC weeks to build (Week 1 through Week 18 covers the NYC arc).
    const totalWeeks = 18;
    const rangeStart = MOC_WEEK1_MONDAY;
    const rangeEnd = addDays(MOC_WEEK1_MONDAY, totalWeeks * 7);

    // Pull only the columns we need, only within the block window.
    const rows = await fetchView(
      `srj_cfi_daily?recovery_date=gte.${rangeStart}&recovery_date=lt.${rangeEnd}` +
        `&select=recovery_date,cfi,cfi_band,acr_ratio,acr_band,load_7d_mi,` +
        `load_28d_mi,runs_last_7d,readiness_score,readiness_level,overtraining_risk` +
        `&order=recovery_date.asc`
    );

    const today = new Date().toISOString().slice(0, 10);

    const weeks = [];
    for (let i = 0; i < totalWeeks; i++) {
      const wkStart = addDays(MOC_WEEK1_MONDAY, i * 7);
      const wkEnd = addDays(wkStart, 6); // inclusive Sunday
      const wkRows = rows.filter(
        (r) => r.recovery_date >= wkStart && r.recovery_date <= wkEnd
      );

      const hasData = wkRows.length > 0;
      const isPast = wkEnd < today;
      const isCurrent = wkStart <= today && today <= wkEnd;

      weeks.push({
        moc_week: i + 1,
        week_start: wkStart, // Monday
        week_end: wkEnd, // Sunday
        is_past: isPast,
        is_current: isCurrent,
        has_data: hasData,
        days_with_data: wkRows.length,
        // Real averaged metrics (null when no data yet -> client projects)
        cfi_avg: hasData ? Number(avg(wkRows, "cfi").toFixed(1)) : null,
        cfi_band: hasData ? modeBand(wkRows, "cfi_band") : null,
        acr_avg: hasData ? Number(avg(wkRows, "acr_ratio").toFixed(2)) : null,
        acr_band: hasData ? modeBand(wkRows, "acr_band") : null,
        load_7d_avg: hasData ? Number(avg(wkRows, "load_7d_mi").toFixed(1)) : null,
        load_28d_last: hasData
          ? Number(wkRows[wkRows.length - 1].load_28d_mi)
          : null,
        readiness_avg: hasData
          ? Math.round(avg(wkRows, "readiness_score"))
          : null,
        overtraining_days: hasData
          ? wkRows.filter((r) => r.overtraining_risk === true).length
          : 0,
      });
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        generated_at: new Date().toISOString(),
        moc_week1_monday: MOC_WEEK1_MONDAY,
        nyc_race_date: "2026-11-01",
        weeks,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
