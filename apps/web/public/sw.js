// P2-239: this worker is event orchestration only — every decision (what to
// precache, which strategy serves a path, the offline page, what is stale)
// lives in sw-policy.js, loaded first so the handlers can consult it.
importScripts("/sw-policy.js");

// P2-097/P2-239: the name is versioned so a new publication never inherits
// entries written by an older (possibly stale) cache — activate deletes the rest.
const CACHE = "ocr-shell-v3";

// Targets of the publication that ran install in this worker instance; used
// by activate to shed versioned leftovers of an earlier publication.
let precacheList = [];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      let root = "";
      try {
        const res = await fetch("/", { cache: "no-store" });
        if (res.ok) {
          root = await res.clone().text();
          await cache.put("/", res);
        }
      } catch {
        // No document: install still succeeds and the policy's offline page
        // covers the next navigation.
      }
      precacheList = self.precacheTargets(root);
      await Promise.all(
        precacheList.map(async (path) => {
          try {
            const res = await fetch(path, { cache: "no-store" });
            if (!res.ok) throw new Error(String(res.status));
            await cache.put(path, res);
          } catch {
            // Isolated failure: one line, never the whole install.
            console.warn("[sw] precache skipped:", path);
          }
        }),
      );
      // P2-246: takeover is not unconditional anymore — while a live tab from
      // the previous publication exists the worker waits, and the browser
      // activates it by itself when the last controlled tab closes.
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (self.takeoverPlan(windows.length) === "takeover-now") self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // P2-246: the sweep consults the plan — with a live controlled client
      // nothing is deleted, so the open document can never ask for an entry
      // this activation just evicted.
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      // P2-239: sweep versioned leftovers of an earlier publication that
      // survived inside the current cache (the plan decides, never here).
      if (precacheList.length > 0) {
        const cache = await caches.open(CACHE);
        const have = (await cache.keys()).map((r) => new URL(r.url).pathname);
        const stale = self.sweepPlan(windows.length, have, precacheList);
        await Promise.all(stale.map((path) => cache.delete(path)));
      }
    })(),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const plan = self.strategyFor(url.pathname, event.request.method);
  if (plan === "cache-first") {
    event.respondWith(
      caches.match(event.request).then((hit) => hit || fetch(event.request)),
    );
  } else if (plan === "network-first") {
    event.respondWith(
      fetch(event.request).catch(async () => {
        return (
          (await caches.match(event.request)) ||
          (await caches.match("/")) ||
          new Response(self.offlineDocument(), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          })
        );
      }),
    );
  }
  // network-first-nosave: the plain network path, nothing is recorded.
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
