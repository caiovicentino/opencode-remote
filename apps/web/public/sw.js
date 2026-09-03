// Placeholder service worker: makes the PWA installable and keeps a shell
// cache. Real precache/invalidate strategy lands with the offline roadmap.
// P2-097: the name is versioned so shipping a new SW evicts every cache
// written by older (possibly poisoned) versions — activate deletes the rest.
const CACHE = "ocr-shell-v2";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/"])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        // P2-097: only clean 200s enter the cache — errors/redirects/opaque
        // responses used to be cached forever under the constant cache name
        if (res.status === 200) {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE).then((c) => c.put(event.request, copy)));
        }
        return res;
      })
      .catch(() => caches.match(event.request)),
  );
});

self.addEventListener("push", (event) => {
  let payload = { title: "OpenCode Remote", body: "New event", url: "#/" };
  try {
    payload = { ...payload, ...event.data.json() };
  } catch {
    // keep defaults
  }
  // deep-link: the daemon sends { url } (or data.url) with an in-app hash route
  const raw = (payload.data && payload.data.url) || payload.url || "#/";
  const abs = new URL(raw, self.registration.scope).href;
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icon.svg",
      badge: "/icon.svg",
      data: { url: abs },
      tag: "opencode-remote",
      actions: payload.actions ?? [],
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of list) {
        if ("navigate" in client) {
          try {
            await client.navigate(url);
          } catch {
            // iOS Safari may refuse navigation of an open PWA — focus is still useful
          }
          if ("focus" in client) await client.focus();
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
