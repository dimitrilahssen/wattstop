/* WattStop service worker — page hors-ligne, cache des assets statiques, notifications push. */
const VERSION = "wattstop-v3";
// En local (npm run dev), pas de cache : les fichiers de développement changent sans changer de nom
const CACHE_ENABLED = !["localhost", "127.0.0.1"].includes(self.location.hostname);
const STATIC_CACHE = `${VERSION}-static`;
const OFFLINE_URL = "/offline";
const PRECACHE = [OFFLINE_URL, "/icons/icon.svg", "/icons/icon-192.png", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  if (CACHE_ENABLED) event.waitUntil(caches.open(STATIC_CACHE).then((c) => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (!CACHE_ENABLED || request.method !== "GET") return;
  const url = new URL(request.url);

  // Jamais de cache pour Supabase / API / auth : données sensibles et temps réel
  if (url.origin !== self.location.origin || url.pathname.startsWith("/auth") || url.pathname.startsWith("/api")) {
    return;
  }

  // Navigations : network-first, fallback page hors-ligne
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
    return;
  }

  // Assets Next.js immuables : cache-first
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((res) => {
            const copy = res.clone();
            caches.open(STATIC_CACHE).then((c) => c.put(request, copy));
            return res;
          })
      )
    );
  }
});

// ---------- Notifications push ----------
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "WattStop", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "WattStop", {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: data.tag,
      renotify: Boolean(data.tag),
      data: { url: data.url || "/bookings" },
    })
  );
});

// Clic : ramène l'onglet WattStop déjà ouvert sur la bonne page, sinon en ouvre un
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/bookings", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const win = wins.find((w) => w.url.startsWith(self.location.origin));
      if (win) return win.focus().then(() => win.navigate(url));
      return self.clients.openWindow(url);
    })
  );
});
