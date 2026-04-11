exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { caption, imageBase64, images, videoUrl, accountType, mode = 'post' } = JSON.parse(event.body);
    const ACCESS_TOKEN = accountType === 'frl' ? process.env.IG_ACCESS_TOKEN_FRL : process.env.IG_ACCESS_TOKEN_SRJ;
    const USER_ID = accountType === 'frl' ? process.env.IG_USER_ID_FRL : process.env.IG_USER_ID_SRJ;
    if (!ACCESS_TOKEN || !USER_ID) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Credenciales no configuradas' }) };

    async function uploadToImgur(b64) {
      const r = await fetch('https://api.imgur.com/3/image', {
        method: 'POST',
        headers: { 'Authorization': 'Client-ID ' + process.env.IMGUR_CLIENT_ID, 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: b64, type: 'base64' })
      });
      const d = await r.json();
      if (!d.success) throw new Error('Imgur: ' + (d.data?.error || JSON.stringify(d)));
      return d.data.link;
    }

    async function createContainer(params) {
      const r = await fetch(`https://graph.facebook.com/v21.0/${USER_ID}/media`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...params, access_token: ACCESS_TOKEN })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      return d.id;
    }

    async function waitReady(id, max = 15, interval = 3000) {
      for (let i = 0; i < max; i++) {
        await new Promise(r => setTimeout(r, interval));
        const r = await fetch(`https://graph.facebook.com/v21.0/${id}?fields=status_code&access_token=${ACCESS_TOKEN}`);
        const d = await r.json();
        if (d.status_code === 'FINISHED') return;
        if (d.status_code === 'ERROR') throw new Error('Container failed');
      }
      throw new Error('Container timed out');
    }

    async function publish(cid) {
      const r = await fetch(`https://graph.facebook.com/v21.0/${USER_ID}/media_publish`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creation_id: cid, access_token: ACCESS_TOKEN })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      return d.id;
    }

    if (mode === 'post') {
      const url = await uploadToImgur(imageBase64);
      const cid = await createContainer({ image_url: url, caption });
      await waitReady(cid);
      const pid = await publish(cid);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, postId: pid, message: 'Post publicado ✅' }) };
    }

    if (mode === 'carousel') {
      if (!images || images.length < 2) throw new Error('Mínimo 2 imágenes');
      const childIds = [];
      for (const b64 of images) {
        const url = await uploadToImgur(b64);
        const cid = await createContainer({ image_url: url, is_carousel_item: true });
        childIds.push(cid);
      }
      const cid = await createContainer({ media_type: 'CAROUSEL', children: childIds.join(','), caption });
      await waitReady(cid);
      const pid = await publish(cid);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, postId: pid, message: `Carrusel de ${images.length} imágenes publicado ✅` }) };
    }

    if (mode === 'reel') {
      if (!videoUrl) throw new Error('No se recibió URL del video');
      const cid = await createContainer({ media_type: 'REELS', video_url: videoUrl, caption });
      await waitReady(cid, 20, 5000);
      const pid = await publish(cid);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, postId: pid, message: 'Reel publicado ✅' }) };
    }

    throw new Error('Modo no válido: ' + mode);

  } catch (err) {
    console.error('publish-instagram:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
