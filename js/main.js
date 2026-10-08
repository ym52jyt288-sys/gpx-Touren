import * as db from "./db.js";
import {
  pickFolder,
  restoreFolder,
  ensurePermission,
  forgetFolder,
  useLocalLibrary,
  pickGpxFiles,
} from "./folderAccess.js";
import {
  createLocalFolderHandle,
  importFiles,
  localFileCount,
  removeLocalFiles,
  clearLocalLibrary,
} from "./localFolder.js";
import { scan, watchFolder } from "./indexer.js";
import { emptyFilter } from "./filter.js";
import { resolveRoutePlaces, GEOCODE_VERSION } from "./geocode.js";
import { buildRouteName } from "./analyzer.js";
import { el, clear } from "./dom.js";
import { renderFolderSetup } from "./views/folderSetup.js";
import { renderList } from "./views/list.js";
import { renderMapSearch } from "./views/mapSearch.js";
import { renderSettings } from "./views/settings.js";
import { openDetail } from "./views/detail.js";

const state = {
  tours: [],
  filter: emptyFilter(),
  sort: "dateDesc",
  dirHandle: null,
  folderName: "",
  lastScan: null,
  settings: {
    resolvePlaces: true, // Orte + Land automatisch ab dem ersten Scan
    mapBase: "osm", // gewählte Basiskarte (s. js/mapLayers.js)
    mapOverlays: [], // aktive Overlay-Ids, z. B. ["gps", "hiking"]
    trackPalette: "kraeftig", // Farbschema der Routenlinien (s. js/trackColors.js)
    radiusSearchEnabled: true, // Umkreissuche (Fadenkreuz + Kreis + Steuerung) aktiv
  },
  searchCenter: null,
  searchRadiusKm: 5,
};

const app = {
  state,
  scanStatus: "idle", // idle | scanning | done | error
  view: "list",
  _watcherDispose: null,
  _fallbackRescan: null,
  _detailOpen: false,
  local: useLocalLibrary(), // no persistent folder handle -> imported copies
};

const root = document.getElementById("app");
const statusEl = document.getElementById("status");
const tabsEl = document.getElementById("tabs");
const refreshBtn = document.getElementById("refresh-btn");

// ---------------------------------------------------------------- boot

// Tell the inline watchdog in index.html that the module graph loaded and ran.
try {
  window.__gpxBooted = true;
} catch {
  /* noop */
}

init().catch((err) => {
  console.error(err);
  clear(root).append(
    el("div", { class: "setup-wrap" },
      el("div", { class: "setup-card" },
        el("div", { class: "setup-icon", text: "⚠️" }),
        el("h1", { text: "Fehler beim Start" }),
        el("p", { class: "muted", text: String(err && err.message ? err.message : err) })))
  );
});

async function init() {
  const saved = await db.getMeta("settings");
  if (saved) Object.assign(state.settings, saved);
  const lastScan = await db.getMeta("lastScan");
  if (lastScan) state.lastScan = lastScan;

  state.tours = await db.getAllTours();

  wireShell();

  // Resume the automatic place lookup as soon as the connection is back – no
  // rescan or button press needed.
  window.addEventListener("online", () => {
    armGeocoding();
    if (state.dirHandle && state.settings.resolvePlaces) resolvePlacesInBackground();
  });

  if (app.local) {
    // iPhone/Safari: the app keeps its own copy of the GPX files (localFolder.js).
    state.dirHandle = createLocalFolderHandle();
    state.folderName = state.dirHandle.name;
    if (await localFileCount()) return startApp({ initialScan: true });
    return showFolderSetup("import");
  }

  const restored = await restoreFolder();
  if (!restored) return showFolderSetup("pick");

  state.dirHandle = restored.handle;
  state.folderName = restored.handle.name;

  if (restored.permission === "granted") {
    return startApp({ initialScan: true });
  }
  // permission needs a user gesture to re-grant
  return showFolderSetup("reconnect");
}

// ---------------------------------------------------------------- shell

function wireShell() {
  tabsEl.hidden = false;
  refreshBtn.hidden = false;
  for (const btn of tabsEl.querySelectorAll("button[data-view]")) {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  }
  if (app.local) {
    refreshBtn.textContent = "＋ Importieren";
    refreshBtn.title = "Neue GPX-Dateien importieren";
    refreshBtn.addEventListener("click", () => importAndScan());
  } else {
    refreshBtn.addEventListener("click", () => rescan());
  }
  setShellEnabled(false);
}

function setShellEnabled(on) {
  tabsEl.classList.toggle("disabled", !on);
  refreshBtn.disabled = !on;
  for (const b of tabsEl.querySelectorAll("button")) b.disabled = !on;
}

function setStatus(text, kind = "") {
  statusEl.textContent = text || "";
  statusEl.className = "status " + kind;
}

// ---------------------------------------------------------------- views

function showFolderSetup(mode) {
  setShellEnabled(false);
  setStatus("");
  renderFolderSetup(root, {
    mode,
    folderName: state.folderName,
    onPick: async (opts) => {
      if (mode === "import") {
        // pickGpxFiles must start synchronously inside the click gesture
        const ok = await importAndScan(opts, { fromSetup: true });
        if (!ok) showFolderSetup("import");
        return;
      }
      try {
        if (mode === "reconnect" && state.dirHandle) {
          const ok = await ensurePermission(state.dirHandle);
          if (!ok) {
            renderFolderSetup(root, { mode, folderName: state.folderName, onPick: () => location.reload(), error: "Zugriff verweigert." });
            return;
          }
        } else {
          const handle = await pickFolder();
          state.dirHandle = handle;
          state.folderName = handle.name;
        }
        await startApp({ initialScan: true });
      } catch (err) {
        if (err && err.name === "AbortError") return; // user cancelled
        renderFolderSetup(root, {
          mode,
          folderName: state.folderName,
          onPick: () => location.reload(),
          error: String(err && err.message ? err.message : err),
        });
      }
    },
  });
}

async function startApp({ initialScan }) {
  setShellEnabled(true);
  setView(app.view);
  setupWatching();
  if (initialScan) await rescan();
  else renderActiveView();
  // catch tours from a previous session that never got resolved (rescan already
  // triggers this after a scan; the re-entrancy guard makes a double call a no-op)
  if (state.settings.resolvePlaces && navigator.onLine) {
    armGeocoding();
    resolvePlacesInBackground();
  }
}

function setView(view) {
  app.view = view;
  for (const b of tabsEl.querySelectorAll("button[data-view]")) {
    b.classList.toggle("active", b.dataset.view === view);
  }
  renderActiveView();
}

function renderActiveView() {
  if (!state.dirHandle) return;
  const ctx = buildCtx();
  clear(root);
  if (app.view === "map") renderMapSearch(root, ctx);
  else if (app.view === "settings") renderSettings(root, ctx);
  else renderList(root, ctx);
}

function buildCtx() {
  return {
    state,
    scanStatus: app.scanStatus,
    dirHandle: state.dirHandle,
    openDetail: (fileName) => {
      app._detailOpen = true;
      openDetail(buildCtx(), fileName);
    },
    closeDetail: () => {
      app._detailOpen = false;
    },
    refreshTours: async () => {
      state.tours = await db.getAllTours();
      renderActiveView();
    },
    saveTour: (tour) => db.putTour(tour),
    saveSettings: async () => {
      await db.setMeta("settings", state.settings);
      // turning the automatic lookup back on should start it right away
      if (state.settings.resolvePlaces && navigator.onLine) {
        armGeocoding();
        resolvePlacesInBackground();
      }
    },
    unhideAll: async () => {
      for (const t of state.tours.filter((t) => t.hidden)) {
        t.hidden = false;
        await db.putTour(t);
      }
      state.tours = await db.getAllTours();
      renderActiveView();
    },
    rescan,
    resetIndex: async () => {
      await db.clearTours();
      state.tours = [];
      await rescan();
    },
    local: app.local,
    importFiles: () => importAndScan(),
    deleteTour: async (fileName) => {
      await removeLocalFiles([fileName]);
      await db.deleteTours([fileName]);
      state.tours = await db.getAllTours();
      renderActiveView();
    },
    clearLibrary: async () => {
      await clearLocalLibrary();
      await db.clearTours();
      state.tours = [];
      showFolderSetup("import");
    },
    changeFolder: async () => {
      teardownWatching();
      await forgetFolder();
      state.dirHandle = null;
      state.tours = [];
      showFolderSetup("pick");
    },
  };
}

// ---------------------------------------------------------------- import (local library)

/**
 * Pick GPX files, copy them into the local library and index them.
 * Called straight from a click handler – the picker opens before the first await.
 * @returns {Promise<boolean>} whether anything ended up in the library
 */
async function importAndScan(pickOpts = {}, { fromSetup = false } = {}) {
  const files = await pickGpxFiles(pickOpts);
  if (!files.length) return (await localFileCount()) > 0;

  setStatus(`Importiere ${files.length} Dateien…`, "busy");
  let stats;
  try {
    stats = await importFiles(files);
  } catch (err) {
    console.error(err);
    setStatus("Import fehlgeschlagen: " + (err && err.message ? err.message : err), "error");
    return false;
  }
  // keep the copies when Safari tidies up storage (home-screen apps are exempt anyway)
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* noop */
  }
  if (!stats.added && !stats.replaced) {
    setStatus(stats.skipped ? `Keine neuen Dateien (${stats.skipped} schon vorhanden)` : "Keine GPX-Dateien ausgewählt", "warn");
    setTimeout(() => setStatus(""), 4000);
    const have = (await localFileCount()) > 0;
    if (have && fromSetup) await startApp({ initialScan: true });
    return have;
  }
  if (fromSetup) await startApp({ initialScan: true });
  else await rescan();
  return true;
}

// ---------------------------------------------------------------- scanning

let scanning = false;

async function rescan() {
  if (scanning || !state.dirHandle) return;
  scanning = true;
  app.scanStatus = "scanning";
  setShellEnabled(true);
  refreshBtn.disabled = true;
  setStatus("Indexiere… 0", "busy");

  try {
    const stats = await scan(state.dirHandle, {
      onProgress: (done, total) => setStatus(`Indexiere… ${done}/${total}`, "busy"),
      onError: (name, msg) => console.warn("GPX übersprungen:", name, msg),
    });

    state.tours = await db.getAllTours();
    await backfillAutoTitles();
    state.lastScan = Date.now();
    await db.setMeta("lastScan", state.lastScan);
    app.scanStatus = "done";

    const changed = stats.added + stats.updated + stats.removed;
    setStatus(
      changed
        ? `Aktualisiert: +${stats.added} / ~${stats.updated} / −${stats.removed}` +
            (stats.failed ? ` · ${stats.failed} übersprungen` : "")
        : `${state.tours.length} Touren · aktuell`,
      stats.failed ? "warn" : "ok"
    );
    setTimeout(() => {
      // don't wipe the "Orte werden ermittelt…" progress that may now be running
      if (app.scanStatus === "done" && !geocoding) setStatus("");
    }, 4000);

    renderActiveView();

    armGeocoding();
    if (state.settings.resolvePlaces && navigator.onLine) resolvePlacesInBackground();
  } catch (err) {
    console.error(err);
    app.scanStatus = "error";
    setStatus("Indexierung fehlgeschlagen: " + (err && err.message ? err.message : err), "error");
  } finally {
    scanning = false;
    refreshBtn.disabled = false;
  }
}

/**
 * (Re)build the readable route name from places that are already stored – no
 * network. Prefers the ranked list (biggest places win); falls back to the plain
 * name list for tours geocoded before ranking existed.
 */
async function backfillAutoTitles() {
  let changed = false;
  for (const tour of state.tours) {
    if (tour.titleUser) continue;
    const src =
      (tour.placesRanked && tour.placesRanked.length && tour.placesRanked) ||
      tour.placeNames ||
      [];
    const name = buildRouteName(tour, src);
    if (name && name !== tour.titleAuto) {
      tour.titleAuto = name;
      await db.putTour(tour);
      changed = true;
    }
  }
  if (changed) state.tours = await db.getAllTours();
}

/**
 * Tours still needing a lookup: never resolved, resolved by an older geocoder, or
 * resolved but nothing usable came out (those end up called just "Tour" – retry so
 * the nearby-town fallback can name them).
 */
function needsGeocoding(t) {
  if (t.hidden) return false;
  if (!t.placesResolved || (t.geoV || 0) < GEOCODE_VERSION) return true;
  const hasPlaces = (t.placesRanked || []).length || (t.placeNames || []).length;
  return !hasPlaces && !t.nearPlace && !t.region && !t.summitName;
}

function applyResolvedPlaces(tour, r) {
  tour.placeNames = r.places;
  tour.placesRanked = r.placesRanked || [];
  tour.region = r.region || "";
  tour.nearPlace = r.nearPlace || "";
  tour.country = r.country || "";
  tour.countryCode = r.countryCode || "";
  if (r.summit && r.summit.name) {
    tour.summitName = r.summit.name;
    if (r.summit.ele) tour.summitEle = Math.round(r.summit.ele);
  }
  tour.titleAuto = buildRouteName(tour, r.placesRanked) || tour.titleAuto || null;
  tour.placesResolved = true;
  tour.geoV = GEOCODE_VERSION;
}

let geocoding = false;
let geocodeRetryTimer = null;
// Bounds the leftover-retry cycle (rate limit / a handful of remote tours with no
// data nearby) so it can't poll forever. Reset by a scan, an `online` event, or
// re-enabling the setting – i.e. whenever there's a real reason to try again.
let geocodeRetriesLeft = 0;
const GEOCODE_MAX_RETRIES = 8;

function armGeocoding() {
  geocodeRetriesLeft = GEOCODE_MAX_RETRIES;
}

function scheduleGeocodeRetry(ms) {
  clearTimeout(geocodeRetryTimer);
  geocodeRetryTimer = setTimeout(() => {
    if (state.dirHandle && state.settings.resolvePlaces && navigator.onLine) {
      resolvePlacesInBackground();
    }
  }, ms);
}

/**
 * Resolve "places along the route" for every tour that still needs it and keep
 * going until none are left – so names appear on their own, without anyone
 * pressing "Orte neu ermitteln". One tour at a time; geocode.js throttles the
 * actual requests to ~1/s, so one run works through the whole backlog (a large
 * first library takes a while). Each tour is attempted once per run; a transient
 * wave of failures (rate limit, Overpass timeout, brief offline) ends the run
 * early and a bounded retry timer picks it up again. Re-entrancy-guarded.
 */
async function resolvePlacesInBackground() {
  if (geocoding) return;
  if (!state.settings.resolvePlaces || !navigator.onLine || !state.dirHandle) return;
  geocoding = true;
  clearTimeout(geocodeRetryTimer);

  const tried = new Set();
  let done = 0;
  let fails = 0;
  let bailed = false;
  let showedProgress = false;
  try {
    while (state.settings.resolvePlaces && navigator.onLine) {
      const tour = state.tours.find(
        (t) => needsGeocoding(t) && !tried.has(t.fileName)
      );
      if (!tour) break;
      tried.add(tour.fileName); // one shot per run, resolvable or not

      if (app.scanStatus !== "scanning") {
        const open = state.tours.filter(needsGeocoding).length;
        setStatus(`Orte werden ermittelt… (${open} offen)`, "busy");
        showedProgress = true;
      }

      try {
        const r = await resolveRoutePlaces(tour.polyline, 10, {
          summitCoord: tour.isSummitTour ? tour.summitCoord : null,
        });
        applyResolvedPlaces(tour, r);
        await db.putTour(tour);
        fails = 0;
        // refresh the list now and then so names show up as they arrive
        if (++done % 8 === 0 && !app._detailOpen && app.view === "list") {
          await backfillAutoTitles();
          renderActiveView();
        }
      } catch {
        if (++fails >= 5) {
          bailed = true;
          break; // systemic: offline / hard rate limit – let the timer retry
        }
        await new Promise((res) => setTimeout(res, 3000 * fails));
      }
    }
  } finally {
    geocoding = false;
    state.tours = await db.getAllTours();
    await backfillAutoTitles();
    // don't rebuild the map view from under the user (it would reset pan/zoom);
    // the list is where the names show anyway. Map picks them up on next nav.
    if (!app._detailOpen && app.view === "list") renderActiveView();

    if (app.scanStatus !== "scanning") {
      const open = state.tours.filter(needsGeocoding).length;
      // retry only when there's a point to it: we bailed on a failure wave, or
      // fresh tours turned up mid-run. Un-resolvable leftovers just wait for the
      // next scan / restart / reconnect.
      const untriedLeft = state.tours.some(
        (t) => needsGeocoding(t) && !tried.has(t.fileName)
      );
      if (open && (bailed || untriedLeft) && geocodeRetriesLeft > 0) {
        geocodeRetriesLeft--;
        setStatus(`Orte: ${open} noch offen`, "");
        scheduleGeocodeRetry(45000);
      } else if (!open && done) {
        setStatus("Orte vollständig ermittelt", "ok");
        setTimeout(() => setStatus(""), 4000);
      } else if (showedProgress) {
        // leftovers we can't resolve right now (no data nearby, or retry budget
        // spent) – don't leave the "…wird ermittelt" spinner hanging
        setStatus(open ? `Orte: ${open} offen` : "", "");
      }
    }
  }
}

// ---------------------------------------------------------------- watching

function setupWatching() {
  teardownWatching();
  if (!state.dirHandle || app.local) return; // local library changes only via import

  app._watcherDispose = watchFolder(state.dirHandle, () => {
    clearTimeout(app._watchDebounce);
    app._watchDebounce = setTimeout(() => rescan(), 1500);
  });

  if (!app._watcherDispose) {
    // Fallback: rescan when the window regains focus.
    app._fallbackRescan = () => {
      if (document.visibilityState === "visible") rescan();
    };
    window.addEventListener("focus", app._fallbackRescan);
    document.addEventListener("visibilitychange", app._fallbackRescan);
  }
}

function teardownWatching() {
  if (app._watcherDispose) {
    app._watcherDispose();
    app._watcherDispose = null;
  }
  if (app._fallbackRescan) {
    window.removeEventListener("focus", app._fallbackRescan);
    document.removeEventListener("visibilitychange", app._fallbackRescan);
    app._fallbackRescan = null;
  }
}
