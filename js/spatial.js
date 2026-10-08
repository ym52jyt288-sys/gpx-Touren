// Spatial queries against the stored bounding boxes and simplified polylines.

import {
  bboxIntersects,
  bboxPadded,
  bboxValid,
  bboxCenter,
  minDistanceToPolyline,
} from "./geo.js";

function polylinePoints(tour) {
  // stored as [[lat,lon],...]
  return (tour.polyline || []).map(([lat, lon]) => ({ lat, lon }));
}

/** Tours whose route passes within `radiusMeters` of `center` ({lat,lon}). */
export function toursWithinRadius(tours, center, radiusMeters) {
  const searchBox = bboxPadded(center, radiusMeters);
  const out = [];
  for (const tour of tours) {
    if (!bboxIntersects(tour.bbox, searchBox)) continue;
    const line = polylinePoints(tour);
    if (!line.length) continue;
    if (minDistanceToPolyline(center, line) <= radiusMeters) out.push(tour);
  }
  return out;
}

/**
 * Find where the tours cluster most densely and return a lat/lon box framing that
 * cluster (so the map opens zoomed to "where most tours are", not to the extent of
 * one far-away outlier). Returns null when there is nothing usable.
 *
 * Method: bucket tour centres into a coarse grid, take the fullest cell plus its
 * 8 neighbours, and union the bounding boxes of the tours in those cells.
 */
export function densestClusterBox(tours, cellDeg = 0.35) {
  const centres = [];
  for (const t of tours) {
    if (bboxValid(t.bbox)) centres.push({ t, c: bboxCenter(t.bbox) });
  }
  if (centres.length === 0) return null;
  if (centres.length <= 3) return unionBox(centres.map((x) => x.t));

  const key = (lat, lon) =>
    `${Math.floor(lat / cellDeg)}|${Math.floor(lon / cellDeg)}`;
  const cells = new Map();
  for (const x of centres) {
    const k = key(x.c.lat, x.c.lon);
    (cells.get(k) || cells.set(k, []).get(k)).push(x);
  }

  let best = null;
  let bestCount = -1;
  for (const [k, list] of cells) {
    const [gy, gx] = k.split("|").map(Number);
    let count = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = cells.get(`${gy + dy}|${gx + dx}`);
        if (n) count += n.length;
      }
    }
    if (count > bestCount) {
      bestCount = count;
      best = { gy, gx };
    }
  }

  const members = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const n = cells.get(`${best.gy + dy}|${best.gx + dx}`);
      if (n) for (const x of n) members.push(x.t);
    }
  }
  return unionBox(members.length ? members : centres.map((x) => x.t));
}

function unionBox(tours) {
  let b = null;
  for (const t of tours) {
    if (!bboxValid(t.bbox)) continue;
    if (!b) {
      b = { ...t.bbox };
    } else {
      b.minLat = Math.min(b.minLat, t.bbox.minLat);
      b.maxLat = Math.max(b.maxLat, t.bbox.maxLat);
      b.minLon = Math.min(b.minLon, t.bbox.minLon);
      b.maxLon = Math.max(b.maxLon, t.bbox.maxLon);
    }
  }
  return b;
}

/** Tours whose route enters the given lat/lon rectangle. */
export function toursIntersectingRect(tours, rect) {
  const box = {
    minLat: Math.min(rect.minLat, rect.maxLat),
    maxLat: Math.max(rect.minLat, rect.maxLat),
    minLon: Math.min(rect.minLon, rect.maxLon),
    maxLon: Math.max(rect.minLon, rect.maxLon),
  };
  const out = [];
  for (const tour of tours) {
    if (!bboxIntersects(tour.bbox, box)) continue;
    const line = tour.polyline || [];
    const hit = line.some(
      ([lat, lon]) =>
        lat >= box.minLat &&
        lat <= box.maxLat &&
        lon >= box.minLon &&
        lon <= box.maxLon
    );
    if (hit) out.push(tour);
  }
  return out;
}
