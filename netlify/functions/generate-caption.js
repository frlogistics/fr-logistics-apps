const Anthropic = require("@anthropic-ai/sdk");

const SYSTEM_PROMPTS = {
  srj: `You are a social media copywriter + creative director for @StrokeRunnerJourney.

BRAND: Jose — stroke survivor, marathon runner Miami FL. Ran Chicago Marathon 299 days post-stroke in 3:35:19 — one of the fastest documented stroke-to-marathon cases globally. Training for TCS NYC Marathon Nov 1 2026, goal 3:30:00. Runs with Achilles International at Tropical Park, Miami (Tue/Fri/Sun). Fundraising: give.achillesinternational.org/fundraiser/7121629. Brand colors: Navy #0F1D35, Teal #00B4AA, Red #CC2936. Font: Poppins.

If an image is provided, analyze it carefully and write the caption based on what you actually see. Mention specific visual details.

TONE: Authentic, inspiring, Spanglish OK, community-first. Not preachy — show don't tell. Running metaphors welcome.

Return ONLY this format:
CAPTION:
[150-200 words]

HASHTAGS:
[20-25 hashtags as one block]`,

  frl: `You are a social media copywriter + creative director for FR-Logistics Miami, Inc.

BUSINESS: Amazon SPN-certified 3PL in Doral FL. Owner Jose, 20+ yrs experience. 2000 sq ft warehouse at 10893 NW 17th St Unit 121, Doral FL 33172. FBA prep, FBM fulfillment, LTL/FTL, e-commerce logistics. EcoPack+ free package reception service. Target: LATAM brands entering US market. Colors: Navy, Teal, White.

If an image is provided, analyze it carefully and write the caption based on what you actually see.

TONE: Professional, bilingual Spanish primary / English secondary, authority + warmth.

Return ONLY this format:
CAPTION:
[130-180 words Spanish primary]

HASHTAGS:
[20-25 hashtags Spanish + English]`,
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  try {
    const { accountType, postType, brief, imageData, imageMediaType } =
      JSON.parse(event.body);

    if (!accountType || !SYSTEM_PROMPTS[accountType]) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid account type" }),
      };
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    let messageContent;
    if (imageData) {
      messageContent = [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: imageMediaType || "image/jpeg",
            data: imageData,
          },
        },
        {
          type: "text",
          text: `Post type: ${postType || "General"}\n${brief ? "Additional context: " + brief : "Write a compelling caption based on what you see in this image."}`,
        },
      ];
    } else {
      messageContent = [
        {
          type: "text",
          text: `Post type: ${postType || "General"}\n${brief || "Create an engaging post for this account."}`,
        },
      ];
    }

    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: SYSTEM_PROMPTS[accountType],
      messages: [{ role: "user", content: messageContent }],
    });

    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    const captionMatch = text.match(
      /CAPTION:\s*([\s\S]*?)(?=HASHTAGS:|$)/i
    );
    const hashMatch = text.match(/HASHTAGS:\s*([\s\S]*?)$/i);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        caption: captionMatch ? captionMatch[1].trim() : text,
        hashtags: hashMatch ? hashMatch[1].trim() : "",
        raw: text,
      }),
    };
  } catch (err) {
    console.error("Error:", err);
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
