/* FR-Logistics · Ops Portal — Service Worker v1.1
   Strategy:
   - Static assets (fonts, CSS, HTML shell) → Cache First
   - Netlify Functions (/.netlify/functions/*) → Network First
   - Supabase API calls → Network First (always fresh data)
   - Everything else → Network First with cache fallback
   - Web Push from WhatsApp Inbox → showNotification on push event
*/

const CACHE_VERSION = 'fr-portal-v1.1';
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
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

/* ════════════════════════════════════════════════════════════════════
   INSTALL — pre-cache the app shell
   ════════════════════════════════════════════════════════════════════ */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => {
        return cache.addAll(STATIC_URLS).catch((err) => {
          console.warn('[SW] Pre-cache partial failure (non-fatal):', err);
        });
      })
      .then(() => self.skipWaiting())
  );
});

/* ════════════════════════════════════════════════════════════════════
   ACTIVATE — clean up old caches
   ════════════════════════════════════════════════════════════════════ */
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

/* ════════════════════════════════════════════════════════════════════
   FETCH — route requests to the right strategy
   ════════════════════════════════════════════════════════════════════ */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  /* Skip non-GET */
  if (request.method !== 'GET') return;

  /* Never cache: API calls, Netlify Functions, Supabase */
  const isApiCall = NEVER_CACHE.some((pattern) => request.url.includes(pattern));
  if (isApiCall) {
    event.respondWith(fetch(request));
    return;
  }

  /* Google Fonts — cache first, long TTL */
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  /* App shell HTML — stale-while-revalidate */
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

/* ════════════════════════════════════════════════════════════════════
   PUSH — Web Push from WhatsApp Inbox
   ════════════════════════════════════════════════════════════════════ */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'FR-Logistics', body: event.data?.text() || 'New message' };
  }

  const title = data.title || 'WhatsApp Inbox';
  const options = {
    body: data.body || '',
    tag: data.tag || 'wa-inbox',
    renotify: true,
    icon: data.icon || 'https://fr-logistics.net/wp-content/uploads/2024/03/favicon-196x196.png',
    badge: data.badge || 'https://fr-logistics.net/wp-content/uploads/2024/03/favicon-196x196.png',
    data: { url: data.url || '/portal.html#wa-inbox' },
    requireInteraction: false,
    vibrate: [120, 60, 120],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || '/portal.html#wa-inbox';

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      // If portal is already open, focus and navigate it
      for (const client of allClients) {
        if (client.url.includes('/portal.html') && 'focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })()
  );
});

/* ════════════════════════════════════════════════════════════════════
   CACHE STRATEGIES
   ════════════════════════════════════════════════════════════════════ */
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
