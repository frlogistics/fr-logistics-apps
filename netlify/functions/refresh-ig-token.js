exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const USER_TOKEN = process.env.IG_USER_TOKEN_FRL;
    const PAGE_ID    = '1144754038873590';
    const APP_ID     = '1443343704201203';
    const APP_SECRET = process.env.META_APP_SECRET;
    const NETLIFY_TOKEN = process.env.NETLIFY_API_TOKEN;
    const NETLIFY_SITE  = process.env.NETLIFY_SITE_ID;

    if (!USER_TOKEN) throw new Error('IG_USER_TOKEN_FRL not set');

    // 1. Try to extend user token to 60 days
    let liveToken = USER_TOKEN;
    if (APP_SECRET) {
      const r = await fetch(`https://graph.facebook.com/oauth/access_token?grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${APP_SECRET}&fb_exchange_token=${USER_TOKEN}`);
      const d = await r.json();
      if (d.access_token) { liveToken = d.access_token; console.log('User token extended'); }
      else console.log('Extension skipped:', d.error?.message);
    }

    // 2. Get Page Access Token
    const pr = await fetch(`https://graph.facebook.com/v21.0/${PAGE_ID}?fields=access_token&access_token=${liveToken}`);
    const pd = await pr.json();
    if (!pd.access_token) throw new Error('Page token failed: ' + JSON.stringify(pd.error));
    const newToken = pd.access_token;
    console.log('New Page Access Token obtained');

    // 3. Update env var via Netlify API (PATCH method, account-level endpoint)
    if (NETLIFY_TOKEN && NETLIFY_SITE) {
      // First get account ID from site info
      const siteRes = await fetch(`https://api.netlify.com/api/v1/sites/${NETLIFY_SITE}`, {
        headers: { 'Authorization': `Bearer ${NETLIFY_TOKEN}` }
      });
      const siteData = await siteRes.json();
      const accountId = siteData.account_id || siteData.account_slug;

      if (accountId) {
        // Use account-level env var API
        const envRes = await fetch(`https://api.netlify.com/api/v1/accounts/${accountId}/env/IG_ACCESS_TOKEN_FRL`, {
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${NETLIFY_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: newToken })
        });

        if (envRes.ok) {
          console.log('Netlify env var updated via account API');
          // Trigger deploy
          await fetch(`https://api.netlify.com/api/v1/sites/${NETLIFY_SITE}/builds`, {
            method: 'POST', headers: { 'Authorization': `Bearer ${NETLIFY_TOKEN}` }
          });
        } else {
          const errText = await envRes.text();
          console.log('Account API failed:', errText, '— token obtained but env not updated');
        }
      }
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        success: true,
        message: 'Token refreshed ✅',
        new_token: newToken,
        refreshed_at: new Date().toISOString()
      })
    };

  } catch (err) {
    console.error('refresh-ig-token:', err.message);
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
