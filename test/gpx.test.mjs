// Node smoke test for the framework-free core (no browser needed):
//   node test/gpx.test.mjs
// Parses every GPX in ../SampleData and prints the derived metrics, with a few asserts.

import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

import { parseGpxText } from "../js/gpx.js";
import { analyzeGpx } from "../js/analyzer.js";
import { douglasPeucker, haversine } from "../js/geo.js";
import { mergePreserving, nfc } from "../js/indexer.js";
import { toProfileSamples, createElevationChart } from "../js/chart.js";
import { fmtDistance, fmtElevation, fmtTotalDistance, shortTitle } from "../js/format.js";
import { emptyFilter, activeFilterCount, resetFilter, groupToursByYear } from "../js/filter.js";
import { segDistPx, toursNearPoint } from "../js/spatial.js";
import {
  lngToTileX,
  latToTileY,
  countTiles,
  iterTiles,
  estimateBytes,
  orphanKeysForRegion,
} from "../js/offlineTiles.js";

const here = dirname(fileURLToPath(import.meta.url));
const sampleDir = join(here, "..", "SampleData");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

// --- unit-ish checks --------------------------------------------------------

console.log("geo:");
check("haversine ~111 km per degree of latitude", () => {
  const d = haversine({ lat: 47, lon: 11 }, { lat: 48, lon: 11 });
  assert.ok(Math.abs(d - 111195) < 2000, `got ${d}`);
});
check("douglasPeucker keeps endpoints and reduces a straight line to 2 points", () => {
  const line = Array.from({ length: 50 }, (_, i) => ({ lat: 47 + i * 0.001, lon: 11 }));
  const out = douglasPeucker(line, 5);
  assert.equal(out.length, 2);
});

// --- sample files ---------------------------------------------------------

console.log("\nsamples:");
let files = [];
try {
  files = (await readdir(sampleDir)).filter((f) => f.toLowerCase().endsWith(".gpx"));
} catch {
  console.log(`  (kein Ordner ${sampleDir} – übersprungen)`);
}

for (const name of files) {
  const full = join(sampleDir, name);
  const text = await readFile(full, "utf8");
  const info = await stat(full);

  const parsed = parseGpxText(text);
  const draft = analyzeGpx(text, {
    fileName: name,
    size: info.size,
    lastModified: Math.round(info.mtimeMs),
  });

  console.log(
    `  ${name}\n` +
      `    Punkte ${parsed.points.length}, Distanz ${(draft.distanceM / 1000).toFixed(2)} km, ` +
      `↑ ${Math.round(draft.ascentM)} m / ↓ ${Math.round(draft.descentM)} m, ` +
      `Dauer ${(draft.totalS / 60).toFixed(0)} min, Kategorie ${draft.category}, ` +
      `Planung ${draft.isPlan}, Titel "${draft.title}", Polyline ${draft.polyline.length} Pkt`
  );

  check(`${name}: plausible Werte`, () => {
    assert.ok(parsed.points.length >= 2, "zu wenige Punkte");
    assert.ok(draft.distanceM > 0, "Distanz 0");
    assert.ok(draft.polyline.length >= 2 && draft.polyline.length <= 200, "Polyline-Budget verletzt");
    assert.ok(draft.bbox.minLat <= draft.bbox.maxLat && draft.bbox.minLon <= draft.bbox.maxLon, "bbox kaputt");
    assert.ok(["cycling", "hiking", "unknown"].includes(draft.category), "unerwartete Kategorie");
    assert.equal(typeof draft.isPlan, "boolean", "isPlan fehlt");
    assert.ok(/\(\d/.test(draft.title) || draft.title.length > 3, "Titel unbrauchbar");
    assert.ok(!/#/.test(draft.title), "kryptischer Name (#) im Titel");
    assert.ok(!/#/.test(String(draft.titleLabel || "")), "kryptischer Name als Label übernommen");
    assert.ok(!/my phone my guide/i.test(draft.title), "App-Name im Titel");
    assert.ok(!/my phone my guide/i.test(String(draft.titleLabel || "")), "App-Name als Label übernommen");
  });
}

// --- indexer: a re-parse must not lose user edits / geocoding -------------

console.log("\nindexer preservation:");
check("mergePreserving keeps hidden / plan / places / rating / notes / manual title", () => {
  const stored = {
    fileName: "Tour.gpx", size: 100, signature: "100-1", av: 7,
    titleUser: "Hausrunde", titleAuto: "A–B (5 km)", categoryUser: "cycling",
    isPlanUser: true, rating: 4, hidden: true, notes: "matschig",
    placeNames: ["A", "B"], placesRanked: [{ name: "A", rank: 6, pos: 0, hits: 2 }],
    region: "Kreis X", nearPlace: "B", country: "Deutschland", countryCode: "DE",
    placesResolved: true, geoV: 3, futureField: "keep",
  };
  const fresh = {
    fileName: "Tour.gpx", size: 100, signature: "100-2", av: 7,
    title: "Rundtour (5 km)", titleAuto: null, titleUser: null, categoryUser: null,
    isPlan: false, isPlanUser: null, isSummitTour: false, summitName: null,
    rating: 0, hidden: false, notes: "", placeNames: [], placesRanked: [],
    region: "", nearPlace: "", country: "", countryCode: "",
    placesResolved: false, geoV: 0, distanceM: 5000,
  };
  const m = mergePreserving(stored, fresh);
  assert.equal(m.hidden, true, "hidden");
  assert.equal(m.isPlanUser, true, "isPlanUser");
  assert.equal(m.titleUser, "Hausrunde", "titleUser");
  assert.equal(m.rating, 4, "rating");
  assert.equal(m.notes, "matschig", "notes");
  assert.deepEqual(m.placeNames, ["A", "B"], "placeNames");
  assert.equal(m.placesResolved, true, "placesResolved");
  assert.equal(m.geoV, 3, "geoV");
  assert.equal(m.futureField, "keep", "unknown field survives");
  assert.equal(m.distanceM, 5000, "metrics from the fresh parse");
});
check("mergePreserving migrates legacy planning category + isFavorite", () => {
  const base = { fileName: "T.gpx", placeNames: [], placesRanked: [] };
  const fresh = { fileName: "T.gpx", isPlan: false, isPlanUser: null, isSummitTour: false };
  const a = mergePreserving({ ...base, categoryUser: "planning" }, fresh);
  assert.equal(a.isPlanUser, true, "planning -> isPlanUser");
  assert.equal(a.categoryUser, null, "planning category cleared");
  const b = mergePreserving({ ...base, isFavorite: true }, fresh);
  assert.equal(b.rating, 5, "isFavorite -> 5");
});
check("nfc() makes the NFC and NFD spellings of an umlaut name match", () => {
  const name = "Grünwald.gpx";
  assert.notEqual(name.normalize("NFC"), name.normalize("NFD"));
  assert.equal(nfc(name.normalize("NFC")), nfc(name.normalize("NFD")));
});

// --- chart: profile samples (distance + elapsed time + coords) -----------

console.log("\nchart profile:");
check("toProfileSamples: cumulative distance, elapsed seconds, coords", () => {
  const base = Date.UTC(2026, 0, 1, 8, 0, 0);
  const pts = [
    { lat: 47.0, lon: 11.0, ele: 600, time: base },
    { lat: 47.01, lon: 11.0, ele: 640, time: base + 600_000 }, // +10 min
    { lat: 47.02, lon: 11.0, ele: 700, time: base + 1_800_000 }, // +30 min
  ];
  const s = toProfileSamples(pts);
  assert.equal(s.length, 3);
  assert.equal(s[0].d, 0, "starts at distance 0");
  assert.ok(s[1].d > 1000 && s[1].d < 1200, `~1.11 km, got ${s[1].d}`);
  assert.ok(s[2].d > s[1].d, "distance is cumulative");
  assert.equal(s[0].t, 0, "elapsed starts at 0");
  assert.equal(s[1].t, 600, "elapsed in seconds");
  assert.equal(s[2].t, 1800);
  assert.equal(s[2].ele, 700);
  assert.equal(s[2].lat, 47.02, "coordinate carried through");
});
check("toProfileSamples: no timestamps -> t null but geometry intact", () => {
  const pts = [
    { lat: 47, lon: 11, ele: 600, time: null },
    { lat: 47, lon: 11.02, ele: 610, time: null },
  ];
  const s = toProfileSamples(pts);
  assert.equal(s.length, 2);
  assert.equal(s[0].t, null);
  assert.ok(s[1].d > 1000, "distance still computed for a planned route");
});
check("toProfileSamples: down-samples to the target, keeps first & last", () => {
  const pts = Array.from({ length: 5000 }, (_, i) => ({
    lat: 47 + i * 1e-4, lon: 11, ele: 600 + (i % 50), time: null,
  }));
  const s = toProfileSamples(pts, 400);
  assert.equal(s.length, 400);
  assert.equal(s[0].d, 0);
  assert.ok(s[399].d > s[398].d);
});

check("createElevationChart: cursorAtDistance snaps to the nearest sample", () => {
  // minimal browser stubs – rAF is a no-op so the canvas is never actually drawn
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  const canvas = {
    clientWidth: 600, clientHeight: 200, width: 0, height: 0,
    getContext: () => ({}),
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    addEventListener() {}, removeEventListener() {},
  };
  const hits = [];
  const chart = createElevationChart(canvas, { onHover: (s) => hits.push(s) });
  chart.setData([
    { d: 0, ele: 100, t: 0, lat: 47, lon: 11 },
    { d: 1000, ele: 150, t: 300, lat: 47.01, lon: 11 },
    { d: 2000, ele: 120, t: 600, lat: 47.02, lon: 11 },
  ]);
  chart.cursorAtDistance(1100);
  assert.equal(hits.at(-1).d, 1000, "1100 m -> the 1000 m sample");
  chart.cursorAtDistance(1150);
  assert.equal(hits.length, 1, "same nearest sample -> no repeat onHover");
  chart.cursorAtDistance(1900);
  assert.equal(hits.at(-1).d, 2000, "1900 m -> the 2000 m sample");
  chart.cursorAtDistance(null);
  assert.equal(hits.at(-1), null, "null clears the cursor");
  chart.destroy();
});

console.log("\noffline tiles:");
check("slippy math: unambiguous quadrant boundaries", () => {
  assert.equal(lngToTileX(-180, 0), 0);
  // z1: two columns / two rows split at the prime meridian / equator
  assert.equal(lngToTileX(-90, 1), 0);
  assert.equal(lngToTileX(90, 1), 1);
  assert.equal(latToTileY(45, 1), 0); // northern hemisphere = top row
  assert.equal(latToTileY(-45, 1), 1);
  // z2: four columns west->east
  assert.deepEqual(
    [-135, -45, 45, 135].map((lng) => lngToTileX(lng, 2)),
    [0, 1, 2, 3]
  );
  // monotonic in longitude
  assert.ok(lngToTileX(10, 12) < lngToTileX(11, 12));
  assert.ok(latToTileY(48, 12) < latToTileY(47, 12)); // further north = smaller y
});
check("countTiles matches iterTiles and grows ~4x per zoom", () => {
  const b = { north: 47.5, south: 47.3, east: 11.5, west: 11.2 };
  let n = 0;
  for (const _ of iterTiles(b, 12, 14)) n++;
  assert.equal(n, countTiles(b, 12, 14), "count vs iterate");
  const z12 = countTiles(b, 12, 12);
  const z13 = countTiles(b, 13, 13);
  assert.ok(z13 >= z12 * 3 && z13 <= z12 * 5, `z13 ${z13} vs z12 ${z12}`);
});
check("estimateBytes scales with tile count and layer", () => {
  assert.equal(estimateBytes("osm", 0), 0);
  assert.ok(estimateBytes("topo", 100) > estimateBytes("osm", 100));
});
check("orphanKeysForRegion keeps tiles still covered by another region", () => {
  const b = { north: 47.5, south: 47.3, east: 11.5, west: 11.2 };
  const a = { id: "osm:a", layerId: "osm", bounds: b, minZoom: 12, maxZoom: 13 };
  const all = countTiles(b, 12, 13);
  // no other region -> every tile is an orphan (safe to delete)
  assert.equal(orphanKeysForRegion(a, [a]).length, all);
  // an overlapping region of the SAME layer protects the shared tiles
  const overlap = {
    id: "osm:b", layerId: "osm", minZoom: 12, maxZoom: 13,
    bounds: { north: 47.45, south: 47.35, east: 11.45, west: 11.25 },
  };
  assert.ok(orphanKeysForRegion(a, [a, overlap]).length < all);
  // a region on a DIFFERENT layer must not protect anything
  const otherLayer = { ...overlap, id: "topo:b", layerId: "topo" };
  assert.equal(orphanKeysForRegion(a, [a, otherLayer]).length, all);
});
check("orphan keys carry the layer id prefix", () => {
  const b = { north: 47.5, south: 47.49, east: 11.5, west: 11.49 };
  const a = { id: "sat:a", layerId: "sat", bounds: b, minZoom: 10, maxZoom: 10 };
  for (const k of orphanKeysForRegion(a, [a])) {
    assert.match(k, /^sat\/10\/\d+\/\d+$/);
  }
});

// --- mobile UI helpers ------------------------------------------------------

console.log("\nmobile helpers:");
check("German number format in distances / elevations / speeds", () => {
  assert.equal(fmtDistance(6800), "6,8 km");
  assert.equal(fmtDistance(950), "950 m");
  assert.equal(fmtElevation(1838.4), "1.838 m");
  assert.equal(fmtTotalDistance(1234567), "1.235 km");
});
check("shortTitle drops the trailing distance, keeps real names", () => {
  assert.equal(shortTitle({ titleAuto: "Kufstein – Pendling (6,8 km)" }), "Kufstein – Pendling");
  assert.equal(shortTitle({ title: "Rundtour (4,3 km · 737 hm)" }), "Rundtour");
  assert.equal(shortTitle({ titleUser: "Abendrunde" }), "Abendrunde");
  // nothing left after stripping -> keep the full name
  assert.equal(shortTitle({ titleUser: "(12 km)" }), "(12 km)");
});
check("activeFilterCount / resetFilter", () => {
  const f = emptyFilter();
  assert.equal(activeFilterCount(f), 0);
  f.categories.add("cycling");
  f.plan = "only";
  f.minKm = 10;
  f.maxKm = 50; // same group as minKm
  f.text = "inn"; // text is not a filter criterion
  assert.equal(activeFilterCount(f), 3);
  resetFilter(f);
  assert.equal(activeFilterCount(f), 0);
  assert.equal(f.text, "inn", "keeps the search text by default");
  resetFilter(f, { keepText: false });
  assert.equal(f.text, "");
});
check("groupToursByYear keeps sort order and sums per year", () => {
  const d = (y, m) => new Date(y, m, 1).getTime();
  const g = groupToursByYear([
    { tourDate: d(2025, 5), distanceM: 1000, ascentM: 10 },
    { tourDate: d(2025, 1), distanceM: 2000, ascentM: 20 },
    { tourDate: d(2023, 8), distanceM: 500, ascentM: 5 },
    { tourDate: null, distanceM: 100, ascentM: 1 },
  ]);
  assert.deepEqual(g.map((x) => x.year), [2025, 2023, null]);
  assert.equal(g[0].tours.length, 2);
  assert.equal(g[0].distanceM, 3000);
  assert.equal(g[0].ascentM, 30);
});
check("segDistPx: perpendicular, beyond the ends, degenerate segment", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 10, y: 0 };
  assert.equal(segDistPx({ x: 5, y: 3 }, a, b), 3);
  assert.equal(segDistPx({ x: 13, y: 4 }, a, b), 5);
  assert.equal(segDistPx({ x: 3, y: 4 }, a, a), 5);
});
check("toursNearPoint returns every overlapping track, nearest first", () => {
  // identity projection: lat -> y, lon -> x
  const project = ([lat, lon]) => ({ x: lon, y: lat });
  const t1 = { fileName: "a", bbox: { minLat: 0, maxLat: 0, minLon: 0, maxLon: 100 }, polyline: [[0, 0], [0, 100]] };
  const t2 = { fileName: "b", bbox: { minLat: 5, maxLat: 5, minLon: 0, maxLon: 100 }, polyline: [[5, 0], [5, 100]] };
  const t3 = { fileName: "c", bbox: { minLat: 80, maxLat: 80, minLon: 0, maxLon: 100 }, polyline: [[80, 0], [80, 100]] };
  const hits = toursNearPoint([t3, t1, t2], { x: 50, y: 4 }, project, 18);
  assert.deepEqual(hits.map((t) => t.fileName), ["b", "a"]);
  // the lat/lon prefilter box excludes tracks outside it
  const box = { minLat: 3, maxLat: 7, minLon: 40, maxLon: 60 };
  assert.deepEqual(toursNearPoint([t1, t2], { x: 50, y: 4 }, project, 18, box).map((t) => t.fileName), ["b"]);
});

console.log(failures ? `\n${failures} Fehler.` : "\nAlles OK.");
process.exit(failures ? 1 : 0);
