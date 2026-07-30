// App-shell caching only. Attendance submission always needs the network
// (it's writing to a live spreadsheet) so POST requests and cross-origin
// calls to the Apps Script API are never intercepted here — only this
// site's own static files get cached, for instant repeat loads.
const CACHE_NAME = 'attendance-staging-shell-v2';
const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './eco-logo-transparent.png',
  './watermark-logo.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only ever handle same-origin GET requests for the app shell - everything
  // else (the Apps Script API, any POST) goes straight to the network.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  // Network-first, not cache-first: a stale cached app.js after a deploy is
  // exactly what silently broke login earlier (it kept POSTing to an old
  // API URL baked into the cached copy). Falling back to cache only when
  // the network is unavailable still gets offline load working, without
  // ever preferring stale code over fresh code while online.
  //
  // cache: 'no-store' matters here too - without it, fetch() still honors
  // GitHub Pages' own HTTP cache-control headers, so the browser can hand
  // back a stale style.css/app.js straight from its HTTP cache without ever
  // reaching the network, even though this code calls fetch() every time.
  event.respondWith(
    fetch(req, { cache: 'no-store' })
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        return res;
      })
      .catch(() => caches.match(req))
  );
});
