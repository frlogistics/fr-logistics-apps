// netlify/functions/calendly-sync.mts
//
// RED DE SEGURIDAD PARA LOS LEADS DE CALENDLY
//
// Contexto (31-jul-2026): el webhook de Calendly dejó de entregar el 11 de
// junio y nadie se enteró. Esta función NO reemplaza al webhook: lo respalda.
// Corre cada hora, le pregunta a Calendly qué reuniones existen, y crea en
// wa_leads las que falten.
//
// v2 (26-sep-2026):
//   • Desde el 17-ago estaba muerta: se borraron CALENDLY_TOKEN y
//     CALENDLY_USER_URI de Netlify (límite de 4 KB) creyendo que no se usaban.
//     Ahora NO depende de variables nuevas:
//       - el USER_URI va escrito aquí (no es secreto),
//       - el token se lee de la tabla public.app_secrets (name='calendly_token'),
//         protegida con RLS; solo la service key la lee. Si algún día vuelve a
//         existir CALENDLY_TOKEN en Netlify, se usa ese primero.
//   • Ventana hacia atrás de 45 días para recuperar lo perdido desde agosto.
//   • No duplica personas: si el correo del invitado ya existe en wa_leads,
//     actualiza ese lead con la reunión (si es activa y más reciente) en vez
//     de crear otro. Las reagendas del mismo cliente ya no generan dos leads.
//   • Registra cada evento procesado en public.calendly_seen_events, así una
//     reserva cancelada o fusionada no se vuelve a procesar cada hora ni
//     dispara la alerta una y otra vez.
//
// ENV que usa (todas ya existen): SUPABASE_URL, SUPABASE_SERVICE_KEY,
// RESEND_API_KEY. Opcionales: CALENDLY_TOKEN, ALERT_EMAIL_TO.

import type { Config } from "@netlify/functions";

const CAL_API = "https://api.calendly.com";
const CALENDLY_USER_URI = "https://api.calendly.com/users/8e356995-257f-48bc-a376-91a1dc6159b5";
const ALERT_TO_DEFAULT = "josefuentes@fr-logistics.net";

// Cuántos días hacia atrás y hacia adelante revisar en cada corrida.
const LOOKBACK_DAYS = 45;
const LOOKAHEAD_DAYS = 120;

// ── helpers ─────────────────────────────────────────────────────────
async function cal(path: string, token: string) {
  const res = await fetch(`${CAL_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Calendly ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sb(path: string, init: RequestInit = {}) {
  const key = process.env.SUPABASE_SERVICE_KEY!;
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

async function getCalendlyToken(): Promise<string | null> {
  if (process.env.CALENDLY_TOKEN) return process.env.CALENDLY_TOKEN;
  const rows: any[] = await sb("app_secrets?select=value&name=eq.calendly_token&limit=1");
  return rows?.[0]?.value?.trim() || null;
}

async function markSeen(ev: any, action: string, leadId: string | null, email: string) {
  await sb("calendly_seen_events?on_conflict=event_uri", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      event_uri: ev.uri,
      lead_id: leadId,
      action,
      email: email || null,
      start_time: ev.start_time,
      status: ev.status,
    }),
  });
}

const answerFor = (qa: any[], needle: string) =>
  qa?.find((q) => (q.question || "").toLowerCase().includes(needle))?.answer || "";

// El país llega como texto libre del formulario ("Mexico", "Other / Otro"...).
const COUNTRY: Record<string, string> = {
  usa: "US", "united states": "US", mexico: "MX", méxico: "MX", colombia: "CO",
  chile: "CL", argentina: "AR", peru: "PE", perú: "PE", ecuador: "EC",
  venezuela: "VE", brazil: "BR", brasil: "BR", panama: "PA", panamá: "PA",
  spain: "ES", españa: "ES",
};
function mapCountry(raw: string) {
  const k = (raw || "").toLowerCase().trim();
  for (const [name, code] of Object.entries(COUNTRY)) if (k.includes(name)) return code;
  return "OTHER";
}

// Servicio inferido de los canales de venta declarados.
function mapService(channels: string, business: string) {
  const t = `${channels} ${business}`.toLowerCase();
  if (t.includes("mercado libre") || t.includes("meli")) return "cross_dock_latam";
  if (t.includes("amazon") || t.includes("fba")) return "fba_prep";
  if (t.includes("shopify") || t.includes("dtc")) return "shopify_dtc";
  return "other";
}

const isSpanish = (tz: string) =>
  !/^(America\/New_York|America\/Chicago|America\/Denver|America\/Los_Angeles|Europe\/London)$/.test(tz || "");

const esc = (s: string) => `"${String(s).replace(/"/g, '\\"')}"`;

// ── handler ─────────────────────────────────────────────────────────
export default async () => {
  let token: string | null = null;
  try {
    token = await getCalendlyToken();
  } catch (e: any) {
    console.error("[calendly-sync] no pude leer app_secrets:", e?.message || e);
  }
  if (!token) {
    console.error("[calendly-sync] falta el token de Calendly (app_secrets.calendly_token o CALENDLY_TOKEN)");
    return new Response("missing config", { status: 500 });
  }

  const now = Date.now();
  const min = new Date(now - LOOKBACK_DAYS * 864e5).toISOString();
  const max = new Date(now + LOOKAHEAD_DAYS * 864e5).toISOString();

  try {
    // 1) ¿qué reuniones conoce Calendly? (paginado, por si pasan de 100)
    const events: any[] = [];
    let page =
      `/scheduled_events?user=${encodeURIComponent(CALENDLY_USER_URI)}` +
      `&min_start_time=${min}&max_start_time=${max}&count=100&sort=start_time:asc`;
    for (let i = 0; i < 5 && page; i++) {
      const r = await cal(page, token);
      events.push(...(r.collection || []));
      page = r.pagination?.next_page ? r.pagination.next_page.replace(CAL_API, "") : "";
    }

    if (!events.length) {
      console.log("[calendly-sync] sin reuniones en la ventana");
      return new Response("ok: 0 events", { status: 200 });
    }

    // 2) ¿cuáles ya conocemos? En wa_leads o en calendly_seen_events.
    const uriList = events.map((e) => esc(e.uri)).join(",");
    const [inLeads, inSeen] = await Promise.all([
      sb(`wa_leads?select=calendly_event_uri&calendly_event_uri=in.(${uriList})`),
      sb(`calendly_seen_events?select=event_uri&event_uri=in.(${uriList})`),
    ]);
    const seen = new Set<string>([
      ...(inLeads || []).map((r: any) => r.calendly_event_uri),
      ...(inSeen || []).map((r: any) => r.event_uri),
    ]);
    const missing = events.filter((e) => !seen.has(e.uri));

    if (!missing.length) {
      console.log(`[calendly-sync] ok — ${events.length} reuniones, ninguna pendiente`);
      return new Response(`ok: ${events.length} events, 0 missing`, { status: 200 });
    }

    console.warn(`[calendly-sync] ⚠️ ${missing.length} reunion(es) sin procesar — el webhook no las entregó`);

    // 3) traer el invitado de cada una
    const items: { ev: any; inv: any }[] = [];
    for (const ev of missing) {
      try {
        const inv = (await cal(`${ev.uri.replace(CAL_API, "")}/invitees`, token)).collection?.[0];
        if (inv) items.push({ ev, inv });
        else await markSeen(ev, "skipped", null, "");
      } catch (err: any) {
        console.error(`[calendly-sync] FALLO invitee evento=${ev.uri.split("/").pop()} :: ${err?.message || err}`);
      }
    }

    // 4) leads que ya existen con esos correos (una sola consulta)
    const emails = [...new Set(items.map((x) => (x.inv.email || "").trim()).filter(Boolean))];
    const variants = [...new Set(emails.flatMap((e) => [e, e.toLowerCase()]))];
    const existing: any[] = variants.length
      ? await sb(
          `wa_leads?select=id,email,meeting_start_time,calendly_event_uri&email=in.(${variants.map(esc).join(",")})&order=created_at.asc`
        )
      : [];
    const byEmail = new Map<string, any>();
    for (const l of existing || []) {
      const k = (l.email || "").toLowerCase();
      if (!byEmail.has(k)) byEmail.set(k, l);
    }

    // 5) procesar en orden de fecha: crear, fusionar o saltar
    items.sort((a, b) => String(a.ev.start_time).localeCompare(String(b.ev.start_time)));
    const inserted: string[] = [];
    const merged: string[] = [];

    for (const { ev, inv } of items) {
      const email = (inv.email || "").trim();
      const key = email.toLowerCase();
      const qa = inv.questions_and_answers || [];
      const active = ev.status !== "canceled";
      const when = new Date(ev.start_time).toLocaleString("es", { timeZone: "America/New_York" });

      try {
        const lead = key ? byEmail.get(key) : null;

        if (lead) {
          // Ya existe esa persona: no crear otro lead.
          const newer = !lead.meeting_start_time || String(ev.start_time) > String(lead.meeting_start_time);
          if (active && newer) {
            await sb(`wa_leads?id=eq.${lead.id}`, {
              method: "PATCH",
              headers: { Prefer: "return=minimal" },
              body: JSON.stringify({
                meeting_start_time: ev.start_time,
                meeting_end_time: ev.end_time,
                meeting_url: ev.location?.join_url || null,
                calendly_event_uri: ev.uri,
                calendly_invitee_uri: inv.uri,
                calendly_custom_answers: qa,
                updated_at: new Date().toISOString(),
              }),
            });
            lead.meeting_start_time = ev.start_time;
            merged.push(`${inv.name} <${email}> — ${when} (reunión agregada a su lead)`);
            await markSeen(ev, "merged", lead.id, email);
          } else {
            await markSeen(ev, "skipped", lead.id, email);
          }
          continue;
        }

        const business = answerFor(qa, "business");
        const channels = answerFor(qa, "canales") || answerFor(qa, "channels");
        const volume = answerFor(qa, "volumen") || answerFor(qa, "volume");
        const challenge = answerFor(qa, "reto") || answerFor(qa, "challenge");
        const site = answerFor(qa, "website") || answerFor(qa, "storefront");

        const rows: any[] = await sb("wa_leads", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            created_at: inv.created_at,
            // name, email y phone son NOT NULL sin default en wa_leads.
            name: inv.name || "(sin nombre)",
            email,
            phone: inv.text_reminder_number || "",
            country: mapCountry(answerFor(qa, "country")),
            language: isSpanish(inv.timezone) ? "es" : "en",
            service: mapService(channels, business),
            monthly_volume: volume || null,
            status: active ? "new" : "qualifying",
            source: "calendly_discovery_call",
            captured_by: "calendly_sync",
            notes:
              (challenge ? `Operational challenge: ${challenge}. ` : "") +
              (active ? "" : "[Reserva CANCELADA por el invitado] ") +
              `[Recuperado por calendly-sync — el webhook no entregó esta reserva]`,
            conversation_summary: [
              business && `💼 Business: ${business}`,
              volume && `📊 Volume: ${volume}`,
              channels && `🛒 Channels: ${channels}`,
              challenge && `⚡ Challenge: ${challenge}`,
              site && `🔗 URL: ${site}`,
            ]
              .filter(Boolean)
              .join("\n"),
            meeting_start_time: ev.start_time,
            meeting_end_time: ev.end_time,
            meeting_url: ev.location?.join_url || null,
            calendly_event_uri: ev.uri,
            calendly_invitee_uri: inv.uri,
            calendly_custom_answers: qa,
          }),
        });
        const newLead = rows?.[0];
        if (key && newLead) byEmail.set(key, { id: newLead.id, email, meeting_start_time: ev.start_time });
        await markSeen(ev, "inserted", newLead?.id || null, email);
        inserted.push(`${inv.name} <${email}> — ${when}${active ? "" : " (cancelada)"}`);
        console.log(`[calendly-sync] recuperado: ${inv.name} (${email})`);
      } catch (err: any) {
        console.error(
          `[calendly-sync] FALLO evento=${ev.uri.split("/").pop()} start=${ev.start_time} :: ${err?.message || err}`
        );
      }
    }

    console.log(`[calendly-sync] resultado: ${inserted.length} nuevos, ${merged.length} fusionados`);

    // 6) avisar — si esto suena, el webhook está roto y hay que revisarlo
    const alertTo = process.env.ALERT_EMAIL_TO || ALERT_TO_DEFAULT;
    if ((inserted.length || merged.length) && process.env.RESEND_API_KEY) {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "FR-Logistics <noreply@fr-logistics.net>",
          to: [alertTo],
          subject: `⚠️ Calendly: ${inserted.length} lead(s) nuevos recuperados — el webhook no entregó`,
          html:
            `<p>La sincronización horaria encontró reservas que el webhook de Calendly no entregó.</p>` +
            (inserted.length
              ? `<p><b>Leads nuevos creados en wa_leads:</b></p><ul>${inserted.map((r) => `<li>${r}</li>`).join("")}</ul>`
              : "") +
            (merged.length
              ? `<p><b>Reuniones agregadas a leads que ya existían:</b></p><ul>${merged.map((r) => `<li>${r}</li>`).join("")}</ul>`
              : "") +
            `<p>Vale la pena revisar la suscripción del webhook en Calendly.</p>`,
        }),
      }).catch((e) => console.error("[calendly-sync] alerta falló:", e?.message));
    }

    return new Response(`inserted ${inserted.length}, merged ${merged.length}, of ${missing.length}`, { status: 200 });
  } catch (err: any) {
    console.error("[calendly-sync] error:", err?.message || err);
    return new Response("error", { status: 500 });
  }
};

export const config: Config = {
  schedule: "@hourly",
};
