const https = require('https');
const http = require('http');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { caption, imageBase64, images, videoBase64, videoMimeType, accountType, mode = 'post' } = JSON.parse(event.body);
    const ACCESS_TOKEN = accountType === 'frl' ? process.env.IG_ACCESS_TOKEN_FRL : process.env.IG_ACCESS_TOKEN_SRJ;
    const USER_ID = accountType === 'frl' ? process.env.IG_USER_ID_FRL : process.env.IG_USER_ID_SRJ;
    if (!ACCESS_TOKEN || !USER_ID) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Credenciales no configuradas' }) };

    // ── Upload image to Imgur ────────────────────────────────
    async function uploadToImgur(b64) {
      const res = await fetch('https://api.imgur.com/3/image', {
        method: 'POST',
        headers: { 'Authorization': 'Client-ID ' + process.env.IMGUR_CLIENT_ID, 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: b64, type: 'base64' })
      });
      const d = await res.json();
      if (!d.success) throw new Error('Imgur upload failed: ' + (d.data?.error || JSON.stringify(d)));
      return d.data.link;
    }

    // ── Upload video using multipart/form-data manually ──────
    async function uploadVideoToFileIO(b64) {
      const buffer = Buffer.from(b64, 'base64');
      const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
      const filename = 'reel.mp4';

      const header = Buffer.from(
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="file"; filename="' + filename + '"\r\n' +
        'Content-Type: video/mp4\r\n\r\n'
      );
      const footer = Buffer.from('\r\n--' + boundary + '--\r\n');
      const body = Buffer.concat([header, buffer, footer]);

      const res = await fetch('https://file.io/?expires=1h', {
        method: 'POST',
        headers: {
          'Content-Type': 'multipart/form-data; boundary=' + boundary,
          'Content-Length': String(body.length)
        },
        body: body
      });
      const d = await res.json();
      if (!d.success) throw new Error('file.io upload failed: ' + JSON.stringify(d));
      return d.link;
    }

    // ── Meta Graph API helpers ───────────────────────────────
    async function createContainer(params) {
      const res = await fetch(`https://graph.facebook.com/v21.0/${USER_ID}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...params, access_token: ACCESS_TOKEN })
      });
      const d = await res.json();
      if (d.error) throw new Error('Container error: ' + d.error.message);
      return d.id;
    }

    async function waitReady(id, maxAttempts = 15, interval = 3000) {
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, interval));
        const res = await fetch(`https://graph.facebook.com/v21.0/${id}?fields=status_code&access_token=${ACCESS_TOKEN}`);
        const d = await res.json();
        if (d.status_code === 'FINISHED') return;
        if (d.status_code === 'ERROR') throw new Error('Container processing failed');
      }
      throw new Error('Container timed out');
    }

    async function publish(containerId) {
      const res = await fetch(`https://graph.facebook.com/v21.0/${USER_ID}/media_publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creation_id: containerId, access_token: ACCESS_TOKEN })
      });
      const d = await res.json();
      if (d.error) throw new Error('Publish error: ' + d.error.message);
      return d.id;
    }

    // ── POST ─────────────────────────────────────────────────
    if (mode === 'post') {
      const url = await uploadToImgur(imageBase64);
      const cid = await createContainer({ image_url: url, caption });
      await waitReady(cid);
      const pid = await publish(cid);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, postId: pid, message: 'Post publicado en Instagram ✅' }) };
    }

    // ── CAROUSEL ─────────────────────────────────────────────
    if (mode === 'carousel') {
      if (!images || images.length < 2) throw new Error('Mínimo 2 imágenes para carrusel');
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

    // ── REEL ─────────────────────────────────────────────────
    if (mode === 'reel') {
      if (!videoBase64) throw new Error('No se recibió el video');
      const videoUrl = await uploadVideoToFileIO(videoBase64);
      const cid = await createContainer({ media_type: 'REELS', video_url: videoUrl, caption });
      await waitReady(cid, 20, 5000);
      const pid = await publish(cid);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, postId: pid, message: 'Reel publicado en Instagram ✅' }) };
    }

    throw new Error('Modo no válido: ' + mode);

  } catch (err) {
    console.error('publish-instagram error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
