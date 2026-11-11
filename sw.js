// Offline support: app shell cached on install, map tiles and data cached as you use them.
const VERSION = 'v1';
const SHELL = `shell-${VERSION}`;
const TILES = 'tiles-v1';
const DATA = `data-${VERSION}`;
const MAX_TILES = 3000;

const SHELL_FILES = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png',
  'js/app.js', 'js/data.js', 'js/osm.js', 'js/geo.js', 'js/route.js', 'js/waits.js', 'js/runs.js', 'js/snow.js', 'js/store.js',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, TILES, DATA, 'shiga-osm-live'].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    e.respondWith(cacheFirst(req, TILES, true));
  } else if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(cacheFirst(req, SHELL));
  } else if (url.origin === location.origin && url.pathname.endsWith('/data/shiga.json')) {
    e.respondWith(networkFirst(req, DATA));
  } else if (url.origin === location.origin) {
    e.respondWith(networkFirst(req, SHELL));
  }
});

async function cacheFirst(req, name, trim) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok || res.type === 'opaque') {
      await cache.put(req, res.clone());
      if (trim) trimCache(cache);
    }
    return res;
  } catch {
    return new Response('', { status: 504 });
  }
}

async function networkFirst(req, name) {
  const cache = await caches.open(name);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: true });
    return hit || new Response('Offline', { status: 503 });
  }
}

let trimming = false;
async function trimCache(cache) {
  if (trimming) return;
  trimming = true;
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
  trimming = false;
}
