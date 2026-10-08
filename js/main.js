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
import { renderMobileList } from "./views/mobileList.js";
import { renderMobileMap } from "./views/mobileMap.js";
import { renderSettings } from "./views/settings.js";
import { openDetail } from "./views/detail.js";
import { icon } from "./icons.js";

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
    mobileUi: true, // eigene Handy-Oberfläche auf schmalen Touch-Bildschirmen
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
  scrollPos: {}, // per view, restored when switching tabs
};

const root = document.getElementById("app");
const statusEl = document.getElementById("status");
const tabsEl = document.getElementById("tabs");
const refreshBtn = document.getElementById("refresh-btn");
const headerEl = document.querySelector(".app-header");
const headerRight = document.querySelector(".header-right");
const viewTitleEl = document.getElementById("view-title");

// Phones (portrait, or landscape with little height) get their own layout:
// bottom tab bar, full-screen map and detail page, sheets instead of panels.
const mobileMq = window.matchMedia("(max-width: 720px), (pointer: coarse) and (max-height: 520px)");
const VIEW_TITLES = { list: "Touren", map: "Karte", settings: "Einstellungen" };

function isMobile() {
  return mobileMq.matches && state.settings.mobileUi !== false;
}

function applyLayoutMode() {
  const mobile = isMobile();
  document.body.classList.toggle("mobile", mobile);
  // the tab bar lives in the header on desktop and at the bottom on phones
  if (mobile) {
    if (tabsEl.parentElement !== document.body) document.body.append(tabsEl);
  } else if (tabsEl.parentElement !== headerEl) {
    headerEl.insertBefore(tabsEl, headerRight);
  }
}

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

  applyLayoutMode();
  mobileMq.addEventListener?.("change", () => {
    applyLayoutMode();
    renderActiveView();
  });
  // iOS only shows :active feedback when a touch listener exists
  document.addEventListener("touchstart", () => {}, { passive: true });

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
  const TAB_ICONS = { list: "route", map: "map", settings: "settings" };
  for (const btn of tabsEl.querySelectorAll("button[data-view]")) {
    // desktop shows the text tabs; phones an icon tab bar with short labels
    const v = btn.dataset.view;
    btn.innerHTML =
      icon(TAB_ICONS[v], 24) +
      `<span class="lbl-d">${btn.textContent.trim()}</span><span class="lbl-m">${VIEW_TITLES[v]}</span>`;
    btn.addEventListener("click", () => {
      // tapping the active tab again scrolls back to the top (as native apps do)
      if (btn.dataset.view === app.view) root.scrollTo({ top: 0, behavior: "smooth" });
      else setView(btn.dataset.view);
    });
  }
  if (app.local) {
    refreshBtn.innerHTML = icon("plus", 22) + '<span class="lbl">Importieren</span>';
    refreshBtn.title = "Neue GPX-Dateien importieren";
    refreshBtn.setAttribute("aria-label", "GPX-Dateien importieren");
    refreshBtn.addEventListener("click", () => importAndScan());
  } else {
    refreshBtn.innerHTML = icon("refresh", 20) + '<span class="lbl">Aktualisieren</span>';
    refreshBtn.setAttribute("aria-label", "Ordner neu einlesen");
    refreshBtn.addEventListener("click", () => rescan());
  }
  setShellEnabled(false);
}

function setShellEnabled(on) {
  document.body.classList.toggle("shell-off", !on);
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
  disposeView();
  renderFolderSetup(root, {
    mode,
    mobile: isMobile(),
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
  if (root._view) app.scrollPos[root._view] = root.scrollTop;
  app.view = view;
  for (const b of tabsEl.querySelectorAll("button[data-view]")) {
    b.classList.toggle("active", b.dataset.view === view);
  }
  for (const v of Object.keys(VIEW_TITLES)) document.body.classList.toggle(`view-${v}`, v === view);
  viewTitleEl.textContent = VIEW_TITLES[view] || "";
  renderActiveView();
}

function disposeView() {
  try {
    root._dispose?.();
  } catch {
    /* noop */
  }
  root._dispose = root._softRefresh = null;
  root._view = null;
}

/**
 * Draw the active view. `soft` = the data changed underneath (edit in the
 * detail page, place names arriving): views that can update in place do so –
 * keeps scroll position, keyboard focus and the map's pan/zoom.
 */
function renderActiveView({ soft = false } = {}) {
  if (!state.dirHandle) return;
  const mobile = isMobile();
  if (soft && root._softRefresh && root._view === app.view && root._mobile === mobile) {
    root._softRefresh();
    return;
  }
  const scrollTop = root._view === app.view ? root.scrollTop : app.scrollPos[app.view] || 0;
  disposeView();
  const ctx = buildCtx();
  clear(root);
  if (app.view === "map") (mobile ? renderMobileMap : renderMapSearch)(root, ctx);
  else if (app.view === "settings") renderSettings(root, ctx);
  else (mobile ? renderMobileList : renderList)(root, ctx);
  root._view = app.view;
  root._mobile = mobile;
  root.scrollTop = scrollTop;
}

function buildCtx() {
  return {
    state,
    get scanStatus() {
      return app.scanStatus; // live – soft-refreshed views keep their ctx
    },
    dirHandle: state.dirHandle,
    mobile: isMobile(),
    mobileCapable: mobileMq.matches, // a phone-sized screen, whatever the setting
    setMobileUi: async (on) => {
      state.settings.mobileUi = on;
      await db.setMeta("settings", state.settings);
      applyLayoutMode();
      renderActiveView();
    },
    openDetail: (fileName) => {
      app._detailOpen = true;
      openDetail(buildCtx(), fileName);
    },
    closeDetail: () => {
      app._detailOpen = false;
    },
    refreshTours: async () => {
      state.tours = await db.getAllTours();
      renderActiveView({ soft: true });
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

    renderActiveView({ soft: true });

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
          renderActiveView({ soft: true });
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
    if (!app._detailOpen && app.view === "list") renderActiveView({ soft: true });

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
