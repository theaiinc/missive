// Missive's service worker: push notifications for new mail (backend
// push.service.ts), which arrive with Missive closed. Nothing is cached.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  event.waitUntil(
    (async () => {
      // Missive open in front shows new mail itself (a toast), so don't repeat it.
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (windows.some((w) => w.visibilityState === "visible" && w.focused)) return;
      await self.registration.showNotification(data.title || "New mail", {
        body: data.body || "",
        tag: data.tag,
        icon: "/missive.svg",
        badge: "/missive.svg",
        data: { url: data.url || "/inbox" },
      });
    })(),
  );
});

// Clicking one opens what it was about (/thread/:id, /chat/:id) in Missive's
// window if one is open: the page routes there itself (useNotifications.ts),
// since a window this worker doesn't control can't be navigated from here.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = event.notification.data?.url || "/inbox";
  const url = new URL(path, self.location.origin);
  if (url.origin !== self.location.origin) return;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus().catch(() => {});
        open.postMessage({ type: "missive:open", url: url.pathname + url.search });
        return;
      }
      return self.clients.openWindow(url.href);
    })(),
  );
});
