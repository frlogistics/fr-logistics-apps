// ════════════════════════════════════════════════════════════════════
// PATCH for sw.js — Add this block at the END of your existing sw.js
// (Keep your existing cache logic; just append the push handlers below)
// ════════════════════════════════════════════════════════════════════

// ─────────────────────────── Web Push from WhatsApp Inbox
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "FR-Logistics", body: event.data?.text() || "New message" };
  }

  const title = data.title || "WhatsApp Inbox";
  const options = {
    body: data.body || "",
    tag: data.tag || "wa-inbox",
    renotify: true,
    icon: data.icon || "/icons/icon-192.png",
    badge: data.badge || "/icons/icon-192.png",
    data: { url: data.url || "/portal.html#wa-inbox" },
    requireInteraction: false,
    vibrate: [120, 60, 120],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || "/portal.html#wa-inbox";

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // If portal is already open, focus it and navigate
      for (const client of allClients) {
        if (client.url.includes("/portal.html") && "focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      // Otherwise open new window
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })()
  );
});
