// netlify/functions/calendly-sync.mts
//
// RED DE SEGURIDAD PARA LOS LEADS DE CALENDLY
//
// Contexto (31-jul-2026): el webhook de Calendly dejó de entregar el 11 de
// junio y nadie se enteró. Siguieron entrando reservas con normalidad —18 en
// siete semanas— pero ninguna llegó a wa_leads. Se recuperaron a mano, pero
// el mismo fallo puede repetirse mañana y volver a pasar desapercibido.
//
// Esta función NO reemplaza al webhook: lo respalda. Corre cada hora, le
// pregunta a Calendly qué reuniones existen, y crea en wa_leads las que
// falten. Si el webhook funciona, no hace nada y termina en milisegundos.
// Si el webhook está caído, el peor retraso pasa de "para siempre" a "una
// hora" — y el log dice exactamente qué recuperó.
//
// ENV requeridas:
//   CALENDLY_TOKEN       — personal access token (calendly.com/integrations/api_webhooks)
//   CALENDLY_USER_URI    — https://api.calendly.com/users/<uuid>
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   ALERT_EMAIL_TO       — (opcional) a quién avisar cuando recupere algo
//   RESEND_API_KEY       — (opcional) para ese aviso

import type { Config } from "@netlify/functions";

const CAL_API = "https://api.calendly.com";

// Cuántos días hacia atrás y hacia adelante revisar en cada corrida.
// Hacia atrás poco (el webhook debería haberlas tomado), hacia adelante
// bastante porque la gente agenda con semanas de anticipación.
const LOOKBACK_DAYS = 10;
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

const isSpanish = (tz: string) => !/^(America\/New_York|America\/Chicago|America\/Denver|America\/Los_Angeles|Europe\/London)$/.test(tz || "");

// ── handler ─────────────────────────────────────────────────────────
export default async () => {
  const token = process.env.CALENDLY_TOKEN;
  const user = process.env.CALENDLY_USER_URI;
  if (!token || !user) {
    console.error("[calendly-sync] faltan CALENDLY_TOKEN o CALENDLY_USER_URI");
    return new Response("missing config", { status: 500 });
  }

  const now = Date.now();
  const min = new Date(now - LOOKBACK_DAYS * 864e5).toISOString();
  const max = new Date(now + LOOKAHEAD_DAYS * 864e5).toISOString();

  try {
    // 1) ¿qué reuniones conoce Calendly?
    const events = (
      await cal(
        `/scheduled_events?user=${encodeURIComponent(user)}&min_start_time=${min}&max_start_time=${max}&count=100&sort=start_time:asc`,
        token
      )
    ).collection as any[];

    if (!events?.length) {
      console.log("[calendly-sync] sin reuniones en la ventana");
      return new Response("ok: 0 events", { status: 200 });
    }

    // 2) ¿cuáles ya están en wa_leads? Una sola consulta, no una por evento.
    const uris = events.map((e) => e.uri);
    const known: any[] = await sb(
      `wa_leads?select=calendly_event_uri&calendly_event_uri=in.(${uris.map((u) => `"${u}"`).join(",")})`
    );
    const seen = new Set((known || []).map((r) => r.calendly_event_uri));
    const missing = events.filter((e) => !seen.has(e.uri));

    if (!missing.length) {
      console.log(`[calendly-sync] ok — ${events.length} reuniones, ninguna faltante`);
      return new Response(`ok: ${events.length} events, 0 missing`, { status: 200 });
    }

    console.warn(`[calendly-sync] ⚠️ ${missing.length} reunion(es) SIN lead — el webhook no las entregó`);

    // 3) crear las que faltan
    const recovered: string[] = [];
    for (const ev of missing) {
      try {
        const inv = (await cal(`${ev.uri.replace(CAL_API, "")}/invitees`, token)).collection?.[0];
        if (!inv) continue;

        const qa = inv.questions_and_answers || [];
        const business = answerFor(qa, "business");
        const channels = answerFor(qa, "canales") || answerFor(qa, "channels");
        const volume = answerFor(qa, "volumen") || answerFor(qa, "volume");
        const challenge = answerFor(qa, "reto") || answerFor(qa, "challenge");
        const site = answerFor(qa, "website") || answerFor(qa, "storefront");
        const lang = isSpanish(inv.timezone) ? "es" : "en";

        await sb("wa_leads", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            created_at: inv.created_at,
            // wa_leads tiene name, email y phone como NOT NULL sin default.
            // Calendly no siempre trae telefono: el campo "text_reminder_number"
            // solo existe si el invitado pidio recordatorio por SMS. Un one-off
            // sin ese dato reventaba el insert con violacion de not-null, que es
            // exactamente lo que fallo en la primera corrida del 31-jul-2026.
            name: inv.name || "(sin nombre)",
            email: inv.email || "",
            phone: inv.text_reminder_number || "",
            country: mapCountry(answerFor(qa, "country")),
            language: lang,
            service: mapService(channels, business),
            monthly_volume: volume || null,
            status: ev.status === "canceled" ? "qualifying" : "new",
            source: "calendly_discovery_call",
            captured_by: "calendly_sync",
            notes:
              (challenge ? `Operational challenge: ${challenge}. ` : "") +
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

        recovered.push(`${inv.name} <${inv.email}> — ${new Date(ev.start_time).toLocaleString("es")}`);
        console.log(`[calendly-sync] recuperado: ${inv.name} (${inv.email})`);
      } catch (err: any) {
        // El mensaje completo importa: la primera version fallaba aqui y el log
        // truncado no dejaba ver si era Calendly o Supabase.
        console.error(
          `[calendly-sync] FALLO evento=${ev.uri.split("/").pop()} start=${ev.start_time} :: ${err?.message || err}`
        );
      }
    }

    // 4) avisar — si esto suena, el webhook está roto y hay que revisarlo
    if (recovered.length && process.env.RESEND_API_KEY && process.env.ALERT_EMAIL_TO) {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "FR-Logistics <noreply@fr-logistics.net>",
          to: [process.env.ALERT_EMAIL_TO],
          subject: `⚠️ Calendly: ${recovered.length} lead(s) recuperados — el webhook no entregó`,
          html:
            `<p>La sincronización horaria encontró reservas que el webhook de Calendly no entregó. Ya están en wa_leads:</p><ul>` +
            recovered.map((r) => `<li>${r}</li>`).join("") +
            `</ul><p>Vale la pena revisar la suscripción del webhook en Calendly.</p>`,
        }),
      }).catch((e) => console.error("[calendly-sync] alerta falló:", e?.message));
    }

    return new Response(`recovered ${recovered.length}/${missing.length}`, { status: 200 });
  } catch (err: any) {
    console.error("[calendly-sync] error:", err?.message || err);
    return new Response("error", { status: 500 });
  }
};

export const config: Config = {
  schedule: "@hourly",
};
