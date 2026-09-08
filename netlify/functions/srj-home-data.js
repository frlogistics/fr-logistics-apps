/* ============================================================================
   netlify/functions/srj-home-data.js
   StrokeRunnerJourney · HOME tab
   Una sola respuesta con todo lo que el Home necesita en el iPhone:
     - recovery: ultimos 35 dias de srj_recovery (HRV, RHR, sueno, CTL/ATL/TSB)
     - sessions: sesiones del plan ACTIVO desde hoy (pasos resueltos, srj_plan_steps)
     - real:     srj_plan_vs_real_daily de la semana pasada + esta semana
     - week:     rollup de la semana actual (srj_plan_week_summary) + total de semanas
   Server-side: las llaves viven en env vars de Netlify. El browser nunca las ve.
   Mismo patron que srj-recovery-data / srj-plan-data (PostgREST directo).
   ========================================================================== */

const SB_URL =
  process.env.SRJ_SUPABASE_URL || process.env.SUPABASE_RECOVERY_URL;
const SB_KEY =
  process.env.SUPABASE_RECOVERY_SECRET_KEY || process.env.SUPABASE_RECOVERY_KEY;

const TZ = "America/New_York";

function ymdInTZ(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}
function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
function mondayOf(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = dom
  return addDays(ymd, dow === 0 ? -6 : 1 - dow);
}

async function pg(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) throw new Error(`${path.split("?")[0]} -> HTTP ${r.status}`);
  return r.json();
}

export default async () => {
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  if (!SB_URL || !SB_KEY) return json({ error: "missing_supabase_env" }, 500);

  try {
    const today = ymdInTZ();
    const monday = mondayOf(today);
    const from = addDays(monday, -7);
    const to = addDays(monday, 6);

    const versions = await pg(
      "srj_plan_versions?select=*&is_active=eq.true&limit=1"
    );
    const version = versions[0] || null;
    const vid = version?.id;

    const [recovery, steps, real, weeks] = await Promise.all([
      pg(
        "srj_recovery?select=recovery_date,hrv_overnight_ms,resting_hr_bpm,sleep_hours,ctl,atl,tsb,readiness_score,body_battery_high" +
          `&recovery_date=gte.${addDays(today, -35)}&order=recovery_date.desc`
      ),
      vid
        ? pg(
            "srj_plan_steps?select=session_id,week_number,phase,session_date,day_of_week,session_type,status,step_order,label,distance_mi,target_type,zone,note,pace_min_sec,pace_max_sec,hr_min,hr_max,is_mp_controlled,is_unspecified" +
              `&version_id=eq.${vid}&session_date=gte.${today}&order=session_date.asc,step_order.asc&limit=80`
          )
        : [],
      pg(
        "srj_plan_vs_real_daily?select=session_date,week_number,day_of_week,session_type,title,start_point,plan_mi,plan_mp_mi,plan_bridge_mi,real_mi,real_sec,real_hr,real_cadence,real_pace_sec_mi,delta_mi,estado" +
          `&session_date=gte.${from}&session_date=lte.${to}&order=session_date.asc`
      ),
      vid
        ? pg(
            `srj_plan_week_summary?select=week_number,phase,week_mi,long_run_mi,mp_mi,bridge_mi,easy_mi&version_id=eq.${vid}&order=week_number.asc`
          )
        : [],
    ]);

    // Agrupa los pasos por sesion (hoy y las proximas), conservando el orden.
    const sessionsMap = new Map();
    for (const s of steps) {
      if (!sessionsMap.has(s.session_id)) {
        sessionsMap.set(s.session_id, {
          session_id: s.session_id,
          session_date: s.session_date,
          week_number: s.week_number,
          phase: s.phase,
          day_of_week: s.day_of_week,
          session_type: s.session_type,
          status: s.status,
          steps: [],
        });
      }
      sessionsMap.get(s.session_id).steps.push(s);
    }
    const sessions = [...sessionsMap.values()].slice(0, 4);

    // Titulo y punto de salida vienen de la vista plan-vs-real (misma sesion).
    for (const ses of sessions) {
      const r = real.find((x) => x.session_date === ses.session_date);
      if (r) {
        ses.title = r.title;
        ses.start_point = r.start_point;
        ses.plan_mi = r.plan_mi;
      }
    }

    const currentWeek =
      sessions[0]?.week_number ??
      real.find((x) => x.session_date === today)?.week_number ??
      null;

    return json({
      today,
      monday,
      version: version
        ? { id: version.id, name: version.name ?? null, goal_time: version.goal_time ?? null }
        : null,
      week: {
        number: currentWeek,
        total: weeks.length ? Math.max(...weeks.map((w) => w.week_number)) : null,
        summary: weeks.find((w) => w.week_number === currentWeek) || null,
      },
      sessions,
      real,
      recovery,
    });
  } catch (err) {
    console.error("srj-home-data:", err);
    return json({ error: err.message }, 500);
  }
};
