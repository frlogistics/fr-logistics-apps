exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  try {
    const USER_TOKEN    = process.env.IG_USER_TOKEN_FRL;
    const PAGE_ID       = '1144754038873590';
    const NETLIFY_SITE  = process.env.NETLIFY_SITE_ID;
    const NETLIFY_TOKEN = process.env.NETLIFY_API_TOKEN;
    const APP_ID        = '1443343704201203';
    const APP_SECRET    = process.env.META_APP_SECRET;

    if (!USER_TOKEN)    throw new Error('IG_USER_TOKEN_FRL not set');
    if (!NETLIFY_SITE)  throw new Error('NETLIFY_SITE_ID not set');
    if (!NETLIFY_TOKEN) throw new Error('NETLIFY_API_TOKEN not set');

    // 1. Try to extend the user token (60 days)
    let liveToken = USER_TOKEN;
    if (APP_SECRET) {
      const r = await fetch(`https://graph.facebook.com/oauth/access_token?grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${APP_SECRET}&fb_exchange_token=${USER_TOKEN}`);
      const d = await r.json();
      if (d.access_token) { liveToken = d.access_token; console.log('User token extended'); }
      else console.log('Extension failed:', d.error?.message);
    }

    // 2. Get Page Access Token
    const pr = await fetch(`https://graph.facebook.com/v21.0/${PAGE_ID}?fields=access_token&access_token=${liveToken}`);
    const pd = await pr.json();
    if (!pd.access_token) throw new Error('Page token failed: ' + JSON.stringify(pd.error));

    // 3. Update IG_ACCESS_TOKEN_FRL in Netlify
    const nr = await fetch(`https://api.netlify.com/api/v1/sites/${NETLIFY_SITE}/env/IG_ACCESS_TOKEN_FRL`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${NETLIFY_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'IG_ACCESS_TOKEN_FRL', values: [{ context: 'all', value: pd.access_token }] })
    });
    if (!nr.ok) throw new Error('Netlify update failed: ' + await nr.text());

    // 4. Update IG_USER_TOKEN_FRL if extended
    if (liveToken !== USER_TOKEN) {
      await fetch(`https://api.netlify.com/api/v1/sites/${NETLIFY_SITE}/env/IG_USER_TOKEN_FRL`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${NETLIFY_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'IG_USER_TOKEN_FRL', values: [{ context: 'all', value: liveToken }] })
      });
    }

    // 5. Trigger deploy
    await fetch(`https://api.netlify.com/api/v1/sites/${NETLIFY_SITE}/builds`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${NETLIFY_TOKEN}` }
    });

    console.log('Token refreshed OK at', new Date().toISOString());
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Token refreshed ✅', ts: new Date().toISOString() }) };

  } catch (err) {
    console.error('refresh-ig-token:', err.message);
    // Alert email via Resend
    if (process.env.RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'FR-Logistics <alerts@fr-logistics.net>',
          to: ['warehouse@fr-logistics.net'],
          subject: '⚠️ Instagram Token Auto-Refresh Failed',
          html: `<p><b>Error:</b> ${err.message}</p><p>Renueva manualmente en: <a href="https://apps.fr-logistics.net/refresh-token.html">refresh-token.html</a></p>`
        })
      }).catch(()=>{});
    }
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
