// netlify/functions/quote-leads.js
// Secure read proxy for the Quote Builder "Import from Lead" feature.
//
// GET  /.netlify/functions/quote-leads            -> ranked, de-noised list of importable leads
// GET  /.netlify/functions/quote-leads?id={uuid}  -> single lead, full detail
// GET  /.netlify/functions/quote-leads?all=1       -> include noise (debug / full view)
// PATCH /.netlify/functions/quote-leads            -> advance a lead ({ id, status })
//
// wa_leads is under RLS, so this uses SUPABASE_SERVICE_KEY (server-side only).
// Follows the FR-Logistics proxy pattern (shipments-proxy.js, etc.).
//
// 2026-05-29 — Added noise filtering + quality scoring so the Quote Builder
// dropdown surfaces real, quotable leads first and hides internal/auto traffic.

const SUPA_URL = "https://rijbschnchjiuggrhfrx.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, PATCH, OPTIONS",
  "Content-Type": "application/json",
};

const FIELDS = [
  "id", "created_at", "name", "email", "phone", "country", "language",
  "service", "service_detail", "monthly_volume", "skus", "product_type",
  "origin", "destination", "status", "notes", "conversation_summary", "source",
].join(",");

// -- Noise rules -------------------------------------------------------------
// Internal numbers (Jose + FR-Logistics main line) that show up as "leads"
// because Liam logs every inbound. Add more here if needed.
const INTERNAL_PHONES = new Set(["+17863001443", "+17867757335"]);

// Liam's own out-of-hours autoresponder text (EN + ES).
const AUTORESPONDER = /thanks for reaching out|gracias por escribir|liam has logged|liam registró/i;

// Trivial openers with no business signal.
const TRIVIAL = new Set(["[sticker]", "hola", "hi", "hello", "hey", "ok", "gracias", "buenas", "."]);

function realEmail(l) {
  return !!l.email && !l.email.startsWith("pending+");
}

// Detect obviously-broken emails (typos) so a real-but-wrong address
// doesn't earn full quality credit.
function emailLooksOff(email) {
  if (!email) return true;
  if (email.startsWith("pending+")) return true;
  return !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email) ||
         /g[i1l]mail\.|gmial\.|hotmial\.|yaho\./i.test(email);
}

function isNoise(l) {
  const phone = (l.phone || "").replace(/\s/g, "");
  if (INTERNAL_PHONES.has(phone)) return true;
  if (AUTORESPONDER.test(l.service_detail || "")) return true;
  if ((l.name || "").trim() === ".") return true;

  // Trivial one-word opener AND no business data AND no real email = noise.
  const sd = (l.service_detail || "").trim().toLowerCase();
  if (TRIVIAL.has(sd) && !l.monthly_volume && !realEmail(l)) return true;

  return false;
}

// Quality score 0-3:  +1 stated volume  +1 valid real email  +1 advanced status
// A real-but-typo'd email earns nothing (gets flagged in the UI instead).
function scoreLead(l) {
  let s = 0;
  if (l.monthly_volume) s++;
  if (realEmail(l) && !emailLooksOff(l.email)) s++;
  if (l.status === "sent_to_sales" || l.status === "qualifying") s++;
  return s;
}

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase ${res.status}: ${body}`);
  }
  const txt = await res.text();
  return txt ? JSON.parse(txt) : [];
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }

  if (!SERVICE_KEY) {
    return { statusCode: 500, headers: CORS,
      body: JSON.stringify({ error: "SUPABASE_SERVICE_KEY not configured" }) };
  }

  try {
    // ---- Single lead by id ----
    if (event.httpMethod === "GET" && event.queryStringParameters?.id) {
      const id = encodeURIComponent(event.queryStringParameters.id);
      const rows = await sb(`wa_leads?id=eq.${id}&select=${FIELDS}`);
      if (!rows.length) {
        return { statusCode: 404, headers: CORS,
          body: JSON.stringify({ error: "Lead not found" }) };
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify(rows[0]) };
    }

    // ---- Ranked list of importable leads ----
    if (event.httpMethod === "GET") {
      const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
      const rows = await sb(
        `wa_leads?select=${FIELDS}` +
        `&status=in.(new,qualifying,sent_to_sales)` +
        `&created_at=gte.${since}` +
        `&order=created_at.desc&limit=80`
      );

      const includeAll = event.queryStringParameters?.all === "1";

      let list = rows.map(l => ({
        ...l,
        _score: scoreLead(l),
        _emailOff: emailLooksOff(l.email),
      }));

      if (!includeAll) {
        list = list.filter(l => !isNoise(l));
      }

      // Rank: quality score desc, then most recent first.
      list.sort((a, b) =>
        b._score - a._score ||
        new Date(b.created_at) - new Date(a.created_at)
      );

      return { statusCode: 200, headers: CORS, body: JSON.stringify(list) };
    }

    // ---- Advance a lead in the pipeline ----
    if (event.httpMethod === "PATCH") {
      const { id, status } = JSON.parse(event.body || "{}");
      if (!id) {
        return { statusCode: 400, headers: CORS,
          body: JSON.stringify({ error: "id required" }) };
      }
      const allowed = ["new", "qualifying", "sent_to_sales", "won", "lost"];
      const next = allowed.includes(status) ? status : "sent_to_sales";
      await sb(`wa_leads?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: next, updated_at: new Date().toISOString() }),
      });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, status: next }) };
    }

    return { statusCode: 405, headers: CORS,
      body: JSON.stringify({ error: "Method not allowed" }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS,
      body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
