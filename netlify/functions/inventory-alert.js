const SUPA_URL = "https://rijbschnchjiuggrhfrx.supabase.co";
const SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJpamJzY2huY2hqaXVnZ3JoZnJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzMTQwOTQsImV4cCI6MjA4ODg5MDA5NH0.s3T4CStjWqOvz7qDpYtjt0yVJ0iyOMAKKwxkADSEs4s";
const RESEND_KEY = "re_aYwqDPhY_HyjPCpFEH1t8ZMaygzTgr1kF";

function fmtDate(d) {
  return new Date(d).toLocaleDateString("en-US", { month:"short", day:"2-digit", year:"numeric" });
}

async function getSkuVaultProducts() {
  const raw = process.env.SKUVAULT_TENANT_TOKEN || "";
  const [tenantToken, userToken] = raw.split("|");
  if (!tenantToken || !userToken) throw new Error("SkuVault tokens not configured");

  const res = await fetch("https://app.skuvault.com/api/products/getProducts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ TenantToken: tenantToken, UserToken: userToken, PageNumber: 0, PageSize: 10000 })
  });
  if (!res.ok) throw new Error(`SkuVault ${res.status}`);
  const data = await res.json();
  return data.Products || [];
}

async function getClients() {
  const res = await fetch(
    `${SUPA_URL}/rest/v1/wa_clients?order=name.asc&limit=200`,
    { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data || []).map(c => ({
    id: c.id, name: c.name, email: c.email,
    waNumber: c.wa_number, storeName: c.store_name,
    active: c.active
  }));
}

async function sendWhatsApp(to, message) {
  const token   = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  // Send as text message (free-form within 24hr window won't work for outbound)
  // Use notify function endpoint instead
  const res = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: message }
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function sendEmail(to, subject, body) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "FR-Logistics Miami <warehouse@fr-logistics.net>",
      to: [to],
      subject,
      text: body
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

exports.handler = async function(event) {
  const dateStr = fmtDate(new Date());
  console.log(`[inventory-alert] Running for ${dateStr}`);

  try {
    // Get all products from SkuVault
    const products = await getSkuVaultProducts();
    console.log(`[inventory-alert] ${products.length} products fetched`);

    // Filter low stock: QuantityAvailable <= ReorderPoint
    const lowStock = products.filter(p => {
      const qty = p.QuantityAvailable ?? p.QuantityOnHand ?? 0;
      const reorder = p.ReorderPoint ?? 0;
      return reorder > 0 && qty <= reorder;
    });

    console.log(`[inventory-alert] ${lowStock.length} low stock items found`);

    if (!lowStock.length) {
      console.log("[inventory-alert] No low stock items today");
      return { statusCode: 200, body: "No low stock items" };
    }

    // Get clients to match by supplier/code
    const clients = await getClients();

    // Build alert message for Jose (owner)
    const ownerLines = lowStock.map(p => {
      const qty = p.QuantityAvailable ?? p.QuantityOnHand ?? 0;
      return `⚠️ SKU: ${p.Sku}\n   Available: ${qty} units (Reorder point: ${p.ReorderPoint})`;
    }).join("\n\n");

    const ownerMsg = `⚠️ Low Stock Alert — ${dateStr}\nFR-Logistics Miami\n\n${ownerLines}\n\nTotal items below reorder point: ${lowStock.length}`;

    // Send to Jose first
    const joseEmail = "warehouse@fr-logistics.net";
    try {
      await sendEmail(joseEmail, `⚠️ Low Stock Alert — ${dateStr}`, ownerMsg);
      console.log(`[inventory-alert] Alert sent to Jose`);
    } catch(e) { console.error(`[inventory-alert] Jose email error:`, e.message); }

    // Group low stock by supplier/client if available
    // Try to match SupplierCode or Code with client storeName
    const byClient = {};
    for (const p of lowStock) {
      const supplier = p.SupplierCode || p.Supplier || "";
      if (!supplier) continue;
      const client = clients.find(c => c.active &&
        (c.storeName || "").toLowerCase() === supplier.toLowerCase());
      if (client) {
        if (!byClient[client.name]) byClient[client.name] = { client, items: [] };
        byClient[client.name].items.push(p);
      }
    }

    // Send to each client
    for (const [clientName, { client, items }] of Object.entries(byClient)) {
      const qty = items[0].QuantityAvailable ?? items[0].QuantityOnHand ?? 0;
      const clientMsg = `⚠️ Low Stock Alert / Inventario Bajo\nFR-Logistics Miami — ${dateStr}\n\n` +
        items.map(p => {
          const q = p.QuantityAvailable ?? p.QuantityOnHand ?? 0;
          return `SKU: ${p.Sku}\nAvailable / Disponible: ${q} units\nRecommended action: Replenish inventory\nAcción recomendada: Reabastecer inventario`;
        }).join("\n\n");

      if (client.waNumber) {
        try {
          await sendWhatsApp(client.waNumber, clientMsg);
          console.log(`[inventory-alert] WA sent to ${clientName}`);
        } catch(e) { console.error(`[inventory-alert] WA error ${clientName}:`, e.message); }
      } else if (client.email) {
        try {
          await sendEmail(client.email, `⚠️ Low Stock Alert — ${dateStr}`, clientMsg);
          console.log(`[inventory-alert] Email sent to ${clientName}`);
        } catch(e) { console.error(`[inventory-alert] Email error ${clientName}:`, e.message); }
      }
    }

    return { statusCode: 200, body: `Done. ${lowStock.length} low stock items processed.` };
  } catch(e) {
    console.error("[inventory-alert] Fatal:", e.message);
    return { statusCode: 500, body: e.message };
  }
};
