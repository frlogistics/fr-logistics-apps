const SITE_ID = "9762f903-d555-4532-a78f-9f9784684adc";

exports.handler = async function(event) {
  const token = process.env.NETLIFY_API_TOKEN;
  const url   = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/wa-clients/clients`;
  const method = event.httpMethod;

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

  const hdr = { "Content-Type": "application/json" };

  try {
    if (method === "GET") {
      return { statusCode: 200, headers: hdr, body: JSON.stringify(await get()) };
    }

    if (method === "POST") {
      const body = JSON.parse(event.body || "{}");
      let list = await get();

      if (body.action === "save_all") {
        await put(body.clients);
        return { statusCode: 200, headers: hdr, body: JSON.stringify({ ok: true }) };
      }
      if (body.action === "add") {
        const c = { id: Date.now().toString(), ...body };
        delete c.action;
        list.push(c);
        await put(list);
        return { statusCode: 200, headers: hdr, body: JSON.stringify({ ok: true, client: c }) };
      }
      if (body.action === "update") {
        const i = list.findIndex(c => c.id === body.id);
        if (i !== -1) list[i] = { ...list[i], ...body.data };
        await put(list);
        return { statusCode: 200, headers: hdr, body: JSON.stringify({ ok: true }) };
      }
      if (body.action === "delete") {
        await put(list.filter(c => c.id !== body.id));
        return { statusCode: 200, headers: hdr, body: JSON.stringify({ ok: true }) };
      }
    }

    return { statusCode: 405, body: "Method not allowed" };
  } catch (err) {
    console.error("[wa-clients]", err.message);
    return { statusCode: 500, headers: hdr, body: JSON.stringify({ error: err.message }) };
  }
};
