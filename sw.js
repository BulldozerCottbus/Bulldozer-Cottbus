const CACHE = "bulldozer-cache-v2";
const BASE = "/Bulldozer-Cottbus/";

const PRECACHE = [
  BASE,
  BASE + "index.html",
  BASE + "manifest.webmanifest",
  BASE + "icons/icon-192.png",
  BASE + "icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      cache.addAll(PRECACHE.map((u) => new Request(u, { cache: "reload" })))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      ),
    ])
  );
});

function isSameOrigin(request) {
  return new URL(request.url).origin === self.location.origin;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // ✅ Cross-Origin (Firebase CDN / gstatic etc.) nicht in unseren Cache
  if (!isSameOrigin(req)) {
    event.respondWith(fetch(req));
    return;
  }

  const url = new URL(req.url);

  // ✅ HTML / Navigation: NETWORK FIRST (damit index.html immer aktuell wird)
  if (req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() =>
          caches.match(req).then(
            (c) => c || caches.match(BASE + "index.html") || caches.match(BASE)
          )
        )
    );
    return;
  }

  // ✅ JS/CSS: STALE-WHILE-REVALIDATE (schnell + aktualisiert im Hintergrund)
  if (url.pathname.endsWith(".js") || url.pathname.endsWith(".css")) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetchPromise = fetch(req)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
            return res;
          })
          .catch(() => cached);

        return cached || fetchPromise;
      })
    );
    return;
  }

  // ✅ Sonstige Assets: CACHE FIRST
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;

      return fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(BASE));
    })
  );
});
