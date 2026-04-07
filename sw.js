/* FR-Logistics · Ops Portal — Service Worker v1.0
   Strategy:
   - Static assets (fonts, CSS, HTML shell) → Cache First
   - Netlify Functions (/.netlify/functions/*) → Network First
   - Supabase API calls → Network First (always fresh data)
   - Everything else → Network First with cache fallback
*/

const CACHE_VERSION = 'fr-portal-v1';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const STATIC_URLS = [
  '/portal.html',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500;600&family=DM+Mono&display=swap',
];

/* URLs that should NEVER be cached (always fresh) */
const NEVER_CACHE = [
  '/.netlify/functions/',
  'supabase.co',
  'api.supabase',
  '/api/',
  'graph.facebook.com',
];

/* Install: pre-cache the app shell */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(STATIC_URLS).catch((err) => {
        console.warn('[SW] Pre-cache partial failure (non-fatal):', err);
      });
    }).then(() => self.skipWaiting())
  );
});

/* Activate: clean up old caches */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key.startsWith('fr-portal-') && key !== STATIC_CACHE && key !== RUNTIME_CACHE)
          .map((key) => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      );
    }).then(() => self.clients.claim())
  );
});

/* Fetch: route requests to the right strategy */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  /* Skip non-GET and cross-origin non-font requests */
  if (request.method !== 'GET') return;

  /* Never cache: API calls, Netlify Functions, Supabase */
  const isApiCall = NEVER_CACHE.some((pattern) =>
    request.url.includes(pattern)
  );

  if (isApiCall) {
    /* Network only — no fallback, data must be fresh */
    event.respondWith(fetch(request));
    return;
  }

  /* Google Fonts — cache first, long TTL */
  if (
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  ) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  /* App shell HTML — stale-while-revalidate so updates appear next load */
  if (url.pathname === '/portal.html' || url.pathname === '/') {
    event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
    return;
  }

  /* Other same-origin assets — network first with cache fallback */
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request, RUNTIME_CACHE));
    return;
  }
});

/* ── Strategies ── */

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response('Offline — no cached version available.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkFetch = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => {});
  return cached || (await networkFetch);
}
