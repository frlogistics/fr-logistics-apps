// netlify/functions/inventory-debug.js
// TEMPORARY DEBUG FUNCTION — safe to delete after verification.
//
// Purpose: inspect the RAW shape of SkuVault's getProducts response, so we
// can confirm whether the "Client" field (visible in the SkuVault UI and the
// CSV export) is also exposed via the REST API. This is needed before
// building portal-inventory.js for Fase 2.
//
// Usage:
//   https://apps.fr-logistics.net/.netlify/functions/inventory-debug
//
// What it does:
//   - Calls getProducts on SkuVault with a small page size (5 items).
//   - Returns the list of all field names present on the first product,
//     plus the full first product as-is, plus a sample of how the field
//     "Client" (if present) is filled for the first few SKUs.
//
// Read-only. Does NOT modify anything in SkuVault, Supabase, or your portal.
// Once we've read the output, delete this file from the repo.

const SKUVAULT_BASE = "https://app.skuvault.com/api";

exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const token = process.env.SKUVAULT_TENANT_TOKEN;
  if (!token) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "SKUVAULT_TENANT_TOKEN not configured" }),
    };
  }
  const [tenantToken, userToken] = token.split("|");

  try {
    const res = await fetch(SKUVAULT_BASE + "/products/getProducts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        TenantToken: tenantToken,
        UserToken: userToken,
        PageNumber: 0,
        PageSize: 5,
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: "SkuVault error " + res.status, detail }),
      };
    }

    const data = await res.json();
    const products = data.Products || [];
    if (!products.length) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: "No products returned", raw: data }),
      };
    }

    // Field names present on the first product (so we can see all available
    // top-level fields).
    const firstProductFieldNames = Object.keys(products[0]).sort();

    // Quick view of how "Client" (or anything client-like) appears across
    // the first 5 SKUs. We look at common candidate field names.
    const candidateFieldNames = [
      'Client', 'ClientName',
      'Supplier', 'Suppliers', 'PrimarySupplier',
      'Brand', 'Classification',
      'Customer', 'CustomerName',
      'CustomFields', 'Attributes',
    ];
    const candidateView = products.map((p) => {
      const view = { Sku: p.Sku };
      for (const f of candidateFieldNames) {
        if (p[f] !== undefined) view[f] = p[f];
      }
      return view;
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(
        {
          summary: {
            totalAvailable: data.TotalAvailable,
            returnedCount: products.length,
            firstProductFieldNames,
          },
          firstProductRaw: products[0],
          candidateFieldsAcrossFirst5: candidateView,
        },
        null,
        2
      ),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Server error", detail: String(err) }),
    };
  }
};
