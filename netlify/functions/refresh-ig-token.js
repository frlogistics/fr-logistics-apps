const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const USER_TOKEN = process.env.IG_USER_TOKEN_FRL;
    const PAGE_ID    = '1144754038873590';
    const APP_ID     = '1443343704201203';
    const APP_SECRET = process.env.META_APP_SECRET;

    if (!USER_TOKEN) throw new Error('IG_USER_TOKEN_FRL not set');

    // 1. Try to extend user token to 60 days
    let liveToken = USER_TOKEN;
    if (APP_SECRET) {
      const r = await fetch(`https://graph.facebook.com/oauth/access_token?grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${APP_SECRET}&fb_exchange_token=${USER_TOKEN}`);
      const d = await r.json();
      if (d.access_token) {
        liveToken = d.access_token;
        console.log('User token extended to 60 days');
      } else {
        console.log('Extension skipped:', d.error?.message);
      }
    }

    // 2. Get Page Access Token
    const pr = await fetch(`https://graph.facebook.com/v21.0/${PAGE_ID}?fields=access_token&access_token=${liveToken}`);
    const pd = await pr.json();
    if (!pd.access_token) throw new Error('Page token failed: ' + JSON.stringify(pd.error));

    const newToken = pd.access_token;
    console.log('New Page Access Token obtained');

    // 3. Store token in Netlify Blobs
    const store = getStore({ name: 'ig-tokens', consistency: 'strong' });
    await store.set('frl_access_token', newToken);
    await store.set('frl_refreshed_at', new Date().toISOString());
    if (liveToken !== USER_TOKEN) {
      await store.set('frl_user_token', liveToken);
    }

    console.log('Token saved to Netlify Blobs at', new Date().toISOString());

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ success: true, message: 'Token refreshed and saved ✅', refreshed_at: new Date().toISOString() })
    };

  } catch (err) {
    console.error('refresh-ig-token error:', err.message);

    // Alert email
    if (process.env.RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'FR-Logistics <alerts@fr-logistics.net>',
          to: ['warehouse@fr-logistics.net'],
          subject: '⚠️ Instagram Token Auto-Refresh Failed',
          html: `<p><b>Error:</b> ${err.message}</p><p>Renueva en: <a href="https://apps.fr-logistics.net/refresh-token.html">refresh-token.html</a></p>`
        })
      }).catch(() => {});
    }

    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
