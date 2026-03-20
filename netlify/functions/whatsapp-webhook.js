exports.handler = async function(event) {
  if (event.httpMethod === "GET") {
    const params    = event.queryStringParameters || {};
    const mode      = params["hub.mode"];
    const token     = params["hub.verify_token"];
    const challenge = params["hub.challenge"];

    if (mode === "subscribe" && token === "frlogistics_wa_2026" && challenge) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "text/plain" },
        body: challenge
      };
    }
    return { statusCode: 403, body: "Forbidden" };
  }

  return { statusCode: 200, body: "EVENT_RECEIVED" };
};
