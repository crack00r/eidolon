// Eidolon PWA Service Worker
// Strategy: Network-first for API/WebSocket, cache-first for static assets.

const CACHE_NAME = "eidolon-v1";
const PRECACHE_URLS = ["/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
  // Activate immediately without waiting for existing clients to close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Remove old caches when a new service worker activates.
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests (form submissions, WebSocket upgrades, etc.).
  if (event.request.method !== "GET") return;

  // Network-only for API calls and WebSocket-related paths.
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/ws") ||
    url.pathname.startsWith("/_app/server/")
  ) {
    return;
  }

  // Cache-first for static assets (_app/immutable are content-hashed).
  if (url.pathname.startsWith("/_app/immutable/")) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ||
          fetch(event.request).then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
            return response;
          }),
      ),
    );
    return;
  }

  // Network-first for HTML pages and other resources.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});
