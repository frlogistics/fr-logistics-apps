import type { Config } from "@netlify/functions";

export default async (req: Request) => {
  const url = new URL(req.url);

  // ── GET: Verificación de webhook de Meta ─────────────────────────────────
  if (req.method === "GET") {
    const mode      = url.searchParams.get("hub.mode");
    const token     = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    const secret    = Netlify.env.get("WHATSAPP_WEBHOOK_SECRET") ?? "";

    if (mode === "subscribe" && token === secret && challenge) {
      return new Response(challenge, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }
    return new Response("Forbidden", { status: 403 });
  }

  // ── POST: Eventos entrantes de Meta ──────────────────────────────────────
  if (req.method === "POST") {
    try {
      const body = await req.json();
      const messages = body?.entry?.[0]?.changes?.[0]?.value?.messages;
      if (messages?.length) {
        for (const msg of messages) {
          console.log(`[wa-webhook] de ${msg.from}: ${msg.text?.body ?? "(no texto)"}`);
        }
      }
    } catch (_) {}
    return new Response("EVENT_RECEIVED", { status: 200 });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = {
  path: "/api/whatsapp/webhook",
};
