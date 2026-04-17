// netlify/functions/mxs-sheet-data.js
// Read-only proxy for MXS Overseas Ltd inbounds
// Called by Google Apps Script (MXS_SheetSync.gs) daily at 5 PM EST

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type":                 "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "GET")     return { statusCode: 405, headers, body: JSON.stringify({ error: "GET only" }) };

  try {
    const url = `${SUPABASE_URL}/rest/v1/shipments_general`
      + `?client=eq.MXS%20Overseas%20Ltd`
      + `&order=received_at.desc`
      + `&limit=2000`
      + `&select=received_at,tracking,carrier,type,notes,direction`;

    const res  = await fetch(url, {
      headers: {
        "apikey":        SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Content-Type":  "application/json",
      }
    });

    if (!res.ok) {
      const err = await res.text();
      return { statusCode: res.status, headers, body: JSON.stringify({ error: err }) };
    }

    const data = await res.json();
    return { statusCode: 200, headers, body: JSON.stringify({ count: data.length, records: data }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
