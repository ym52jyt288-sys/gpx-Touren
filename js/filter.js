// In-memory filtering + sorting of the tour list.

import {
  effectiveCategory,
  effectiveIsPlan,
  effectiveTitle,
  normRating,
} from "./format.js";

export function emptyFilter() {
  return {
    text: "",
    categories: new Set(), // effective categories to include (cycling|hiking|unknown)
    plan: "", // "" all | "only" only plans | "exclude" hide plans
    country: "", // exact country match, "" = all
    minRating: 0, // 0 = off, else require >= N stars
    showHidden: false, // include tours the user has hidden
    range: "", // quick range key ("", "3m", "12m", "36m", "60m")
    dateFrom: null, // ms
    dateTo: null, // ms
    minKm: null,
    maxKm: null,
    minAscent: null,
    maxAscent: null,
  };
}

export function filterIsActive(f) {
  return (
    f.categories.size > 0 ||
    !!f.plan ||
    !!f.country ||
    !!f.showHidden ||
    (f.minRating || 0) > 0 ||
    f.dateFrom != null ||
    f.dateTo != null ||
    f.minKm != null ||
    f.maxKm != null ||
    f.minAscent != null ||
    f.maxAscent != null
  );
}

/** Number of active criteria groups (the search text not counted). */
export function activeFilterCount(f) {
  let n = 0;
  if (f.categories.size) n++;
  if (f.plan) n++;
  if (f.country) n++;
  if (f.showHidden) n++;
  if ((f.minRating || 0) > 0) n++;
  if (f.dateFrom != null || f.dateTo != null) n++;
  if (f.minKm != null || f.maxKm != null) n++;
  if (f.minAscent != null || f.maxAscent != null) n++;
  return n;
}

/** Clear every criterion in place (keeps the object, and by default the search text). */
export function resetFilter(f, { keepText = true } = {}) {
  const text = f.text;
  Object.assign(f, emptyFilter());
  if (keepText) f.text = text;
  return f;
}

/**
 * Split an already sorted list into consecutive year groups with sums – the
 * section headings of the mobile list ("2025 · 23 Touren · 412 km").
 */
export function groupToursByYear(tours) {
  const groups = [];
  let cur = null;
  for (const t of tours) {
    const year = t.tourDate == null ? null : new Date(t.tourDate).getFullYear();
    if (!cur || cur.year !== year) {
      cur = { year, tours: [], distanceM: 0, ascentM: 0 };
      groups.push(cur);
    }
    cur.tours.push(t);
    cur.distanceM += t.distanceM || 0;
    cur.ascentM += t.ascentM || 0;
  }
  return groups;
}

/** Quick date ranges. Returns {dateFrom, dateTo} in ms (dateTo null = now). */
export const QUICK_RANGES = {
  "": { label: "gesamter Zeitraum" },
  "3m": { label: "letzte 3 Monate", months: 3 },
  "12m": { label: "letzte 12 Monate", months: 12 },
  "36m": { label: "letzte 3 Jahre", months: 36 },
  "60m": { label: "letzte 5 Jahre", months: 60 },
};

export function rangeToDates(key) {
  const r = QUICK_RANGES[key];
  if (!r || !r.months) return { dateFrom: null, dateTo: null };
  const from = new Date();
  from.setMonth(from.getMonth() - r.months);
  from.setHours(0, 0, 0, 0);
  return { dateFrom: from.getTime(), dateTo: null };
}

export function matchesFilter(tour, f) {
  if (tour.hidden && !f.showHidden) return false;

  const query = f.text.trim().toLowerCase();
  if (query) {
    const hay = `${effectiveTitle(tour)} ${tour.fileName} ${(tour.placeNames || []).join(
      " "
    )} ${tour.country || ""} ${tour.countryCode || ""}`.toLowerCase();
    if (!hay.includes(query)) return false;
  }

  if (f.categories.size && !f.categories.has(effectiveCategory(tour))) return false;

  const plan = effectiveIsPlan(tour);
  if (f.plan === "only" && !plan) return false;
  if (f.plan === "exclude" && plan) return false;

  if (f.country && (tour.country || "") !== f.country) return false;
  if ((f.minRating || 0) > 0 && normRating(tour.rating) < f.minRating) return false;

  if (f.dateFrom != null || f.dateTo != null) {
    if (tour.tourDate == null) return false;
    if (f.dateFrom != null && tour.tourDate < f.dateFrom) return false;
    if (f.dateTo != null && tour.tourDate > f.dateTo) return false;
  }

  const km = tour.distanceM / 1000;
  if (f.minKm != null && km < f.minKm) return false;
  if (f.maxKm != null && km > f.maxKm) return false;

  if (f.minAscent != null && tour.ascentM < f.minAscent) return false;
  if (f.maxAscent != null && tour.ascentM > f.maxAscent) return false;

  return true;
}

export const SORTS = {
  dateDesc: { label: "Datum (neu zuerst)", short: "Neueste", cmp: (a, b) => (b.tourDate ?? -Infinity) - (a.tourDate ?? -Infinity) },
  dateAsc: { label: "Datum (alt zuerst)", short: "Älteste", cmp: (a, b) => (a.tourDate ?? Infinity) - (b.tourDate ?? Infinity) },
  distDesc: { label: "Distanz (lang zuerst)", short: "Längste", cmp: (a, b) => b.distanceM - a.distanceM },
  distAsc: { label: "Distanz (kurz zuerst)", short: "Kürzeste", cmp: (a, b) => a.distanceM - b.distanceM },
  nameAsc: {
    label: "Name (A–Z)",
    short: "A–Z",
    cmp: (a, b) => effectiveTitle(a).localeCompare(effectiveTitle(b), "de"),
  },
  ratingDesc: {
    label: "Bewertung (hoch zuerst)",
    short: "Beste",
    cmp: (a, b) =>
      normRating(b.rating) - normRating(a.rating) ||
      (b.tourDate ?? -Infinity) - (a.tourDate ?? -Infinity),
  },
};

export function sortTours(list, key) {
  const s = SORTS[key] || SORTS.dateDesc;
  return list.slice().sort(s.cmp);
}
