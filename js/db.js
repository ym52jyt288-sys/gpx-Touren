// Thin IndexedDB wrapper. Stores:
//   tours        – keyPath "fileName", one record per indexed GPX file
//   meta         – keyPath "key",      folder handle + settings
//   tiles        – out-of-line key "<layerId>/<z>/<x>/<y>", value = image Blob
//                  (offline map cache, see js/offlineTiles.js)
//   tileRegions  – keyPath "id", one record per downloaded map area (name, bbox,
//                  zoom range, counts) so a download can be listed and deleted
//   files        – keyPath "name" (NFC), imported GPX copies {name,size,lastModified,blob}
//                  for browsers without a persistent folder handle (iPhone, see
//                  js/localFolder.js)

const DB_NAME = "gpxtouren";
const DB_VERSION = 3;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // runs on a fresh DB and on every version bump – each guard makes it safe to
    // replay, so an older user just gains the missing stores.
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("tours")) {
        db.createObjectStore("tours", { keyPath: "fileName" });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("tiles")) {
        db.createObjectStore("tiles"); // out-of-line string keys
      }
      if (!db.objectStoreNames.contains("tileRegions")) {
        db.createObjectStore("tileRegions", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("files")) {
        db.createObjectStore("files", { keyPath: "name" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode) {
  return openDB().then((db) => db.transaction(store, mode).objectStore(store));
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// --- tours ---------------------------------------------------------------

export async function getAllTours() {
  return reqToPromise((await tx("tours", "readonly")).getAll());
}

export async function getTour(fileName) {
  return reqToPromise((await tx("tours", "readonly")).get(fileName));
}

export async function putTour(tour) {
  const store = await tx("tours", "readwrite");
  await reqToPromise(store.put(tour));
}

export async function putTours(tours) {
  if (!tours.length) return;
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const t = db.transaction("tours", "readwrite");
    const store = t.objectStore("tours");
    for (const tour of tours) store.put(tour);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function deleteTours(fileNames) {
  if (!fileNames.length) return;
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const t = db.transaction("tours", "readwrite");
    const store = t.objectStore("tours");
    for (const name of fileNames) store.delete(name);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function clearTours() {
  const store = await tx("tours", "readwrite");
  await reqToPromise(store.clear());
}

// --- meta ---------------------------------------------------------------

export async function getMeta(key) {
  const rec = await reqToPromise((await tx("meta", "readonly")).get(key));
  return rec ? rec.value : undefined;
}

export async function setMeta(key, value) {
  const store = await tx("meta", "readwrite");
  await reqToPromise(store.put({ key, value }));
}

export async function deleteMeta(key) {
  const store = await tx("meta", "readwrite");
  await reqToPromise(store.delete(key));
}

// --- offline map tiles ------------------------------------------------------

export async function getTile(key) {
  return reqToPromise((await tx("tiles", "readonly")).get(key));
}

// entries: [{ key, blob }] – written in one transaction per call
export async function putTiles(entries) {
  if (!entries.length) return;
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const t = db.transaction("tiles", "readwrite");
    const store = t.objectStore("tiles");
    for (const { key, blob } of entries) store.put(blob, key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// chunked so a huge delete list doesn't build one monster transaction
export async function deleteTiles(keys) {
  if (!keys.length) return;
  const db = await openDB();
  const CHUNK = 2000;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK);
    await new Promise((resolve, reject) => {
      const t = db.transaction("tiles", "readwrite");
      const store = t.objectStore("tiles");
      for (const k of slice) store.delete(k);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
}

export async function clearTiles() {
  const store = await tx("tiles", "readwrite");
  await reqToPromise(store.clear());
}

// --- downloaded tile regions (metadata) ----------------------------------

export async function getRegions() {
  return reqToPromise((await tx("tileRegions", "readonly")).getAll());
}

export async function putRegion(region) {
  const store = await tx("tileRegions", "readwrite");
  await reqToPromise(store.put(region));
}

export async function deleteRegion(id) {
  const store = await tx("tileRegions", "readwrite");
  await reqToPromise(store.delete(id));
}

export async function clearRegions() {
  const store = await tx("tileRegions", "readwrite");
  await reqToPromise(store.clear());
}

// --- imported GPX files (local library) ------------------------------------

export async function getFileRec(name) {
  return reqToPromise((await tx("files", "readonly")).get(name));
}

/** Metadata only would be nicer, but IndexedDB has no projection – Blobs are lazy anyway. */
export async function listFileRecs() {
  return reqToPromise((await tx("files", "readonly")).getAll());
}

export async function countFiles() {
  return reqToPromise((await tx("files", "readonly")).count());
}

export async function putFiles(recs) {
  if (!recs.length) return;
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const t = db.transaction("files", "readwrite");
    const store = t.objectStore("files");
    for (const rec of recs) store.put(rec);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function deleteFiles(names) {
  if (!names.length) return;
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const t = db.transaction("files", "readwrite");
    const store = t.objectStore("files");
    for (const name of names) store.delete(name);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function clearFiles() {
  const store = await tx("files", "readwrite");
  await reqToPromise(store.clear());
}
