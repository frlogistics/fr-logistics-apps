const { getStore } = require("@netlify/blobs");

exports.handler = async function(event) {
  if (event.httpMethod === "GET") {
    const params = event.queryStringParameters || {};
    const mode      = params["hub.mode"];
    const token     = params["hub.verify_token"];
    const challenge = params["hub.challenge"];

    if (mode === "subscribe" && token === "frlogistics_wa_2026" && challenge) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "text/plain" },
        body: challenge
      };
    }
    return { statusCode: 403, body: "Forbidden" };
  }

  if (event.httpMethod === "POST") {
    try {
      const body = JSON.parse(event.body || "{}");
      const messages = body?.entry?.[0]?.changes?.[0]?.value?.messages;

      if (messages?.length) {
        const store = getStore({ name: "wa-messages", consistency: "strong" });
        const existing = await store.get("messages", { type: "json" }) || [];

        for (const msg of messages) {
          const inbound = {
            id: msg.id || Date.now().toString(),
            direction: "inbound",
            from: msg.from,
            text: msg.text?.body || "",
            type: msg.type || "text",
            timestamp: new Date(parseInt(msg.timestamp) * 1000).toISOString(),
            read: false,
            status: "received"
          };
          if (!existing.find(m => m.id === inbound.id)) {
            existing.push(inbound);
          }
        }

        if (existing.length > 500) existing.splice(0, existing.length - 500);
        await store.setJSON("messages", existing);
      }
    } catch (err) {
      console.error("[wa-webhook]", err);
    }
    return { statusCode: 200, body: "EVENT_RECEIVED" };
  }

  return { statusCode: 405, body: "Method not allowed" };
};
