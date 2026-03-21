const SITE_ID = "9762f903-d555-4532-a78f-9f9784684adc";

exports.handler = async function(event) {
  const token = process.env.NETLIFY_API_TOKEN;
  const url   = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/wa-messages/messages`;
  const method = event.httpMethod;
  const hdr   = { "Content-Type": "application/json" };

  async function get() {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`Blobs GET ${r.status}`);
    return r.json();
  }

  async function put(data) {
    const r = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
    if (!r.ok) throw new Error(`Blobs PUT ${r.status}: ${await r.text()}`);
  }

  try {
    if (method === "GET") {
      const msgs = await get();
      return { statusCode: 200, headers: hdr, body: JSON.stringify(msgs.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0,100)) };
    }

    if (method === "POST") {
      const body = JSON.parse(event.body || "{}");
      let msgs = await get();

      if (body.action === "mark_read") {
        const i = msgs.findIndex(m => m.id === body.id);
        if (i !== -1) msgs[i].read = true;
        await put(msgs);
        return { statusCode: 200, headers: hdr, body: JSON.stringify({ ok: true }) };
      }
      if (body.action === "add_outbound") {
        msgs.push({ id: Date.now().toString(), direction: "outbound", to: body.to, clientName: body.clientName||"", template: body.template||"", text: body.text||"", timestamp: new Date().toISOString(), status: "sent", read: true });
        if (msgs.length > 500) msgs.splice(0, msgs.length - 500);
        await put(msgs);
        return { statusCode: 200, headers: hdr, body: JSON.stringify({ ok: true }) };
      }
    }

    return { statusCode: 405, body: "Method not allowed" };
  } catch (err) {
    console.error("[wa-messages]", err.message);
    return { statusCode: 500, headers: hdr, body: JSON.stringify({ error: err.message }) };
  }
};
