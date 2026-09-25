// Service worker: deja la app usable sin internet.
// El shell y el catálogo quedan cacheados; las ventas se encolan en el cliente.

const VERSION = "caja-v1";
const SHELL_CACHE = VERSION + "-shell";
const DATA_CACHE = VERSION + "-data";

const SHELL = ["/", "/app.css", "/app.js", "/manifest.json", "/icon.svg"];

// Respuestas de la API que vale la pena guardar para ver sin conexión.
const CACHEABLE_API = ["/api/products", "/api/analytics", "/api/sales/today"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

function isCacheableApi(url) {
  return CACHEABLE_API.some((path) => url.pathname.startsWith(path));
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    // Se revalida en segundo plano para no quedar con una versión vieja para siempre.
    fetch(request)
      .then((response) => {
        if (response && response.ok) cache.put(request, response.clone());
      })
      .catch(() => {});
    return cached;
  }
  const response = await fetch(request);
  if (response && response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return; // las ventas (POST) las maneja la cola del cliente

  const url = new URL(request.url);

  // Navegación: si no hay red, se sirve la app cacheada.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.open(SHELL_CACHE).then((cache) => cache.match("/"))
      )
    );
    return;
  }

  if (url.origin === self.location.origin) {
    if (isCacheableApi(url)) {
      event.respondWith(networkFirst(request, DATA_CACHE));
      return;
    }
    // El lookup externo de productos no tiene sentido cachearlo offline.
    if (url.pathname.startsWith("/api/")) return;

    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  // Fuentes y librerías de CDN: cache-first para que la app arranque sin red.
  if (
    url.hostname === "fonts.googleapis.com" ||
    url.hostname === "fonts.gstatic.com" ||
    url.hostname === "cdn.jsdelivr.net"
  ) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
  }
});
