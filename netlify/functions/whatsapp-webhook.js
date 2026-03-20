exports.handler = async function(event) {
  if (event.httpMethod === "GET") {
    const mode      = event.queryStringParameters["hub.mode"];
    const token     = event.queryStringParameters["hub.verify_token"];
    const challenge = event.queryStringParameters["hub.challenge"];

    if (mode === "subscribe" && token === process.env.WHATSAPP_WEBHOOK_SECRET) {
      return { statusCode: 200, body: challenge };
    }
    return { statusCode: 403, body: "Forbidden" };
  }

  return { statusCode: 200, body: "EVENT_RECEIVED" };
};
