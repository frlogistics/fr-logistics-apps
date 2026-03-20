import type { Context, Config } from "@netlify/functions";

const GRAPH_API = "https://graph.facebook.com/v19.0";

interface SendMessagePayload {
  to: string;           // número destino con código de país, ej: "5215512345678"
  type: "text" | "template";
  text?: string;
  templateName?: string;
  templateLanguage?: string;
  templateParams?: string[];
}

// Envía un mensaje de WhatsApp via Meta Cloud API
async function sendWhatsAppMessage(payload: SendMessagePayload) {
  const phoneId = Netlify.env.get("WHATSAPP_PHONE_ID");
  const token   = Netlify.env.get("WHATSAPP_TOKEN");

  if (!phoneId || !token) {
    throw new Error("Faltan variables WHATSAPP_PHONE_ID o WHATSAPP_TOKEN");
  }

  let body: Record<string, unknown>;

  if (payload.type === "text" && payload.text) {
    body = {
      messaging_product: "whatsapp",
      to: payload.to,
      type: "text",
      text: { body: payload.text },
    };
  } else if (payload.type === "template" && payload.templateName) {
    body = {
      messaging_product: "whatsapp",
      to: payload.to,
      type: "template",
      template: {
        name: payload.templateName,
        language: { code: payload.templateLanguage ?? "es" },
        components: payload.templateParams?.length
          ? [{
              type: "body",
              parameters: payload.templateParams.map((p) => ({
                type: "text",
                text: p,
              })),
            }]
          : [],
      },
    };
  } else {
    throw new Error("Payload inválido: se requiere text o templateName");
  }

  const res = await fetch(`${GRAPH_API}/${phoneId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Meta API error: ${JSON.stringify(data)}`);
  }

  return data;
}

export default async (req: Request, _context: Context) => {
  // Solo acepta POST
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Validación básica de origen interno (ShipStation webhook o portal)
  const authHeader = req.headers.get("x-fr-secret");
  const internalSecret = Netlify.env.get("WHATSAPP_WEBHOOK_SECRET");

  if (!authHeader || authHeader !== internalSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const payload: SendMessagePayload = await req.json();

    if (!payload.to) {
      return new Response(
        JSON.stringify({ error: "Campo 'to' requerido" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const result = await sendWhatsAppMessage(payload);

    return new Response(JSON.stringify({ success: true, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    console.error("[whatsapp-notify]", message);
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const config: Config = {
  path: "/api/whatsapp/send",
};
