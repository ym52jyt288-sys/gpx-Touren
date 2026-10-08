// Human-readable formatting.

// German number formatting ("6,8 km", "1.838 m") – matches the generated tour names.
const nf1 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });

export function fmtDistance(meters) {
  if (meters >= 1000) return `${nf1.format(meters / 1000)} km`;
  return `${Math.round(meters)} m`;
}

/** Sum of many tours: whole kilometres ("1.234 km"). */
export function fmtTotalDistance(meters) {
  return `${nf0.format(Math.round((meters || 0) / 1000))} km`;
}

export function fmtElevation(meters) {
  return `${nf0.format(Math.round(meters))} m`;
}

export function fmtDuration(seconds) {
  if (!seconds || seconds <= 0) return "–";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")} h` : `${m} min`;
}

export function fmtSpeed(kmh) {
  if (!kmh || kmh <= 0) return "–";
  return `${nf1.format(kmh)} km/h`;
}

const dateFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium" });

export function fmtDate(msOrNull) {
  if (msOrNull == null) return "Kein Datum";
  return dateFmt.format(new Date(msOrNull));
}

const dateShortFmt = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "short" });
const dateLongFmt = new Intl.DateTimeFormat("de-DE", {
  weekday: "long", day: "numeric", month: "long", year: "numeric",
});

/** "So., 14. Sept." – for rows grouped under a year heading. */
export function fmtDateShort(msOrNull) {
  if (msOrNull == null) return "ohne Datum";
  return dateShortFmt.format(new Date(msOrNull));
}

/** "Sonntag, 14. September 2025" */
export function fmtDateLong(msOrNull) {
  if (msOrNull == null) return "ohne Datum";
  return dateLongFmt.format(new Date(msOrNull));
}

export function avgSpeedKmh(tour) {
  if (!tour.movingS || tour.movingS <= 0) return 0;
  return (tour.distanceM / tour.movingS) * 3.6;
}

export function effectiveCategory(tour) {
  const c = tour.categoryUser || tour.category || "unknown";
  return c === "planning" ? "hiking" : c; // migrate legacy value
}

/** Planning is a flag now, not a category. null override = use auto-detection. */
export function effectiveIsPlan(tour) {
  if (tour.isPlanUser === true || tour.isPlanUser === false) return tour.isPlanUser;
  if (tour.isPlan != null) return !!tour.isPlan;
  return (tour.categoryUser || tour.category) === "planning"; // legacy records
}

// Tracking-/mapping-app names that land in <name>/<creator> and say nothing about
// the tour ("My Phone My Guide", "OsmAnd", "Komoot" …).
const APP_NAMES = [
  "my phone my guide", "open gpx tracker", "geo tracker", "gpx tracker",
  "gpx viewer", "guru maps", "track addict", "orux maps", "locus map",
  "ride with gps", "sports tracker", "polar flow", "my tracks",
  "garmin connect", "outdoor active", "maps me", "view ranger",
  "osmand", "komoot", "strava", "runtastic", "runkeeper", "endomondo",
  "outdooractive", "bikemap", "garmin", "alltrails", "gpsies", "wikiloc",
  "wahoo", "viewranger", "mapstogpx",
].sort((a, b) => b.length - a.length);

const APP_NAME_RE = new RegExp(
  "\\b(?:" + APP_NAMES.map((n) => n.replace(/ +/g, "\\s*")).join("|") + ")\\b",
  "gi"
);

/** Strip app-name fragments, keep any real remainder. */
export function stripAppNames(s) {
  return String(s || "")
    .replace(APP_NAME_RE, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+(mit|via|with|per|und|by)\s*$/i, "")
    .replace(/^[\s:.,_|/\-–]+|[\s:.,_|/\-–]+$/g, "")
    .trim();
}

// Cryptic blobs ("30 17#7km55#737m#4h17") or bare app names.
function junkName(s) {
  const t = stripAppNames(String(s || "").trim());
  if (!t) return true;
  if (t.includes("#")) return true;
  return (t.match(/[A-Za-zÀ-ÿ]/g) || []).length < 3;
}

/** Best available display name: manual > generated-from-places > offline base. */
export function effectiveTitle(tour) {
  if (tour.titleUser && tour.titleUser.trim()) return tour.titleUser.trim();
  for (const cand of [tour.titleAuto, tour.title]) {
    if (!cand || junkName(cand)) continue;
    return stripAppNames(cand); // drops a stale "MyPhoneMyGuide: …" prefix too
  }
  return tour.title || tour.fileName || "Tour";
}

/**
 * Display name without the trailing "(6,8 km)" / "(4,3 km · 737 hm)" the
 * generated names carry – used where the stats sit right next to it.
 */
export function shortTitle(tour) {
  const t = effectiveTitle(tour);
  const s = t.replace(/\s*\(\s*[\d.,]+\s*km\b[^)]*\)\s*$/i, "").trim();
  return s || t;
}

export const CATEGORY_LABEL = {
  unknown: "Ohne",
  cycling: "Rad",
  hiking: "Wandern",
};

// Colour per category – used for the list chip and the map lines.
export const CATEGORY_COLOR = {
  unknown: "#8a94a6",
  cycling: "#1f6feb",
  hiking: "#2e9e50",
};

/** Clamp a rating to 0..5 integers. */
export function normRating(r) {
  const n = Math.round(Number(r) || 0);
  return Math.max(0, Math.min(5, n));
}

/** "★★★☆☆" style string for a 0..5 rating. */
export function starString(rating) {
  const r = normRating(rating);
  return "★★★★★".slice(0, r) + "☆☆☆☆☆".slice(0, 5 - r);
}

/** Inline eye / eye-off icon (no emoji). `off` = crossed-out eye. */
export function eyeIconSvg(off) {
  const inner = off
    ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'
    : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}
