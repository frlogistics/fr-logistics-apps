exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { caption, imageBase64, accountType } = JSON.parse(event.body);

    // Select credentials based on account
    const ACCESS_TOKEN = accountType === 'frl'
      ? process.env.IG_ACCESS_TOKEN_FRL
      : process.env.IG_ACCESS_TOKEN_SRJ;

    const USER_ID = accountType === 'frl'
      ? process.env.IG_USER_ID_FRL
      : process.env.IG_USER_ID_SRJ;

    if (!ACCESS_TOKEN || !USER_ID) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Instagram credentials not configured for this account' }) };
    }

    // Step 1: Upload image to a temporary hosting (Imgur free API)
    // Meta requires a public URL — we upload to Imgur first
    const imgurRes = await fetch('https://api.imgur.com/3/image', {
      method: 'POST',
      headers: {
        'Authorization': 'Client-ID ' + (process.env.IMGUR_CLIENT_ID || '546c25a59c58ad7'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ image: imageBase64, type: 'base64' })
    });

    const imgurData = await imgurRes.json();
    if (!imgurData.success) throw new Error('Image upload failed: ' + JSON.stringify(imgurData));
    const imageUrl = imgurData.data.link;

    // Step 2: Create media container on Instagram
    const containerRes = await fetch(
      `https://graph.facebook.com/v19.0/${USER_ID}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_url: imageUrl,
        caption: caption,
        access_token: ACCESS_TOKEN
      })
    });

    const containerData = await containerRes.json();
    if (containerData.error) throw new Error('Container error: ' + containerData.error.message);
    const containerId = containerData.id;

    // Step 3: Wait for container to be ready (up to 30 seconds)
    let status = 'IN_PROGRESS';
    let attempts = 0;
    while (status === 'IN_PROGRESS' && attempts < 10) {
      await new Promise(r => setTimeout(r, 3000));
      const statusRes = await fetch(
        `https://graph.facebook.com/v19.0/${containerId}?fields=status_code&access_token=${ACCESS_TOKEN}`
      );
      const statusData = await statusRes.json();
      status = statusData.status_code;
      attempts++;
    }

    if (status !== 'FINISHED') throw new Error('Media container not ready: ' + status);

    // Step 4: Publish the container
    const publishRes = await fetch(
      `https://graph.facebook.com/v19.0/${USER_ID}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creation_id: containerId,
        access_token: ACCESS_TOKEN
      })
    });

    const publishData = await publishRes.json();
    if (publishData.error) throw new Error('Publish error: ' + publishData.error.message);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        postId: publishData.id,
        message: 'Post publicado exitosamente en Instagram'
      })
    };

  } catch (err) {
    console.error('Instagram publish error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
