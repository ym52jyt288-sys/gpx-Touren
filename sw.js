// Service worker: makes the app start without network (iPhone home-screen app).
//
// Strategy for the app's own files: network first (revalidated, so a deploy is
// picked up on the next start – no hard reload needed), falling back to the
// cached copy when offline or when the network is too slow. Cross-origin requests
// (map tiles, Nominatim, Overpass) are not touched – offline tiles are handled by
// js/offlineTiles.js via IndexedDB.
//
// SHELL must list every file the app needs to boot. Add new modules here.

const CACHE = "gpx-shell-v1";
const NETWORK_TIMEOUT_MS = 3500;

const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "manifest.webmanifest",
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "vendor/leaflet.css",
  "vendor/leaflet.js",
  "vendor/leaflet-marker-icon.png",
  "vendor/leaflet-marker-icon-2x.png",
  "vendor/leaflet-marker-shadow.png",
  "js/analyzer.js",
  "js/chart.js",
  "js/db.js",
  "js/dom.js",
  "js/filter.js",
  "js/folderAccess.js",
  "js/format.js",
  "js/geo.js",
  "js/geocode.js",
  "js/gpx.js",
  "js/indexer.js",
  "js/localFolder.js",
  "js/main.js",
  "js/mapLayers.js",
  "js/minimap.js",
  "js/offlineTiles.js",
  "js/parseWorker.js",
  "js/spatial.js",
  "js/trackColors.js",
  "js/views/detail.js",
  "js/views/filterPanel.js",
  "js/views/folderSetup.js",
  "js/views/list.js",
  "js/views/mapSearch.js",
  "js/views/offlineDialog.js",
  "js/views/settings.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((p) => new Request(p, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // tiles, geocoding: browser default
  if (!url.href.startsWith(self.registration.scope)) return;
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const isNav = req.mode === "navigate";

  const fromNetwork = fetch(req, { cache: "no-cache" }).then((res) => {
    // only keep complete, same-origin answers (no 206 / opaque / errors)
    if (res.ok && res.status === 200 && res.type === "basic") {
      cache.put(isNav ? "index.html" : req, res.clone());
    }
    return res;
  });
  fromNetwork.catch(() => {}); // a late failure after the timeout is not an error

  const cached = () =>
    isNav
      ? cache.match("index.html")
      : cache.match(req, { ignoreSearch: true });

  try {
    const res = await Promise.race([
      fromNetwork,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), NETWORK_TIMEOUT_MS)),
    ]);
    return res;
  } catch {
    const hit = await cached();
    if (hit) return hit;
    return fromNetwork; // nothing cached: keep waiting for the network
  }
}
