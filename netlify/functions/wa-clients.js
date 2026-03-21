const { getStore } = require("@netlify/blobs");

exports.handler = async function(event) {
  const store = getStore({ name: "wa-clients", consistency: "strong" });
  const method = event.httpMethod;

  try {
    if (method === "GET") {
      const result = await store.get("clients", { type: "json" });
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result || [])
      };
    }

    if (method === "POST") {
      const body = JSON.parse(event.body || "{}");
      const clients = await store.get("clients", { type: "json" }) || [];

      if (body.action === "save_all") {
        await store.setJSON("clients", body.clients);
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === "add") {
        const newClient = {
          id: Date.now().toString(),
          name: body.name || "",
          company: body.company || "",
          email: body.email || "",
          phone: body.phone || "",
          country: body.country || "US",
          waNumber: body.waNumber || "",
          storeId: body.storeId || "",
          storeName: body.storeName || "",
          active: body.active || false,
          notes: body.notes || "",
          createdAt: new Date().toISOString()
        };
        clients.push(newClient);
        await store.setJSON("clients", clients);
        return { statusCode: 200, body: JSON.stringify({ ok: true, client: newClient }) };
      }

      if (body.action === "update") {
        const idx = clients.findIndex(c => c.id === body.id);
        if (idx === -1) return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
        clients[idx] = { ...clients[idx], ...body.data, updatedAt: new Date().toISOString() };
        await store.setJSON("clients", clients);
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === "delete") {
        const filtered = clients.filter(c => c.id !== body.id);
        await store.setJSON("clients", filtered);
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }
    }

    return { statusCode: 405, body: "Method not allowed" };
  } catch (err) {
    console.error("[wa-clients]", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
