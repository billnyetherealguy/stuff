// Solworld service worker: makes the site installable as an app and opens
// instantly from the home screen. The site's own code and settings are always
// fetched fresh when online (every visitor must run the same registry rules),
// with the last copy as the offline fallback; big immutable files (libraries,
// 3D models) come from the cache. Maps, Solana and other services pass through.
const VERSION = 'solworld-v1';
const SHELL = ['./', './index.html', './config.js', './manifest.webmanifest', './favicon.svg', './icon-192.png', './icon-512.png', './assets/css/solworld.css'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const immutable = (url) => /\/(vendor|assets\/models)\//.test(url.pathname);

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') cache.put(request, response.clone());
    return response;
  } catch (err) {
    const hit = (await cache.match(request)) || (request.mode === 'navigate' ? await cache.match('./') : null);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // tiles, Solana, Cesium…: straight to the network
  event.respondWith(immutable(url) ? cacheFirst(request) : networkFirst(request));
});
