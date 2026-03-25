exports.handler = async function(event) {
  const raw = process.env.SKUVAULT_TENANT_TOKEN || "";
  const [tenantToken, userToken] = raw.split("|");

  try {
    let allProducts = [];
    let page = 0;

    while(true) {
      const res = await fetch("https://app.skuvault.com/api/products/getProducts", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ TenantToken: tenantToken, UserToken: userToken, PageNumber: page, PageSize: 500 })
      });
      if (!res.ok) throw new Error(`SkuVault ${res.status}`);
      const data = await res.json();
      const products = data.Products || [];
      if (!products.length) break;
      allProducts = allProducts.concat(products);
      if (products.length < 500) break;
      page++;
    }

    const rows = [["SKU","Description","Current Reorder Point","New Reorder Point","Qty Available"]];
    for (const p of allProducts) {
      rows.push([
        p.Sku || "",
        (p.Description || "").replace(/"/g,'""'),
        p.ReorderPoint ?? 0,
        p.ReorderPoint ?? 0,
        p.QuantityAvailable ?? 0
      ]);
    }

    const csv = rows.map(r => r.map(v => `"${v}"`).join(",")).join("\n");

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="skuvault_reorder_${new Date().toISOString().slice(0,10)}.csv"`
      },
      body: csv
    };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
