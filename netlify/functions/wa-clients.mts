import { getStore } from "@netlify/blobs";

const STORE_NAME = "fr-clients-master";

function normalizeClient(c: any) {
  const waNumber  = c.wa_number  || c.waNumber  || "";
  const waConsent = c.wa_consent || c.waConsent || "Pending";
  const status    = c.status || (c.active ? "Active" : "Inactive");

  let services: string[] = [];
  if (Array.isArray(c.services)) {
    services = c.services;
  } else if (typeof c.services === "string" && c.services.length > 0) {
    services = c.services.split(",").map((s: string) => s.trim()).filter(Boolean);
  }

  return {
    id:        c.id        || String(Date.now()) + Math.random().toString(36).slice(2, 8),
    name:      c.name      || "",
    company:   c.company   || "",
    storeName: c.store_name || c.storeName || "",
    storeId:   c.store_id  || c.storeId   || "",
    country:   c.country   || "US",
    lang:      c.lang      || "EN",
    type:      c.type      || "Business",
    wa_number: waNumber,
    waNumber,
    email:     c.email     || "",
    phone:     c.phone     || "",
    services,
    status,
    active:    status === "Active",
    wa_consent: waConsent,
    waConsent,
    notes:     c.notes     || "",
  };
}

export default async (req: Request) => {
  const headers = { "Content-Type": "application/json" };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  // strong consistency = reads reflect writes immediately, across all devices
  const store = getStore({ name: STORE_NAME, consistency: "strong" });

  // GET
  if (req.method === "GET") {
    try {
      const raw = await store.get("clients", { type: "json" });
      const clients = Array.isArray(raw) ? raw.map(normalizeClient) : [];
      console.log(`[wa-clients] GET → ${clients.length} clients`);
      return new Response(JSON.stringify(clients), { status: 200, headers });
    } catch (err) {
      console.error("[wa-clients] GET error:", err);
      return new Response(JSON.stringify([]), { status: 200, headers });
    }
  }

  // POST
  if (req.method === "POST") {
    let body: any = {};
    try { body = await req.json(); } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers });
    }

    if (body.action === "save_all") {
      try {
        const clients = Array.isArray(body.clients) ? body.clients.map(normalizeClient) : [];
        await store.setJSON("clients", clients);
        console.log(`[wa-clients] save_all → ${clients.length} clients saved`);
        return new Response(JSON.stringify({ ok: true, saved: clients.length }), { status: 200, headers });
      } catch (err) {
        console.error("[wa-clients] save_all error:", err);
        return new Response(JSON.stringify({ error: "save failed", detail: String(err) }), { status: 500, headers });
      }
    }

    if (body.action === "upsert" && body.client) {
      try {
        const existing: any[] = (await store.get("clients", { type: "json" })) || [];
        const client = normalizeClient(body.client);
        const idx = existing.findIndex((c: any) => c.id === client.id);
        if (idx >= 0) existing[idx] = client; else existing.push(client);
        await store.setJSON("clients", existing);
        return new Response(JSON.stringify({ ok: true, client }), { status: 200, headers });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers });
      }
    }

    if (body.action === "delete" && body.id) {
      try {
        const existing: any[] = (await store.get("clients", { type: "json" })) || [];
        const filtered = existing.filter((c: any) => c.id !== body.id);
        await store.setJSON("clients", filtered);
        return new Response(JSON.stringify({ ok: true, remaining: filtered.length }), { status: 200, headers });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers });
      }
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), { status: 400, headers });
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
};
