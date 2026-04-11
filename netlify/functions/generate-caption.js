exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { systemPrompt, brief, accountType, postType, imageData, imageMediaType, language } = JSON.parse(event.body);

    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not configured');

    // Build user message content
    const userContent = [];

    if (imageData) {
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: imageMediaType || 'image/jpeg', data: imageData }
      });
    }

    const userText = brief
      ? `Generate a caption for this ${postType} post.\nAdditional context: ${brief}`
      : `Generate a caption for this ${postType} post.`;

    userContent.push({ type: 'text', text: userText });

    // ── PASS 1: Generate caption ──────────────────────────────
    const pass1 = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }]
      })
    });

    const data1 = await pass1.json();
    if (data1.error) throw new Error(data1.error.message || JSON.stringify(data1.error));
    const rawCaption = data1.content[0]?.text || '';

    // ── PASS 2: Language cleanup (only for single language) ───
    let finalText = rawCaption;

    if (language === 'en' || language === 'es') {
      const langInstruction = language === 'en'
        ? 'Rewrite the caption and hashtags below so that every single word is in ENGLISH. Remove all Spanish words, phrases, or sentences. Keep the same meaning, emojis, hashtags structure, and format. Do not add new content — only translate/remove non-English text.\n\nReturn the result in the same format:\nCAPTION:\n[text]\n\nHASHTAGS:\n[hashtags]'
        : 'Rewrite the caption y hashtags a continuación de modo que cada palabra esté en ESPAÑOL. Elimina todas las palabras, frases u oraciones en inglés. Mantén el mismo significado, emojis, estructura de hashtags y formato. No agregues contenido nuevo — solo traduce/elimina el texto que no esté en español.\n\nDevuelve el resultado en el mismo formato:\nCAPTION:\n[texto]\n\nHASHTAGS:\n[hashtags]';

      const pass2 = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-opus-4-5',
          max_tokens: 1024,
          messages: [
            {
              role: 'user',
              content: langInstruction + '\n\n---\n\n' + rawCaption
            }
          ]
        })
      });

      const data2 = await pass2.json();
      if (!data2.error) {
        finalText = data2.content[0]?.text || rawCaption;
      }
    }

    // ── Parse caption + hashtags ──────────────────────────────
    let caption = finalText;
    let hashtags = '';

    const capMatch = finalText.match(/CAPTION:\s*([\s\S]*?)(?=HASHTAGS:|$)/i);
    const hashMatch = finalText.match(/HASHTAGS:\s*([\s\S]*?)$/i);

    if (capMatch) caption = capMatch[1].trim();
    if (hashMatch) hashtags = hashMatch[1].trim();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ caption, hashtags })
    };

  } catch (err) {
    console.error('generate-caption error:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
