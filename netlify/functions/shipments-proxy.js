// shipments-proxy.js — FR-Logistics Shipments Proxy
// Secure CRUD proxy for shipments_general table
// Replaces direct Supabase access from Inbound_Outbound.html
const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY");
const sbHeaders = {
  "apikey":        SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type":  "application/json",
  "Prefer":        "return=representation"
};
export default async (req) => {
  const method   = req.method;
  const url      = new URL(req.url);
  const tracking = url.searchParams.get("tracking");
  const client   = url.searchParams.get("client");
  const ecoOnly  = url.searchParams.get("eco") === "1";
  // ── GET ─────────────────────────────────────────────────────────
  if (method === "GET") {
    let endpoint;
    if (tracking) {
      // Single lookup by tracking number
      endpoint = `${SUPABASE_URL}/rest/v1/shipments_general?tracking=eq.${encodeURIComponent(tracking)}&limit=1`;
    } else if (client && ecoOnly) {
      // EcoPack+ pending count: inbounds & outbounds for a specific client with EcoPack type
      endpoint = `${SUPABASE_URL}/rest/v1/shipments_general?client=eq.${encodeURIComponent(client)}&type=like.*EcoPack*&select=direction&order=received_at.desc`;
    } else if (client) {
      endpoint = `${SUPABASE_URL}/rest/v1/shipments_general?client=eq.${encodeURIComponent(client)}&order=received_at.desc`;
    } else {
      // All shipments (inbound app log view)
      endpoint = `${SUPABASE_URL}/rest/v1/shipments_general?order=received_at.desc&limit=2000`;
    }
    const res  = await fetch(endpoint, { headers: sbHeaders });
    const data = await res.json();
    // If eco pending count request, compute and return count
    if (client && ecoOnly && Array.isArray(data)) {
      const inbound  = data.filter(r => r.direction === "Inbound").length;
      const outbound = data.filter(r => r.direction === "Outbound").length;
      return new Response(JSON.stringify({ count: Math.max(0, inbound - outbound) }), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify(data), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  }
  // ── POST — create shipment ───────────────────────────────────────
  if (method === "POST") {
    const body = await req.json();
    const res  = await fetch(`${SUPABASE_URL}/rest/v1/shipments_general`, {
      method: "POST",
      headers: sbHeaders,
      body: JSON.stringify(body)
    });
    const data = await res.json();
    return new Response(JSON.stringify(data), {
      status: 201, headers: { "Content-Type": "application/json" }
    });
  }
  // ── DELETE ───────────────────────────────────────────────────────
  if (method === "DELETE") {
    if (tracking) {
      // Single record delete by tracking number
      await fetch(
        `${SUPABASE_URL}/rest/v1/shipments_general?tracking=eq.${encodeURIComponent(tracking)}`,
        { method: "DELETE", headers: { ...sbHeaders, "Prefer": "return=minimal" } }
      );
      return new Response(JSON.stringify({ success: true, deleted: tracking }), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    }
    // No tracking param = wipe all (frontend confirms before calling)
    await fetch(
      `${SUPABASE_URL}/rest/v1/shipments_general?id=neq.00000000-0000-0000-0000-000000000000`,
      { method: "DELETE", headers: { ...sbHeaders, "Prefer": "return=minimal" } }
    );
    return new Response(JSON.stringify({ success: true }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  }
  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
};
