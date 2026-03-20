import type { Context, Config } from "@netlify/functions";

// Meta llama a este endpoint con GET para verificar el webhook al configurarlo
// y con POST cada vez que llega un mensaje de un cliente
export default async (req: Request, _context: Context) => {

  // ── GET: Verificación de webhook que exige Meta ──────────────────────────
  if (req.method === "GET") {
    const url    = new URL(req.url);
    const mode   = url.searchParams.get("hub.mode");
    const token  = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    const verifyToken = Netlify.env.get("WHATSAPP_WEBHOOK_SECRET");

    if (mode === "subscribe" && token === verifyToken) {
      console.log("[whatsapp-webhook] Webhook verificado por Meta");
      return new Response(challenge ?? "", { status: 200 });
    }

    return new Response("Forbidden", { status: 403 });
  }

  // ── POST: Mensajes y notificaciones entrantes de Meta ────────────────────
  if (req.method === "POST") {
    try {
      const body = await req.json();

      // Extraer mensajes entrantes
      const entry = body?.entry?.[0];
      const changes = entry?.changes?.[0];
      const messages = changes?.value?.messages;

      if (messages?.length) {
        for (const msg of messages) {
          const from = msg.from;       // número del cliente
          const text = msg.text?.body; // texto si es mensaje de texto

          console.log(`[whatsapp-webhook] Mensaje de ${from}: ${text}`);

          // TODO: conectar con portal / Liam / CRM según necesidad
          // Ejemplo: guardar en Netlify Blobs, reenviar a Liam, etc.
        }
      }

      // Meta requiere respuesta 200 inmediata
      return new Response("EVENT_RECEIVED", { status: 200 });
    } catch (err) {
      console.error("[whatsapp-webhook] Error procesando evento:", err);
      return new Response("EVENT_RECEIVED", { status: 200 }); // siempre 200 a Meta
    }
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = {
  path: "/api/whatsapp/webhook",
};
