// netlify/functions/wa-push-subscribe.js
// POST  — register a new browser push subscription
// DELETE — remove an existing subscription by endpoint

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_KEY;

const __VERSION = "DEPLOY_MARKER_v3_1779134439590";
console.log("[wa-push-subscribe] LOADED VERSION:", __VERSION);

export default async function handler(req) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  // ─────────────────────────── POST: subscribe
  if (req.method === "POST") {
    try {
      const body = await req.json();
      const sub = body?.subscription;
      const userAgent = body?.userAgent || "";

      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
        return new Response(
          JSON.stringify({ ok: false, error: "Invalid subscription payload" }),
          { status: 400, headers: cors }
        );
      }

      const { error } = await supabase
        .from("wa_push_subscriptions")
        .upsert(
          {
            endpoint: sub.endpoint,
            p256dh: sub.keys.p256dh,
            auth: sub.keys.auth,
            user_agent: userAgent.slice(0, 500),
            active: true,
            last_used_at: new Date().toISOString(),
          },
          { onConflict: "endpoint" }
        );

      if (error) {
        console.error("[wa-push-subscribe] Supabase error:", error);
        return new Response(
          JSON.stringify({ ok: false, error: error.message }),
          { status: 500, headers: cors }
        );
      }

      return new Response(JSON.stringify({ ok: true, version: __VERSION }), {
        status: 200,
        headers: cors,
      });
    } catch (err) {
      console.error("[wa-push-subscribe] Exception:", err);
      return new Response(
        JSON.stringify({ ok: false, error: String(err?.message || err) }),
        { status: 500, headers: cors }
      );
    }
  }

  // ─────────────────────────── DELETE: unsubscribe
  if (req.method === "DELETE") {
    try {
      const body = await req.json();
      const endpoint = body?.endpoint;
      if (!endpoint) {
        return new Response(
          JSON.stringify({ ok: false, error: "Missing endpoint" }),
          { status: 400, headers: cors }
        );
      }
      const { error } = await supabase
        .from("wa_push_subscriptions")
        .update({ active: false })
        .eq("endpoint", endpoint);
      if (error) {
        return new Response(
          JSON.stringify({ ok: false, error: error.message }),
          { status: 500, headers: cors }
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: cors,
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ ok: false, error: String(err?.message || err) }),
        { status: 500, headers: cors }
      );
    }
  }

  return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
    status: 405,
    headers: cors,
  });
}
