/* fr-auth.js — FR-Logistics staff session for apps.fr-logistics.net
 * ───────────────────────────────────────────────────────────────────────────
 * Injected into every page by netlify/edge-functions/page-gate.js.
 *
 *  • No session → covers the page with a sign-in screen (Supabase Auth,
 *    same accounts as the client portal; only staff emails get through —
 *    the server enforces that in auth-gate.js).
 *  • Session → silently attaches "Authorization: Bearer <token>" to every
 *    fetch() to /.netlify/functions/* and keeps an fr_at cookie in sync, so
 *    plain links (printable manifests, PDFs, photo proxies) also work.
 *  • Tokens last 1 h; they are refreshed automatically before they expire,
 *    so long-running screens (TV dashboard, print agent, handheld) stay in.
 *
 * No libraries: plain fetch against Supabase Auth's REST endpoints.
 */
(function () {
  'use strict';
  if (window.frAuth) return;

  var SUPABASE_URL = 'https://rijbschnchjiuggrhfrx.supabase.co';
  var KEY = 'sb_publishable_2iAxAlUmL5mzL_CXFDR4Mw_bSARmU90';
  var STORE = 'fr_staff_session';
  var RESET_URL = 'https://fr-logistics.net/app/set-password.html';
  var nativeFetch = window.fetch.bind(window);

  /* ── session storage ─────────────────────────────────────────────────── */
  function load() { try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { return null; } }
  function save(s) {
    try { if (s) localStorage.setItem(STORE, JSON.stringify(s)); else localStorage.removeItem(STORE); } catch (e) {}
    setCookie(s);
  }
  function setCookie(s) {
    var secure = location.protocol === 'https:' ? '; Secure' : '';
    if (s && s.access_token) {
      var ttl = Math.max(60, Math.floor(s.expires_at - Date.now() / 1000));
      document.cookie = 'fr_at=' + encodeURIComponent(s.access_token) + '; Path=/; Max-Age=' + ttl + '; SameSite=Strict' + secure;
    } else {
      document.cookie = 'fr_at=; Path=/; Max-Age=0; SameSite=Strict' + secure;
    }
  }
  function fromAuth(j) {
    return {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600),
      email: (j.user && j.user.email) || ''
    };
  }

  /* ── Supabase Auth REST ──────────────────────────────────────────────── */
  function authPost(grant, payload) {
    return nativeFetch(SUPABASE_URL + '/auth/v1/token?grant_type=' + grant, {
      method: 'POST',
      headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) {
          var e = new Error(j.error_description || j.msg || j.message || ('Auth ' + r.status));
          e.status = r.status; throw e;
        }
        return j;
      });
    });
  }

  var refreshing = null;
  function refresh() {
    var s = load();
    if (!s || !s.refresh_token) return Promise.resolve(null);
    if (refreshing) return refreshing;
    refreshing = authPost('refresh_token', { refresh_token: s.refresh_token })
      .then(function (j) { var n = fromAuth(j); if (!n.email) n.email = s.email; save(n); return n; })
      .catch(function (e) { if (e.status === 400 || e.status === 401) save(null); return null; })
      .then(function (n) { refreshing = null; return n; });
    return refreshing;
  }

  // A valid access token, refreshed if it expires within 2 minutes.
  function token() {
    var s = load();
    if (!s) return Promise.resolve(null);
    if (s.expires_at - Date.now() / 1000 > 120) { setCookie(s); return Promise.resolve(s.access_token); }
    return refresh().then(function (n) { return n ? n.access_token : null; });
  }

  /* ── fetch(): attach the token to our own functions ──────────────────── */
  function isOurFunction(url) {
    try {
      var u = new URL(url, location.href);
      return u.origin === location.origin && u.pathname.indexOf('/.netlify/functions/') === 0;
    } catch (e) { return false; }
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (!isOurFunction(url)) return nativeFetch(input, init);

    function send(tok) {
      var opts = Object.assign({}, init || {});
      var h = new Headers(opts.headers || (input instanceof Request ? input.headers : undefined));
      if (tok && !/^Bearer\s+ey/i.test(h.get('Authorization') || '')) h.set('Authorization', 'Bearer ' + tok);
      opts.headers = h;
      return nativeFetch(input, opts);
    }

    return token().then(function (tok) {
      return send(tok).then(function (r) {
        if (r.status !== 401 || !tok) {
          if (r.status === 401) showGate('');
          return r;
        }
        // Token rejected: one refresh + retry, then ask to sign in again.
        return refresh().then(function (n) {
          if (!n) { showGate('Your session expired. Please sign in again.'); return r; }
          return send(n.access_token).then(function (r2) {
            if (r2.status === 401) showGate('Your session expired. Please sign in again.');
            return r2;
          });
        });
      });
    });
  };

  /* ── sign-in screen ──────────────────────────────────────────────────── */
  var CSS =
    '#fr-gate{position:fixed;inset:0;z-index:2147483646;background:#f1f5f9;display:flex;align-items:center;justify-content:center;padding:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;visibility:visible}' +
    '#fr-gate *{box-sizing:border-box;visibility:visible}' +
    '#fr-gate .b{background:#fff;border:1px solid #e2e8f0;border-radius:14px;max-width:380px;width:100%;overflow:hidden;box-shadow:0 20px 50px rgba(15,23,42,.12)}' +
    '#fr-gate .t{background:linear-gradient(135deg,#065f46,#16a34a);color:#fff;padding:18px 22px}' +
    '#fr-gate .t b{font-size:17px;letter-spacing:.5px}' +
    '#fr-gate .t p{margin:4px 0 0;font-size:12px;color:rgba(209,250,229,.92)}' +
    '#fr-gate form{padding:18px 22px;display:grid;gap:12px}' +
    '#fr-gate label{display:block;font-size:11px;font-weight:700;color:#475569;margin-bottom:4px}' +
    '#fr-gate input{width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:10px;font-size:15px;color:#0f172a;background:#fff}' +
    '#fr-gate input:focus{outline:2px solid #16a34a;border-color:#16a34a}' +
    '#fr-gate button{border:0;border-radius:8px;padding:11px;font-size:14px;font-weight:700;background:#059669;color:#fff;cursor:pointer}' +
    '#fr-gate button:disabled{opacity:.6}' +
    '#fr-gate .e{color:#b91c1c;font-size:12.5px;min-height:16px}' +
    '#fr-gate .h{font-size:11.5px;color:#64748b;line-height:1.5}' +
    '#fr-gate .h a{color:#059669;font-weight:700}' +
    'html.fr-locked body>*:not(#fr-gate){visibility:hidden!important}' +
    '#fr-chip{position:fixed;right:10px;bottom:10px;z-index:2147483645;font:11px -apple-system,Segoe UI,Arial,sans-serif;background:#0f172a;color:#e2e8f0;border-radius:20px;padding:5px 10px;opacity:.75;cursor:pointer}' +
    '#fr-chip:hover{opacity:1}';

  function injectCss() {
    if (document.getElementById('fr-auth-css')) return;
    var st = document.createElement('style');
    st.id = 'fr-auth-css'; st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function onBody(fn) {
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  var gateShown = false;
  function showGate(msg) {
    injectCss();
    document.documentElement.classList.add('fr-locked');
    onBody(function () {
      var g = document.getElementById('fr-gate');
      if (!g) {
        g = document.createElement('div');
        g.id = 'fr-gate';
        g.innerHTML =
          '<div class="b"><div class="t"><b>FR-LOGISTICS</b><p>Team sign-in</p></div>' +
          '<form id="fr-gate-f" autocomplete="on">' +
          '<div><label for="fr-gate-u">Email</label><input id="fr-gate-u" type="email" autocomplete="username" required></div>' +
          '<div><label for="fr-gate-p">Password</label><input id="fr-gate-p" type="password" autocomplete="current-password" required></div>' +
          '<button id="fr-gate-s" type="submit">Sign in</button>' +
          '<div class="e" id="fr-gate-e"></div>' +
          '<div class="h">Team accounts only. Forgot your password? <a href="' + RESET_URL + '" target="_blank" rel="noopener">Reset it here</a>.</div>' +
          '</form></div>';
        document.body.appendChild(g);
        document.getElementById('fr-gate-f').addEventListener('submit', function (ev) { ev.preventDefault(); signIn(); });
        var last = load();
        if (last && last.email) document.getElementById('fr-gate-u').value = last.email;
      }
      if (msg !== undefined && msg !== '') document.getElementById('fr-gate-e').textContent = msg;
      if (!gateShown) { gateShown = true; setTimeout(function () { var u = document.getElementById('fr-gate-u'); (u.value ? document.getElementById('fr-gate-p') : u).focus(); }, 50); }
    });
  }

  function whoami(tok) {
    return nativeFetch('/.netlify/functions/__whoami', { headers: { Authorization: 'Bearer ' + tok } })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.status = r.status; return j; }); });
  }

  function signIn() {
    var btn = document.getElementById('fr-gate-s'), err = document.getElementById('fr-gate-e');
    var email = document.getElementById('fr-gate-u').value.trim();
    var pass = document.getElementById('fr-gate-p').value;
    btn.disabled = true; btn.textContent = 'Signing in…'; err.textContent = '';
    authPost('password', { email: email, password: pass })
      .then(function (j) {
        var s = fromAuth(j);
        return whoami(s.access_token).then(function (w) {
          if (w.status === 200 && w.staff) { save(s); location.reload(); return; }
          save(null);
          err.textContent = w.status === 200 ? 'This account is not authorized for FR-Logistics apps.' : 'Could not verify the account. Try again.';
        });
      })
      .catch(function (e) {
        err.textContent = /invalid/i.test(e.message) ? 'Wrong email or password.' : e.message;
      })
      .then(function () { btn.disabled = false; btn.textContent = 'Sign in'; });
  }

  function signOut() {
    var s = load();
    save(null);
    if (s && s.access_token) {
      nativeFetch(SUPABASE_URL + '/auth/v1/logout', { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + s.access_token } }).catch(function () {});
    }
    location.reload();
  }

  function showChip(email) {
    // Only on the launcher; other screens (handheld, TV) keep their full space.
    if (!/\/portal(\.html)?$|^\/$/.test(location.pathname)) return;
    injectCss();
    onBody(function () {
      if (document.getElementById('fr-chip')) return;
      var c = document.createElement('div');
      c.id = 'fr-chip'; c.title = 'Sign out';
      c.textContent = email + '  ·  Sign out';
      c.addEventListener('click', function () { if (confirm('Sign out of FR-Logistics apps?')) signOut(); });
      document.body.appendChild(c);
    });
  }

  /* ── boot ────────────────────────────────────────────────────────────── */
  window.frAuth = { token: token, signOut: signOut, session: load };

  var s0 = load();
  if (!s0) {
    showGate('');
  } else {
    setCookie(s0);
    token().then(function (tok) {
      if (!tok) { showGate('Your session expired. Please sign in again.'); return; }
      return whoami(tok).then(function (w) {
        if (w.status === 200 && w.staff) { showChip(w.email || s0.email); return; }
        if (w.status === 200 && !w.staff) { save(null); showGate('This account is not authorized for FR-Logistics apps.'); return; }
        if (w.status === 401) { save(null); showGate('Your session expired. Please sign in again.'); }
        // 503 / network: leave the page usable; the next call will retry.
      });
    });
  }
})();
