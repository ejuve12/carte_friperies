// Service worker : met en cache l'app pour un démarrage rapide et hors ligne.
// Incrémenter VERSION à chaque modification des fichiers de l'app.
const VERSION = "v3";
const SHELL_CACHE = `friperies-shell-${VERSION}`;
const TILE_CACHE = "friperies-tiles";
const DATA_CACHE = "friperies-data";
const DATASET = "data/friperies.json";
const MAX_TILES = 400;

const SHELL = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/favicon-32.png",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/MarkerCluster.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/MarkerCluster.Default.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/leaflet.markercluster.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)),
      caches.open(DATA_CACHE).then((c) => c.add(DATASET)),
    ]).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("friperies-shell-") && k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(k);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // Overpass (POST) passe toujours par le réseau
  const url = new URL(req.url);

  // Tuiles de carte : cache d'abord (déjà vues), sinon réseau.
  if (url.hostname.endsWith("tile.openstreetmap.org")) {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok || res.type === "opaque") { cache.put(req, res.clone()); trimCache(TILE_CACHE, MAX_TILES); }
        return res;
      })
    );
    return;
  }

  // Fichier des friperies : réponse immédiate depuis le cache, mise à jour en arrière-plan
  // (la version à jour sert au lancement suivant).
  if (url.origin === self.location.origin && url.pathname.endsWith(DATASET)) {
    event.respondWith(
      caches.open(DATA_CACHE).then(async (cache) => {
        const hit = await cache.match(req, { ignoreSearch: true });
        const update = fetch(req).then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        });
        if (hit) { event.waitUntil(update.catch(() => {})); return hit; }
        return update;
      })
    );
    return;
  }

  // Fichiers de l'app : réseau d'abord (pour avoir les mises à jour), cache si hors ligne.
  if (url.origin === self.location.origin || url.hostname === "cdnjs.cloudflare.com") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(SHELL_CACHE).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }))
    );
  }
});
