// Turns raw GPX text into a plain, structured-clone-friendly "tour draft".
// Pure: no DOM, no IndexedDB. Runs in the worker or inline.

import { parseGpxText } from "./gpx.js";
import {
  haversine,
  douglasPeucker,
  simplifyToBudget,
  emptyBBox,
  extendBBox,
} from "./geo.js";
import { stripAppNames } from "./format.js";

const ELEVATION_NOISE_M = 3;          // ignore altitude wobble below this
const MOVING_SPEED_MIN_MPS = 0.7;     // ~2.5 km/h => "moving"
const MAX_GAP_S = 600;                // treat larger time gaps as pauses
const PROFILE_TARGET_POINTS = 300;
const POLYLINE_BUDGET = 200;

// Rad vs. Wandern.
const CYCLING_KMH = 11;               // average speed at/above which it is a bike ride
const CYCLING_FALLBACK_KM = 25;       // no timestamps -> from this distance on it is "Rad"

// "Bergtour" (summit hike) detection.
const SUMMIT_MIN_ASCENT_M = 450;     // total climbing
const SUMMIT_MIN_NET_CLIMB_M = 300;  // top vs. the lower of start/end
const SUMMIT_WPT_MAX_DIST_M = 250;   // a named waypoint this close to the top = the summit

// Bump when analyzeGpx output changes so an existing index re-derives itself
// (see indexer.js – a mismatch is treated like a changed file).
export const ANALYZER_VERSION = 7;

export function makeSignature(size, lastModified) {
  return `${size}-${lastModified}`;
}

function computeMetrics(points) {
  const m = {
    distanceM: 0,
    totalS: 0,
    movingS: 0,
    ascentM: 0,
    descentM: 0,
    minEleM: Infinity,
    maxEleM: -Infinity,
    startTime: null,
    wallElapsedS: 0, // last timestamp - first timestamp (includes all pauses)
    bbox: emptyBBox(),
    profile: [],
    highPoint: null, // {lat, lon, ele, pos} – the track's highest point
  };

  let endTime = null;
  for (const p of points) {
    if (p.time != null) {
      if (m.startTime == null) m.startTime = p.time;
      endTime = p.time;
    }
  }
  if (m.startTime != null && endTime != null && endTime > m.startTime) {
    m.wallElapsedS = (endTime - m.startTime) / 1000;
  }

  let cumulative = 0;
  let eleRef = null;
  let prev = null;
  let hiCumulative = 0;
  const rawProfile = [];

  for (const p of points) {
    extendBBox(m.bbox, p.lat, p.lon);

    if (prev) {
      const seg = haversine(prev, p);
      cumulative += seg;
      m.distanceM += seg;
      if (prev.time != null && p.time != null) {
        const dt = (p.time - prev.time) / 1000;
        if (dt > 0 && dt <= MAX_GAP_S) {
          m.totalS += dt;
          if (seg / dt >= MOVING_SPEED_MIN_MPS) m.movingS += dt;
        }
      }
    }

    if (p.ele != null) {
      if (p.ele < m.minEleM) m.minEleM = p.ele;
      if (p.ele > m.maxEleM) {
        m.maxEleM = p.ele;
        m.highPoint = { lat: p.lat, lon: p.lon, ele: p.ele, pos: 0 };
        hiCumulative = cumulative;
      }

      if (eleRef == null) {
        eleRef = p.ele;
      } else {
        const delta = p.ele - eleRef;
        if (Math.abs(delta) >= ELEVATION_NOISE_M) {
          if (delta > 0) m.ascentM += delta;
          else m.descentM += -delta;
          eleRef = p.ele;
        }
      }
      rawProfile.push([cumulative, p.ele]);
    }

    prev = p;
  }

  if (!Number.isFinite(m.minEleM)) m.minEleM = 0;
  if (!Number.isFinite(m.maxEleM)) m.maxEleM = 0;
  if (m.movingS === 0) m.movingS = m.totalS;
  if (m.highPoint) {
    m.highPoint.pos = m.distanceM > 0 ? hiCumulative / m.distanceM : 0.5;
  }
  m.profile = downsample(rawProfile, PROFILE_TARGET_POINTS);
  return m;
}

function downsample(profile, target) {
  if (profile.length <= target || target < 2) return profile;
  const step = (profile.length - 1) / (target - 1);
  const out = [];
  for (let i = 0; i < target; i++) out.push(profile[Math.round(i * step)]);
  return out;
}

// Rad vs. Wandern. Speed decides whenever the track carries usable timing
// (that is what worked reliably before); only fall back to distance when there
// are no timestamps at all (planned routes, sparse loggers).
function suggestCategory(m) {
  const tight = m.totalS > 0 ? m.totalS : m.movingS; // sum of short (<10 min) gaps
  // Guard against sparsely-logged tracks where `tight` is tiny and speed explodes:
  // assume at most ~half of the wall-clock time is breaks.
  const secs = Math.max(tight, (m.wallElapsedS || 0) * 0.5);
  if (secs > 120 && m.distanceM > 300) {
    const kmh = (m.distanceM / secs) * 3.6;
    return kmh >= CYCLING_KMH ? "cycling" : "hiking";
  }
  return m.distanceM / 1000 >= CYCLING_FALLBACK_KM ? "cycling" : "hiking";
}

/**
 * Is this GPX a *planned* route (downloaded / made in a planner) rather than a
 * recorded track? Signals:
 *  - it is a <rte> (route) not a <trk>              -> strongest
 *  - no <time> anywhere (recorders almost always stamp time)
 *  - sparse points: large average spacing / few points per km (planner puts a
 *    point only at junctions, a GPS logs every 1–5 s)
 */
function detectIsPlan(parsed, m) {
  if (parsed.isRouteOnly) return true;

  const pts = parsed.points;
  const hasAnyTime = pts.some((p) => p.time != null);
  if (hasAnyTime) return false;

  const spacingM = m.distanceM / Math.max(1, pts.length - 1);
  const perKm = pts.length / Math.max(0.2, m.distanceM / 1000);
  return spacingM > 120 || perKm < 12;
}

/**
 * Detect a "Bergtour": lots of climbing to a distinct high point that is reached
 * mid-tour (climb up, come back down), on foot. Returns {isSummitTour, coord}.
 */
function detectSummit(parsed, m, category) {
  const hp = m.highPoint;
  if (!hp || category === "cycling") return { isSummitTour: false, coord: null };

  const eles = parsed.points.map((p) => p.ele).filter((e) => e != null);
  if (eles.length < 3) return { isSummitTour: false, coord: null };

  const startEle = parsed.points[0].ele ?? eles[0];
  const endEle = parsed.points[parsed.points.length - 1].ele ?? eles[eles.length - 1];
  const netClimb = m.maxEleM - Math.min(startEle, endEle);

  const ok =
    m.ascentM >= SUMMIT_MIN_ASCENT_M &&
    netClimb >= SUMMIT_MIN_NET_CLIMB_M &&
    hp.pos > 0.1 &&
    hp.pos < 0.9;

  return { isSummitTour: ok, coord: ok ? [round6(hp.lat), round6(hp.lon)] : null };
}

/** A named <wpt> within SUMMIT_WPT_MAX_DIST_M of the high point -> the summit name. */
function summitNameFromWaypoints(waypoints, highPoint) {
  if (!waypoints || !waypoints.length || !highPoint) return null;
  let best = null;
  let bestDist = Infinity;
  for (const w of waypoints) {
    if (!w.name) continue;
    const d = haversine(
      { lat: w.lat, lon: w.lon },
      { lat: highPoint.lat, lon: highPoint.lon }
    );
    if (d < bestDist) {
      bestDist = d;
      best = w;
    }
  }
  return best && bestDist <= SUMMIT_WPT_MAX_DIST_M ? best.name : null;
}

/** German distance string: "36,4 km", "100 km". */
export function formatKm(distanceM) {
  const km = distanceM / 1000;
  const val = km >= 100 ? Math.round(km) : Math.round(km * 10) / 10;
  return `${String(val).replace(".", ",")} km`;
}

/** Start and end within ~400 m (or 6 % of the length) => a loop. */
export function isLoopTour(t) {
  if (!t || !t.start || !t.end) return false;
  const d = haversine(
    { lat: t.start[0], lon: t.start[1] },
    { lat: t.end[0], lon: t.end[1] }
  );
  return d < Math.max(400, (t.distanceM || 0) * 0.06);
}

// Words that, on their own, carry no information ("Wanderung.gpx", "Track 3").
const GENERIC_LABEL =
  /^(track|route|tour|wegpunkt|aktivität|activity|strecke|wanderung|hike|walk|lauf|spaziergang|radtour|bergtour|ausfahrt|ride|fahrt|runde|export|gpx|neu|unbenannt|new)[\s_-]*\d*$/i;

/**
 * Auto-generated junk names like  "30 17#7km55#737m#4h17"  or  "20240715_083215"
 * – lots of digits / units, glued together, no real words.
 */
function isCrypticName(raw) {
  const s = String(raw || "").trim();
  if (s.length < 3) return true;

  // "#"-delimited field blobs (APE@MAP style)
  if (/\S#|#\S/.test(s)) return true;

  const tokens = s.split(/[\s#_/|,;]+/).filter(Boolean);
  const wordish = tokens.filter((t) => {
    if (t.length < 3) return false;
    const letters = (t.match(/[A-Za-zÀ-ÿ]/g) || []).length;
    if (letters / t.length < 0.6) return false;
    // bare measurements: "737m", "7km", "1250hm", "4h17", "45min"
    if (/^\d+(?:[.,]\d+)?\s*(?:k?m|hm|h\d*|min|std)$/i.test(t)) return false;
    return true;
  });
  if (wordish.length === 0) return true;

  const letters = (s.match(/[A-Za-zÀ-ÿ]/g) || []).length;
  const digits = (s.match(/\d/g) || []).length;
  if (letters < 3) return true;
  if (digits > letters && wordish.join("").length < 5) return true;

  return false;
}

function looksMeaningful(name) {
  if (!name) return false;
  const n = name.trim();
  if (n.length < 3) return false;
  if (/^\d{2,4}[-/.\s]\d{1,2}[-/.\s]\d{1,2}/.test(n)) return false; // starts with a date
  if (GENERIC_LABEL.test(n)) return false;
  if (/^[\d\s:_.\-]+$/.test(n)) return false; // only digits / separators
  if (isCrypticName(n)) return false; // "30 17#7km55#737m#4h17" & co.
  return true;
}

/**
 * Turn a filename or GPX <name> into a descriptive label, e.g.
 *   "2025-09-14_Wendelsteinrundfahrt.gpx" -> "Wendelsteinrundfahrt"
 * Returns null when nothing informative is left.
 */
function labelFromString(raw) {
  if (!raw) return null;
  let s = String(raw)
    .replace(/\.(gpx|xml)$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    // leading app/exporter names
    .replace(/^(komoot|strava|outdooractive|bikemap|garmin connect|garmin|alltrails|ape@?map|gpsies|locus|osmand)[\s:._-]+/i, "")
    // leading / trailing date stamps
    .replace(/^\d{2,4}[-/.]\d{1,2}[-/.]\d{1,2}[\sT_-]*/, "")
    .replace(/[\s_-]*\d{2,4}[-/.]\d{1,2}[-/.]\d{1,2}$/, "")
    // leading "#12 " / "03) " indices
    .replace(/^[#\s-]*\d+[\s.)_-]+/, "")
    // trailing " (36 km)" / " 36km"
    .replace(/[\s(_-]*\d+(?:[.,]\d+)?\s*(?:km|m)\)?\s*$/i, "")
    .replace(/[\s_-]+$/, "")
    .trim();
  // drop app names anywhere ("My Phone My Guide", "OsmAnd", …)
  s = stripAppNames(s);
  // drop a leading activity word (the category is shown separately):
  // "Bergtour-Pendling" -> "Pendling", "Radtour Inntal" -> "Inntal"
  s = s
    .replace(
      /^(bergtour|berg|wanderung|wandern|radtour|rennrad|gravel|mtb|mountainbike|tour|tagestour|halbtagestour|route|track|hike|hiking|ride|walk|ausfahrt|fahrt|spaziergang|lauf|trail|planung|plan)[\s:._-]+/i,
      ""
    )
    .trim();
  return looksMeaningful(s) ? s : null;
}

/** The most descriptive label out of the filename and the GPX <name>. */
function pickLabel(fileName, parsedName) {
  const cands = [labelFromString(fileName), labelFromString(parsedName)].filter(Boolean);
  if (!cands.length) return null;
  // longest wins (a compound like "Wendelsteinrundfahrt" beats a bare "Wanderung");
  // filename first on a tie.
  cands.sort((a, b) => b.length - a.length);
  return cands[0];
}

const lc = (s) => String(s || "").trim().toLowerCase();

/** Offline fallback title (used until the route places have been geocoded). */
function baseTitle(t) {
  const km = formatKm(t.distanceM);
  if (t.titleLabel) return `${t.titleLabel} (${km})`;
  if (t.summitName) return `${t.summitName} (${km})`;
  const kind = isLoopTour(t) ? "Rundtour" : "Tour";
  const hm = t.ascentM >= 150 ? ` · ${Math.round(t.ascentM)} hm` : "";
  return `${kind} (${km}${hm})`;
}

/**
 * Pick the names for the route title, favouring the *biggest* places (city/town
 * over hamlet) while keeping route order and covering start → middle → end.
 *
 * `places` may be:
 *   - `[{name, rank, pos, hits}]`  (from geocode.resolveRoutePlaces – preferred)
 *   - `["Name", ...]`              (legacy plain list – ranks unknown, kept in order)
 */
function selectTitlePlaces(places, loop) {
  let ranked = [];
  if (Array.isArray(places) && places.length && typeof places[0] === "object") {
    ranked = places
      .filter((p) => p && p.name && String(p.name).trim())
      .map((p) => ({
        name: String(p.name).trim(),
        rank: Number.isFinite(p.rank) ? p.rank : 2,
        pos: Number.isFinite(p.pos) ? p.pos : 0.5,
        hits: Number.isFinite(p.hits) ? p.hits : 1,
      }));
  } else if (Array.isArray(places)) {
    const list = places.map((n) => String(n || "").trim()).filter(Boolean);
    ranked = list.map((name, i) => ({
      name,
      rank: 2,
      pos: list.length > 1 ? i / (list.length - 1) : 0.5,
      hits: 1,
    }));
  }
  if (!ranked.length) return [];

  ranked.sort((a, b) => a.pos - b.pos);

  const bestOf = (arr) =>
    arr.length
      ? arr.reduce((best, x) => (x.rank > best.rank || (x.rank === best.rank && x.hits > best.hits) ? x : best))
      : null;

  // Anchor at the biggest place near the start and (for non-loops) near the end.
  const startAnchor = bestOf(ranked.filter((p) => p.pos <= 0.18)) || ranked[0];
  const endAnchor = loop
    ? null
    : bestOf(ranked.filter((p) => p.pos >= 0.82)) || ranked[ranked.length - 1];

  const isAnchor = (p) =>
    (startAnchor && lc(p.name) === lc(startAnchor.name)) ||
    (endAnchor && lc(p.name) === lc(endAnchor.name));

  // Middle: up to 3 of the biggest places, spread along the route. Prefer real
  // settlements (rank >= 2); only fall back to smaller ones for a loop that would
  // otherwise have just the start.
  const candidates = ranked.filter((p) => !isAnchor(p));
  const pick = (pool, limit) => {
    const out = [];
    for (const p of pool.slice().sort((a, b) => b.rank - a.rank || b.hits - a.hits || a.pos - b.pos)) {
      if (out.length >= limit) break;
      if (out.some((q) => Math.abs(q.pos - p.pos) < 0.13 || lc(q.name) === lc(p.name))) continue;
      if (startAnchor && Math.abs(p.pos - startAnchor.pos) < 0.09) continue;
      if (endAnchor && Math.abs(p.pos - endAnchor.pos) < 0.09) continue;
      out.push(p);
    }
    return out;
  };
  let middle = pick(candidates.filter((p) => p.rank >= 2), 3);
  if (loop && !middle.length) middle = pick(candidates, 3);
  middle.sort((a, b) => a.pos - b.pos);

  const seq = loop
    ? [startAnchor, ...middle]
    : [startAnchor, ...middle, endAnchor];

  const names = [];
  for (const p of seq) {
    if (p && p.name && lc(p.name) !== lc(names[names.length - 1] || "")) names.push(p.name.trim());
  }
  // keep it to 3–4 names – drop from the centre outward
  while (names.length > 4) names.splice(Math.floor(names.length / 2), 1);
  return names;
}

/**
 * Build a readable name, e.g.
 *   "Burghausen-Chieming-Sachrang-Kufstein (100 km)"
 *   "Rundtour: München-Baldham-Grasbrunn (36,4 km)"
 *   "Kufstein – Pendling (12,3 km)"                       (Bergtour: start – summit)
 *   "Wendelsteinrundfahrt: Bayrischzell-Osterhofen (32 km)"  (label from filename)
 *   "Rundtour bei Bayrischzell (7,6 km)"                  (route without any place)
 * Returns null when there is nothing usable (caller keeps the base title).
 */
export function buildRouteName(t, places) {
  const loop = isLoopTour(t);
  const km = formatKm(t.distanceM);
  const rawLabel = t && t.titleLabel ? stripAppNames(String(t.titleLabel).trim()) : "";
  const label = rawLabel && !isCrypticName(rawLabel) ? rawLabel : "";
  const summit = t && t.isSummitTour && t.summitName ? String(t.summitName).trim() : "";
  const names = selectTitlePlaces(places, loop);

  // The "route part": summit tours -> "Start – Gipfel [– Ziel]"; otherwise the
  // biggest places joined with "-".
  let body = "";
  if (summit) {
    const parts = [];
    const startP = names[0] || "";
    if (startP) parts.push(startP);
    parts.push(summit);
    const endP = loop ? "" : names[names.length - 1] || "";
    if (endP && lc(endP) !== lc(startP) && lc(endP) !== lc(summit)) parts.push(endP);
    body = parts.join(" – ");
  } else if (names.length) {
    let list = names.slice();
    const budget = loop ? 52 : 60;
    while (list.join("-").length > budget && list.length > 3) {
      list.splice(Math.floor(list.length / 2), 1);
    }
    body = list.join("-");
  }

  // The route itself passes no named place (forest, ridge, alpine terrain):
  // locate the tour by the nearest town, else by its administrative region.
  const near = t && t.nearPlace ? String(t.nearPlace).trim() : "";
  const region = t && t.region ? String(t.region).trim() : "";
  // "im Landkreis Miesbach" vs. "in Tirol"
  const regionPrep = /^(land)?kreis\b|^bezirk\b|^kanton\b|^regierungsbezirk\b|^distrikt\b/i.test(region)
    ? "im"
    : "in";
  const locator = near ? `bei ${near}` : region ? `${regionPrep} ${region}` : "";

  if (label) {
    const bodyHasLabel = body && lc(body).includes(lc(label));
    const labelIsFullTitle =
      label.length > 24 ||
      /[-–][^-–]+[-–]/.test(label) || // already an "A-B-C" style
      names.some((n) => lc(label).includes(lc(n))); // label names a route place

    let core;
    if (bodyHasLabel) core = body;
    else if (!body) core = locator && !lc(label).includes(lc(near || region))
      ? `${label} ${locator}`
      : label;
    else if (labelIsFullTitle) core = label;
    else {
      // "Label: place-place-place" – keep the body short next to the label
      const short = summit ? body : names.slice(0, 3).join("-");
      core = `${label}: ${short}`;
    }
    return `${core} (${km})`;
  }

  if (!body) {
    if (!locator) return null;
    return `${loop ? "Rundtour" : "Tour"} ${locator} (${km})`;
  }
  const core = summit ? body : loop ? `Rundtour: ${body}` : body;
  return `${core} (${km})`;
}

/**
 * @param {string} text  raw GPX
 * @param {{fileName:string,size:number,lastModified:number}} file
 * @returns {object} draft
 */
export function analyzeGpx(text, file) {
  const parsed = parseGpxText(text);
  if (parsed.points.length < 2) {
    throw new Error("Keine verwertbaren Track-/Routenpunkte");
  }

  const m = computeMetrics(parsed.points);

  const latlon = parsed.points.map((p) => ({ lat: p.lat, lon: p.lon }));
  const simplified = simplifyToBudget(latlon, POLYLINE_BUDGET).map((p) => [
    round6(p.lat),
    round6(p.lon),
  ]);

  const first = parsed.points[0];
  const last = parsed.points[parsed.points.length - 1];
  const geom = {
    start: [round6(first.lat), round6(first.lon)],
    end: [round6(last.lat), round6(last.lon)],
    distanceM: m.distanceM,
    ascentM: m.ascentM,
  };

  const category = suggestCategory(m);
  const summit = detectSummit(parsed, m, category);
  const summitName = summit.isSummitTour
    ? summitNameFromWaypoints(parsed.waypoints, m.highPoint)
    : null;
  const titleLabel = pickLabel(file.fileName, parsed.name);

  return {
    fileName: file.fileName,
    size: file.size,
    lastModified: file.lastModified,
    signature: makeSignature(file.size, file.lastModified),
    av: ANALYZER_VERSION,

    titleLabel, // descriptive words from the filename / <name>, e.g. "Wendelsteinrundfahrt"
    title: baseTitle({ ...geom, summitName, titleLabel }), // offline fallback
    titleAuto: null,                      // filled after geocoding
    titleUser: null,                      // manual override
    tourDate: m.startTime, // ms epoch or null
    creator: parsed.creator || null,

    distanceM: m.distanceM,
    movingS: m.movingS,
    totalS: m.totalS,
    ascentM: m.ascentM,
    descentM: m.descentM,
    minEleM: m.minEleM,
    maxEleM: m.maxEleM,
    pointCount: parsed.points.length,

    bbox: m.bbox,
    start: geom.start,
    end: geom.end,
    polyline: simplified,
    elevation: m.profile.map(([d, e]) => [Math.round(d), Math.round(e)]),

    category, // Rad / Wandern (length + speed)
    categoryUser: null, // manual override
    isPlan: detectIsPlan(parsed, m), // planned route, not self-recorded
    isPlanUser: null, // manual override (null = use auto)
    isSummitTour: summit.isSummitTour, // Bergtour -> use the summit in the name
    summitCoord: summit.coord, // [lat,lon] of the high point (for peak lookup)
    summitName: summitName, // from a named <wpt>; else filled by geocoding
    summitEle: summit.isSummitTour ? Math.round(m.maxEleM) : null,
    placeNames: [], // most specific per sample point (detail view)
    placesRanked: [], // {name,rank,pos,hits} for the route title
    region: "", // county / district (fallback locator)
    nearPlace: "", // nearest town when the route passes none
    country: "",
    countryCode: "",
    placesResolved: false,
    geoV: 0, // geocoding schema version (see main.js)
    rating: 0, // 0..5 stars (user)
    hidden: false, // user hid this track -> never shown in list / map
    notes: "",
  };
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

// Re-exported so callers can force a stronger simplification if ever needed.
export { douglasPeucker };
