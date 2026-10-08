// Optional online helpers via OpenStreetMap Nominatim.
// Used for the map-search place box and for "places along the route".
// Rate-limited to respect the public Nominatim usage policy (<= 1 req/s).

import { haversine } from "./geo.js";

const BASE = "https://nominatim.openstreetmap.org";
const OVERPASS = "https://overpass-api.de/api/interpreter";
let lastCall = 0;
let lastOverpass = 0;

// Bump when resolveRoutePlaces' output shape changes so callers can re-geocode
// tours that were resolved by an older version.
export const GEOCODE_VERSION = 3;

async function throttled(url) {
  const wait = Math.max(0, 1100 - (Date.now() - lastCall));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const res = await fetch(url, {
    // de first (Alpine home region), en as fallback for names without a German form.
    headers: { Accept: "application/json", "Accept-Language": "de, en;q=0.8" },
  });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  return res.json();
}

// Latin, Latin-1 Supplement, Latin Extended-A/B, IPA, spacing modifiers,
// combining marks, general punctuation, digits, whitespace.
const NON_LATIN = /[^\u0000-\u024F\u1E00-\u1EFF\u2000-\u206F\s]/;

function isLatin(s) {
  return !!s && !NON_LATIN.test(s);
}

/**
 * Prefer a Latin-script version of a name. If `name` is already Latin it is kept;
 * otherwise a romanised variant from Nominatim's `namedetails` is used
 * (name:en, any name:*-Latn / *_rm, int_name, or any Latin name:*).
 */
function preferLatin(name, namedetails) {
  if (isLatin(name)) return name;
  const nd = namedetails || {};
  const candidates = [
    nd["name:en"],
    ...Object.keys(nd)
      .filter((k) => /(-latn|_rm|-latin)$/i.test(k))
      .map((k) => nd[k]),
    nd["int_name"],
    ...Object.keys(nd)
      .filter((k) => k.startsWith("name:"))
      .map((k) => nd[k]),
  ];
  for (const c of candidates) if (isLatin(c)) return c;
  return name; // nothing better available
}

/** Forward-geocode a place / region / country name -> {lat, lon, label} or null. */
export async function searchPlace(query) {
  const url = `${BASE}/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
  const data = await throttled(url);
  if (!Array.isArray(data) || !data.length) return null;
  const hit = data[0];
  return { lat: parseFloat(hit.lat), lon: parseFloat(hit.lon), label: hit.display_name };
}

// Address fields that name a settlement, with a rough "size / importance" rank.
// Higher = bigger. Used both to pick the most specific name (for the detail list)
// and the biggest names (for the route title).
const PLACE_RANKS = {
  city: 6,
  town: 5,
  municipality: 4,
  borough: 4,
  village: 3,
  suburb: 2,
  city_district: 2,
  quarter: 2,
  neighbourhood: 2,
  locality: 1,
  hamlet: 1,
  croft: 1,
  farm: 1,
  isolated_dwelling: 1,
};

// Fallback when a point has no settlement at all (forest, ridge, alpine terrain):
// the surrounding administrative area, most specific first.
const ADMIN_FIELDS = [
  "county",
  "state_district",
  "district",
  "region",
  "state",
];

async function reverseDetailed(lat, lon) {
  const url = `${BASE}/reverse?format=jsonv2&zoom=14&addressdetails=1&namedetails=1&lat=${lat}&lon=${lon}`;
  const data = await throttled(url);
  const a = (data && data.address) || {};
  const nd = data && data.namedetails;

  // Every settlement name present at this point, with its rank.
  const candidates = [];
  for (const [field, rank] of Object.entries(PLACE_RANKS)) {
    if (a[field]) candidates.push({ name: preferLatin(String(a[field]), nd), rank });
  }
  // The most specific one (smallest rank) – what a "you are here" label would show.
  let specific = null;
  let bestRank = Infinity;
  for (const c of candidates) {
    if (c.rank < bestRank) {
      bestRank = c.rank;
      specific = c.name;
    }
  }

  let region = null;
  for (const field of ADMIN_FIELDS) {
    if (a[field]) {
      region = preferLatin(String(a[field]), nd);
      break;
    }
  }

  return {
    specific,
    candidates,
    region,
    country: a.country ? preferLatin(a.country, nd) : null,
    countryCode: (a.country_code || "").toUpperCase() || null,
  };
}

/** Backwards-compatible: single place name for one coordinate. */
export async function reverseTown(lat, lon) {
  return (await reverseDetailed(lat, lon)).specific;
}

/** Throttled Overpass query; `body` is the statement list without the header. */
async function overpass(body) {
  const wait = Math.max(0, 1200 - (Date.now() - lastOverpass));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastOverpass = Date.now();

  const res = await fetch(OVERPASS, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(`[out:json][timeout:25];${body}out qt 60;`),
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  return res.json();
}

// place=* values worth naming a tour after, biggest first.
const SETTLEMENT_RANKS = { city: 6, town: 5, village: 3, suburb: 2, hamlet: 1 };

/**
 * The most notable settlement near a coordinate – used when the route itself runs
 * through open country and reverse geocoding yields no place at all.
 * Searches with a growing radius and prefers bigger places over merely closer ones.
 * @returns {{name:string, rank:number, dist:number}|null}
 */
export async function findSettlementNear(lat, lon, radiiM = [4000, 12000, 30000]) {
  for (const radius of radiiM) {
    let data;
    try {
      data = await overpass(
        `node(around:${Math.round(radius)},${lat.toFixed(5)},${lon.toFixed(5)})` +
          `[place~"^(city|town|village|suburb)$"][name];`
      );
    } catch {
      return null; // Overpass down – caller falls back to the region
    }

    const hits = (data.elements || [])
      .filter((e) => e.tags && e.tags.name && Number.isFinite(e.lat) && Number.isFinite(e.lon))
      .map((e) => ({
        name: preferLatin(e.tags["name:de"] || e.tags.name, e.tags),
        rank: SETTLEMENT_RANKS[e.tags.place] || 1,
        dist: haversine({ lat, lon }, { lat: e.lat, lon: e.lon }),
      }));
    if (!hits.length) continue;

    // Score: bigger wins, but distance still matters (~1 rank per 6 km).
    hits.sort((a, b) => b.rank - b.dist / 6000 - (a.rank - a.dist / 6000));
    return hits[0];
  }
  return null;
}

/**
 * Nearest named summit to a coordinate, via Overpass (natural=peak).
 * @returns {{name:string, ele:number|null, dist:number}|null}
 */
export async function findPeakNear(lat, lon, radiusM = 700) {
  const data = await overpass(
    `node(around:${Math.round(radiusM)},${lat.toFixed(5)},${lon.toFixed(5)})[natural=peak][name];`
  );

  const peaks = (data.elements || [])
    .filter((e) => e.tags && e.tags.name && Number.isFinite(e.lat) && Number.isFinite(e.lon))
    .map((e) => ({
      name: preferLatin(e.tags["name:de"] || e.tags.name, e.tags),
      ele: parseFloat(e.tags.ele) || null,
      dist: haversine({ lat, lon }, { lat: e.lat, lon: e.lon }),
    }));
  if (!peaks.length) return null;
  peaks.sort((a, b) => a.dist - b.dist || (b.ele || 0) - (a.ele || 0));
  return peaks[0];
}

/**
 * Sample the route at up to `maxRequests` evenly spaced points and reverse-geocode
 * each. If `opts.summitCoord` is given, also look up the nearest named peak.
 * When the route passes no settlement at all, the nearest notable one is looked up
 * so the tour can still be named ("… bei Bayrischzell").
 * @returns {{
 *   places: string[],                                  // most specific per point, route order
 *   placesRanked: {name:string,rank:number,pos:number,hits:number}[], // for naming
 *   region: string|null,        // county / district – last-resort locator
 *   nearPlace: string|null,     // nearest town when the route itself has none
 *   country: string|null, countryCode: string|null,
 *   summit: {name:string, ele:number|null}|null
 * }}
 */
export async function resolveRoutePlaces(polyline, maxRequests = 10, opts = {}) {
  const empty = {
    places: [],
    placesRanked: [],
    region: null,
    nearPlace: null,
    country: null,
    countryCode: null,
    summit: null,
  };
  if (!polyline || polyline.length < 2) return empty;

  const n = Math.min(maxRequests, Math.max(2, polyline.length));
  const step = (polyline.length - 1) / (n - 1);
  const picks = [];
  for (let i = 0; i < n; i++) {
    picks.push({ pt: polyline[Math.round(i * step)], pos: n > 1 ? i / (n - 1) : 0.5 });
  }

  const places = [];
  const seenSpecific = new Set();
  const ranked = new Map(); // key -> {name, rank, pos, hits}
  const regionHits = new Map(); // region name -> count
  let country = null;
  let countryCode = null;

  for (const { pt, pos } of picks) {
    const [lat, lon] = pt;
    try {
      const r = await reverseDetailed(lat, lon);
      if (r.country && !country) {
        country = r.country;
        countryCode = r.countryCode;
      }
      if (r.region) regionHits.set(r.region, (regionHits.get(r.region) || 0) + 1);
      if (r.specific) {
        const key = r.specific.toLowerCase();
        if (!seenSpecific.has(key)) {
          seenSpecific.add(key);
          places.push(r.specific);
        }
      }
      for (const c of r.candidates) {
        const key = c.name.toLowerCase();
        const prev = ranked.get(key);
        if (prev) {
          prev.hits += 1;
          prev.rank = Math.max(prev.rank, c.rank);
        } else {
          ranked.set(key, { name: c.name, rank: c.rank, pos, hits: 1 });
        }
      }
    } catch {
      /* ignore individual failures */
    }
  }

  let summit = null;
  if (Array.isArray(opts.summitCoord) && opts.summitCoord.length === 2) {
    try {
      const peak = await findPeakNear(opts.summitCoord[0], opts.summitCoord[1], 800);
      if (peak) summit = { name: peak.name, ele: peak.ele };
    } catch {
      /* Overpass unavailable – keep whatever name we already had */
    }
  }

  // most frequently seen administrative area along the route
  let region = null;
  let regionBest = 0;
  for (const [name, count] of regionHits) {
    if (count > regionBest) {
      regionBest = count;
      region = name;
    }
  }

  // Route without any settlement (forest / ridge / alpine): locate it by the
  // nearest notable town so the tour does not end up being called just "Tour".
  let nearPlace = null;
  if (!ranked.size) {
    const mid = polyline[Math.floor(polyline.length / 2)];
    const hit = await findSettlementNear(mid[0], mid[1]);
    if (hit) nearPlace = hit.name;
  }

  return {
    places,
    placesRanked: [...ranked.values()],
    region,
    nearPlace,
    country,
    countryCode,
    summit,
  };
}

/** Thin wrapper kept for older call sites: just the list of place names. */
export async function townsAlong(polyline, maxRequests = 10) {
  return (await resolveRoutePlaces(polyline, maxRequests)).places;
}
