// netlify/functions/wa-push-vapid-key.js
// GET — returns the VAPID public key so the browser can subscribe

export default async function handler() {
  const publicKey = process.env.VAPID_PUBLIC_KEY || "";
  return new Response(JSON.stringify({ publicKey }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
