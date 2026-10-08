// Geodesic helpers. Pure functions, safe to use on the main thread or in a worker.

export const METERS_PER_DEG_LAT = 111320;

const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in meters between {lat,lon} points. */
export function haversine(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Perpendicular distance (m) from point `p` to segment `a`–`b`, using a local
 * equirectangular projection anchored at `a`. Fine for short GPS segments.
 */
export function perpendicularDistance(p, a, b) {
  const mPerLon = METERS_PER_DEG_LAT * Math.cos(toRad(a.lat));
  const bx = (b.lon - a.lon) * mPerLon;
  const by = (b.lat - a.lat) * METERS_PER_DEG_LAT;
  const px = (p.lon - a.lon) * mPerLon;
  const py = (p.lat - a.lat) * METERS_PER_DEG_LAT;

  const segLenSq = bx * bx + by * by;
  if (segLenSq === 0) return Math.hypot(px, py);
  let t = (px * bx + py * by) / segLenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - t * bx, py - t * by);
}

/** Smallest distance (m) from `p` to any segment of the polyline (array of {lat,lon}). */
export function minDistanceToPolyline(p, line) {
  if (!line.length) return Infinity;
  if (line.length === 1) return haversine(p, line[0]);
  let min = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const d = perpendicularDistance(p, line[i], line[i + 1]);
    if (d < min) min = d;
  }
  return min;
}

/**
 * Ramer–Douglas–Peucker simplification. `points` is an array of {lat,lon}.
 * Iterative (explicit stack) so huge tracks cannot overflow the call stack.
 */
export function douglasPeucker(points, toleranceMeters) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    if (last <= first + 1) continue;
    let maxDist = 0;
    let index = first;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistance(points[i], points[first], points[last]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > toleranceMeters) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/** Simplify with an adaptive tolerance so the result lands near `maxPoints`. */
export function simplifyToBudget(points, maxPoints = 200) {
  if (points.length <= maxPoints) return points.slice();
  let low = 1;
  let high = 8000;
  let result = points;
  for (let i = 0; i < 18; i++) {
    const mid = (low + high) / 2;
    result = douglasPeucker(points, mid);
    if (result.length > maxPoints) low = mid;
    else high = mid;
  }
  return result.length > maxPoints ? douglasPeucker(points, high) : result;
}

// --- Bounding box -----------------------------------------------------------

export function emptyBBox() {
  return {
    minLat: Infinity,
    maxLat: -Infinity,
    minLon: Infinity,
    maxLon: -Infinity,
  };
}

export function extendBBox(box, lat, lon) {
  if (lat < box.minLat) box.minLat = lat;
  if (lat > box.maxLat) box.maxLat = lat;
  if (lon < box.minLon) box.minLon = lon;
  if (lon > box.maxLon) box.maxLon = lon;
  return box;
}

export function bboxValid(box) {
  return (
    box &&
    Number.isFinite(box.minLat) &&
    box.minLat <= box.maxLat &&
    box.minLon <= box.maxLon
  );
}

export function bboxIntersects(a, b) {
  if (!bboxValid(a) || !bboxValid(b)) return false;
  return (
    a.minLat <= b.maxLat &&
    a.maxLat >= b.minLat &&
    a.minLon <= b.maxLon &&
    a.maxLon >= b.minLon
  );
}

export function bboxCenter(box) {
  return { lat: (box.minLat + box.maxLat) / 2, lon: (box.minLon + box.maxLon) / 2 };
}

/** Grow a bbox by a radius given in meters (rough, for pre-filtering). */
export function bboxPadded(center, radiusMeters) {
  const latPad = radiusMeters / METERS_PER_DEG_LAT;
  const lonPad =
    radiusMeters / (METERS_PER_DEG_LAT * Math.max(0.1, Math.cos(toRad(center.lat))));
  return {
    minLat: center.lat - latPad,
    maxLat: center.lat + latPad,
    minLon: center.lon - lonPad,
    maxLon: center.lon + lonPad,
  };
}
