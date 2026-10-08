// Offline map-tile cache: download the tiles for a framed area + zoom range into
// IndexedDB, serve them to Leaflet when they exist (online or off), and let the
// user delete a saved area again.
//
// Pragmatic scope, on purpose:
//  - base map only (not the overlays), one area = one bbox + [minZoom, maxZoom]
//  - hard/soft tile caps + a gentle throttle so we never bulk-hammer a public
//    tile server. The OSM / OpenTopoMap / Esri tile policies do not really allow
//    offline stockpiling; this is meant for a personal, single-user tool saving
//    a trip-sized region. Keep it small. See webapp/README.md.
//
// Storage: db.js `tiles` store, key "<layerId>/<z>/<x>/<y>" -> image Blob;
// db.js `tileRegions` store holds one metadata record per download.

import { getTile, putTiles, deleteTiles, putRegion, deleteRegion } from "./db.js";

export const MAX_ZOOM_CAP = 16; // deepest zoom we ever offer to download
export const SOFT_TILE_LIMIT = 5000; // warn beyond this
export const HARD_TILE_LIMIT = 20000; // refuse beyond this

// rough average bytes per raster tile, per base layer – only for the size hint
const BYTES_PER_TILE = { osm: 18000, topo: 45000, sat: 22000 };

const DOWNLOAD_CONCURRENCY = 2; // OSM policy: at most two download threads
const PER_TILE_PAUSE_MS = 25; // extra breathing room between requests

// ---- slippy-map tile math ------------------------------------------------

export function lngToTileX(lng, z) {
  return Math.floor(((lng + 180) / 360) * 2 ** z);
}

export function latToTileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z
  );
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// bounds: { north, south, east, west } in degrees
function tileRangeAtZoom(bounds, z) {
  const n = 2 ** z;
  const xa = clamp(lngToTileX(bounds.west, z), 0, n - 1);
  const xb = clamp(lngToTileX(bounds.east, z), 0, n - 1);
  const ya = clamp(latToTileY(bounds.north, z), 0, n - 1); // north -> smaller y
  const yb = clamp(latToTileY(bounds.south, z), 0, n - 1);
  return {
    x0: Math.min(xa, xb), x1: Math.max(xa, xb),
    y0: Math.min(ya, yb), y1: Math.max(ya, yb),
  };
}

/** Total tile count for a bbox across an (inclusive) zoom range. Cheap. */
export function countTiles(bounds, minZoom, maxZoom) {
  let total = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const r = tileRangeAtZoom(bounds, z);
    total += (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
  }
  return total;
}

/** Yields every {z, x, y} tile of a bbox across the zoom range. */
export function* iterTiles(bounds, minZoom, maxZoom) {
  for (let z = minZoom; z <= maxZoom; z++) {
    const r = tileRangeAtZoom(bounds, z);
    for (let x = r.x0; x <= r.x1; x++) {
      for (let y = r.y0; y <= r.y1; y++) yield { z, x, y };
    }
  }
}

function tileInRegion(coord, region) {
  if (coord.z < region.minZoom || coord.z > region.maxZoom) return false;
  const r = tileRangeAtZoom(region.bounds, coord.z);
  return coord.x >= r.x0 && coord.x <= r.x1 && coord.y >= r.y0 && coord.y <= r.y1;
}

/** Rough download size in bytes, for the pre-download hint only. */
export function estimateBytes(layerId, tileCount) {
  return tileCount * (BYTES_PER_TILE[layerId] || 25000);
}

// ---- URL building (downloader path – layer is not on a map) -------------

function fillTileUrl(layerDef, z, x, y, subIndex) {
  const subs = layerDef.options && layerDef.options.subdomains;
  const s = Array.isArray(subs)
    ? subs[subIndex % subs.length]
    : typeof subs === "string" && subs
      ? subs[subIndex % subs.length]
      : "a";
  return layerDef.url
    .replaceAll("{s}", s)
    .replaceAll("{z}", String(z))
    .replaceAll("{x}", String(x))
    .replaceAll("{y}", String(y))
    .replaceAll("{r}", "");
}

// ---- Leaflet layer that reads the cache first --------------------------

let OfflineTileLayerClass = null;

function buildClass() {
  const L = window.L;
  if (OfflineTileLayerClass) return OfflineTileLayerClass;

  OfflineTileLayerClass = L.TileLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement("img");
      tile.setAttribute("role", "presentation");
      tile.alt = "";
      tile.onselectstart = L.Util.falseFn;
      tile.onmousemove = L.Util.falseFn;
      const co = this.options.crossOrigin;
      if (co || co === "") tile.crossOrigin = co === true ? "" : co;

      const layerId = this.options.offlineLayerId;
      const netUrl = this.getTileUrl(coords);
      const key = `${layerId}/${coords.z}/${coords.x}/${coords.y}`;

      L.DomEvent.on(tile, "load", L.Util.bind(this._tileOnLoad, this, done, tile));
      L.DomEvent.on(tile, "error", L.Util.bind(this._tileOnError, this, done, tile));

      getTile(key)
        .then((blob) => {
          if (tile._cancelled) return;
          if (blob instanceof Blob) {
            const obj = URL.createObjectURL(blob);
            tile._objectUrl = obj;
            tile.src = obj;
          } else {
            tile.src = netUrl; // not cached -> network (blank when offline)
          }
        })
        .catch(() => {
          if (!tile._cancelled) tile.src = netUrl;
        });

      return tile;
    },

    _removeTile(key) {
      const entry = this._tiles[key];
      if (entry && entry.el) {
        entry.el._cancelled = true;
        if (entry.el._objectUrl) {
          URL.revokeObjectURL(entry.el._objectUrl);
          entry.el._objectUrl = null;
        }
      }
      L.TileLayer.prototype._removeTile.call(this, key);
    },
  });

  return OfflineTileLayerClass;
}

/**
 * A tile layer that serves cached tiles from IndexedDB when present.
 * @param {string} layerId  base-map id ("osm" | "topo" | "sat")
 * @param {string} url      Leaflet URL template
 * @param {object} options  Leaflet TileLayer options
 */
export function offlineTileLayer(layerId, url, options = {}) {
  const Cls = buildClass();
  return new Cls(url, { ...options, offlineLayerId: layerId });
}

// ---- download / delete a region --------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Download every tile of `spec` into the cache, then store a region record.
 *
 * @param {{name,layerId,layerDef,bounds,minZoom,maxZoom}} spec
 * @param {{onProgress?:(p)=>void, shouldStop?:()=>boolean}} [hooks]
 * @returns {Promise<object|null>} the stored region record (null if nothing kept)
 */
export async function downloadRegion(spec, { onProgress, shouldStop } = {}) {
  const { layerId, layerDef, bounds, minZoom, maxZoom } = spec;
  const total = countTiles(bounds, minZoom, maxZoom);
  const iterator = iterTiles(bounds, minZoom, maxZoom);

  let done = 0;
  let stored = 0;
  let bytes = 0;
  let failed = 0;
  let subIndex = 0;
  let stopped = false;
  const buffer = [];

  const flush = async () => {
    if (!buffer.length) return;
    await putTiles(buffer.splice(0, buffer.length));
  };

  const report = () => onProgress && onProgress({ done, total, stored, bytes, failed });

  async function worker() {
    // generator .next() is atomic on our single thread -> safe to share
    for (const coord of iterator) {
      if (stopped || (shouldStop && shouldStop())) {
        stopped = true;
        return;
      }
      const key = `${layerId}/${coord.z}/${coord.x}/${coord.y}`;
      try {
        const have = await getTile(key);
        if (!(have instanceof Blob)) {
          const url = fillTileUrl(layerDef, coord.z, coord.x, coord.y, subIndex++);
          const res = await fetch(url, { credentials: "omit", cache: "no-store" });
          if (res.ok) {
            const blob = await res.blob();
            if (blob.size > 0) {
              buffer.push({ key, blob });
              stored += 1;
              bytes += blob.size;
              if (buffer.length >= 40) await flush();
            } else {
              failed += 1;
            }
          } else {
            failed += 1;
          }
        }
      } catch {
        failed += 1;
      }
      done += 1;
      if (done % 5 === 0) report();
      await sleep(PER_TILE_PAUSE_MS);
    }
  }

  await Promise.all(
    Array.from({ length: DOWNLOAD_CONCURRENCY }, () => worker())
  );
  await flush();
  report();

  if (stored === 0) return null; // nothing kept -> don't leave a phantom record

  const region = {
    id: `${layerId}:${Date.now()}`,
    name: (spec.name || "").trim() || "Kartenausschnitt",
    layerId,
    bounds,
    minZoom,
    maxZoom,
    tiles: total,
    stored,
    bytes,
    failed,
    partial: stopped,
    createdAt: Date.now(),
  };
  await putRegion(region);
  return region;
}

/**
 * Keys of a region's tiles that no *other* remaining region of the same base
 * layer still covers – i.e. the ones safe to delete. Pure, unit-testable.
 */
export function orphanKeysForRegion(region, remaining) {
  const others = remaining.filter(
    (r) => r.id !== region.id && r.layerId === region.layerId
  );
  const keys = [];
  for (const c of iterTiles(region.bounds, region.minZoom, region.maxZoom)) {
    if (!others.some((r) => tileInRegion(c, r))) {
      keys.push(`${region.layerId}/${c.z}/${c.x}/${c.y}`);
    }
  }
  return keys;
}

/**
 * Delete a region and the tiles only it covered.
 * @param {object} region              the region to remove
 * @param {object[]} allRegions        every region currently stored (incl. this)
 * @returns {Promise<number>} number of tile blobs deleted
 */
export async function removeRegion(region, allRegions) {
  const keys = orphanKeysForRegion(region, allRegions);
  await deleteTiles(keys);
  await deleteRegion(region.id);
  return keys.length;
}
