const { getStore } = require("@netlify/blobs");

exports.handler = async function(event) {
  const store = getStore({ name: "wa-messages", consistency: "strong" });
  const method = event.httpMethod;

  try {
    if (method === "GET") {
      const params = event.queryStringParameters || {};
      const limit = parseInt(params.limit || "50");

      const result = await store.get("messages", { type: "json" }) || [];
      const sorted = result.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sorted.slice(0, limit))
      };
    }

    if (method === "POST") {
      const body = JSON.parse(event.body || "{}");
      const messages = await store.get("messages", { type: "json" }) || [];

      if (body.action === "mark_read") {
        const idx = messages.findIndex(m => m.id === body.id);
        if (idx !== -1) {
          messages[idx].read = true;
          await store.setJSON("messages", messages);
        }
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === "add_outbound") {
        const msg = {
          id: Date.now().toString(),
          direction: "outbound",
          to: body.to,
          clientName: body.clientName || "",
          template: body.template || "",
          text: body.text || "",
          timestamp: new Date().toISOString(),
          status: "sent",
          read: true
        };
        messages.push(msg);
        if (messages.length > 500) messages.splice(0, messages.length - 500);
        await store.setJSON("messages", messages);
        return { statusCode: 200, body: JSON.stringify({ ok: true, message: msg }) };
      }
    }

    return { statusCode: 405, body: "Method not allowed" };
  } catch (err) {
    console.error("[wa-messages]", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
