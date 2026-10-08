import { el, clear } from "../dom.js";
import { toursWithinRadius, densestClusterBox } from "../spatial.js";
import { routeSvg } from "../minimap.js";
import {
  fmtDistance,
  fmtElevation,
  fmtDuration,
  fmtDate,
  effectiveCategory,
  effectiveIsPlan,
  effectiveTitle,
  starString,
  CATEGORY_COLOR,
  CATEGORY_LABEL,
} from "../format.js";
import { searchPlace } from "../geocode.js";
import { attachLayerControl } from "../mapLayers.js";
import { resolveTrackPalette, selectHalo, casingStyleFor } from "../trackColors.js";
import { matchesFilter } from "../filter.js";
import { buildFilterPanel, makeFilterButton } from "./filterPanel.js";
import { openOfflineMapDialog } from "./offlineDialog.js";

const DEFAULT_CENTER = [47.27, 11.39]; // Innsbruck

export function renderMapSearch(mount, ctx) {
  clear(mount);
  const { state } = ctx;

  // Route line colours – recorded tour, planned route, picked tour + its glow.
  // The scheme (and the white/dark casing under every line) comes from the
  // palette the user picked in Settings; see js/trackColors.js.
  const palette = resolveTrackPalette(state.settings);
  const TOUR_COLOR = palette.tour;
  const PLAN_COLOR = palette.plan;
  const SELECT_COLOR = palette.select;
  const SELECT_HALO = selectHalo(palette);
  const L = window.L;
  const hasLeaflet = typeof L !== "undefined";

  if (!state.selectedOnMap) state.selectedOnMap = new Set();
  const selected = state.selectedOnMap;

  // the display/search filter (same one as the list) decides which routes show
  // on the map – independent of the permanent "Track ausblenden" flag, which
  // matchesFilter() already respects via filter.showHidden.
  let tours = [];
  let byFile = new Map();
  function recomputeTours() {
    tours = state.tours.filter((t) => matchesFilter(t, state.filter));
    byFile = new Map(tours.map((t) => [t.fileName, t]));
    // drop selections for tours that are gone, hidden or filtered out
    for (const fn of [...selected]) if (!byFile.has(fn)) selected.delete(fn);
  }
  recomputeTours();

  const radius = { km: state.searchRadiusKm || 5 };

  // ---- controls ----------------------------------------------------
  const placeInput = el("input", {
    type: "search",
    class: "search",
    placeholder: "Ort, Region oder Land…",
  });
  const placeBtn = el("button", { class: "btn", text: "Gehe zu" });
  const placeStatus = el("span", { class: "muted small" });

  const radiusOut = el("span", { class: "radius-out" }, `${radius.km.toFixed(1)} km`);
  const radiusSlider = el("input", {
    type: "range", min: "0.5", max: "50", step: "0.5",
    value: String(radius.km), class: "slider",
    oninput: (e) => {
      radius.km = parseFloat(e.target.value);
      radiusOut.textContent = `${radius.km.toFixed(1)} km`;
      state.searchRadiusKm = radius.km;
      updateCircle();
    },
  });

  const searchBtn = el("button", {
    class: "btn primary", text: "Touren im Umkreis wählen", onclick: selectByRadius,
  });
  const clearBtn = el("button", {
    class: "btn subtle", text: "Auswahl aufheben", onclick: clearSelection,
  });
  const radiusToggleBtn = el("button", {
    class: "btn subtle", title: "Umkreissuche (Fadenkreuz + Kreis) ein-/ausblenden",
    text: "Umkreissuche", onclick: toggleRadiusSearch,
  });
  const offlineBtn = el("button", {
    class: "btn subtle", title: "Aktuellen Kartenausschnitt offline speichern",
    text: "Offline-Karte", disabled: !hasLeaflet,
    onclick: () => map && openOfflineMapDialog(map, state.settings),
  });

  const countries = [
    ...new Set(state.tours.map((t) => t.country).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, "de"));
  const filterPanel = buildFilterPanel(state.filter, countries, () => {
    filterBtnApi.update();
    recomputeTours();
    updateFilterCount();
    rebuildLines();
  });
  const filterBtnApi = makeFilterButton(state.filter, filterPanel);
  // opening/closing the panel changes .map-wrap's height (flex column layout) –
  // Leaflet caches its container size and won't notice on its own, which left
  // the map clipped behind a grey bar until the next pan/zoom.
  filterBtnApi.btn.addEventListener("click", () => {
    setTimeout(() => map && map.invalidateSize(), 80);
  });
  const filterCount = el("span", { class: "muted small" });
  function updateFilterCount() {
    const total = state.tours.length;
    filterCount.textContent = tours.length === total ? "" : `${tours.length} von ${total} Touren`;
  }
  updateFilterCount();

  const controls = el("div", { class: "map-controls" },
    el("div", { class: "row" }, placeInput, placeBtn, placeStatus),
    el("div", { class: "row" },
      el("span", { class: "filter-label" }, "Umkreis"), radiusSlider, radiusOut),
    el("div", { class: "row" },
      searchBtn, clearBtn, radiusToggleBtn, offlineBtn, filterBtnApi.btn, filterCount));

  // ---- layout ----------------------------------------------------
  const mapEl = el("div", { class: "map-canvas" });
  const crosshair = el("div", { class: "crosshair", html: "&#10010;" });
  const swatch = (c) => el("span", { class: "sw", style: `background:${c}` });
  const hint = el("div", { class: "map-hint muted small" },
    el("span", { class: "map-legend" },
      el("span", { class: "lg" }, swatch(TOUR_COLOR), "Tour"),
      el("span", { class: "lg" }, swatch(PLAN_COLOR), "Planung"),
      el("span", { class: "lg" }, swatch(SELECT_COLOR), "gewählt")),
    el("span", { class: "hint-sep" }, "· anklicken wählt aus"));
  const mapWrap = el("div", { class: "map-wrap" }, mapEl, crosshair, hint);
  const results = el("div", { class: "map-results" });

  let radiusSearchEnabled = state.settings.radiusSearchEnabled !== false;
  crosshair.style.display = radiusSearchEnabled ? "" : "none";
  radiusToggleBtn.classList.toggle("active", radiusSearchEnabled);
  radiusSlider.disabled = !radiusSearchEnabled;
  searchBtn.disabled = !radiusSearchEnabled;

  const view = el("div", { class: "mapview" }, controls, filterPanel, mapWrap, results);
  mount.append(view);

  let map = null;
  let circle = null;
  let haloLayer = null;
  let casingLayer = null;
  let lineLayer = null;
  const lineByFile = new Map();
  const casingByFile = new Map();

  if (hasLeaflet) {
    requestAnimationFrame(() => {
      // on touch screens thin route lines need a generous tap tolerance
      map = L.map(mapEl, {
        zoomControl: true,
        preferCanvas: true,
        renderer: L.canvas({ tolerance: L.Browser.touch ? 12 : 0 }),
      });
      attachLayerControl(map, {
        settings: state.settings,
        save: () => ctx.saveSettings?.(),
      });

      // Dedicated panes below the default overlay pane (z 400) so the stacking
      // order — halo glow < casing < route lines — holds no matter what order the
      // polylines get added in (tours are added casing/line interleaved, and
      // overlapping tracks would otherwise let a later casing paint over an
      // earlier coloured line). Each pane gets its own canvas renderer.
      map.createPane("haloPane").style.zIndex = 370;
      map.createPane("casingPane").style.zIndex = 380;
      haloLayer = L.layerGroup().addTo(map);
      casingLayer = L.layerGroup().addTo(map);
      lineLayer = L.layerGroup().addTo(map);

      for (const t of tours) addLineFor(t);

      const box = densestClusterBox(tours);
      if (box) {
        map.fitBounds([[box.minLat, box.minLon], [box.maxLat, box.maxLon]], { padding: [30, 30] });
      } else {
        map.setView(DEFAULT_CENTER, 9);
      }

      circle = L.circle(map.getCenter(), {
        radius: radius.km * 1000, color: "#e07d21", weight: 2,
        dashArray: "6 4", fillOpacity: 0.07, interactive: false,
      });
      if (radiusSearchEnabled) circle.addTo(map);

      map.on("move", updateCircle);
      map.on("moveend", () => {
        const c = map.getCenter();
        state.searchCenter = { lat: c.lat, lon: c.lng };
        updateCircle();
      });
      // click on empty map (not on a route line, which stops propagation) clears the selection
      map.on("click", () => {
        if (selected.size) clearSelection();
      });
      setTimeout(() => map.invalidateSize(), 60);

      applySelectionUI(false);
    });
  } else {
    mapEl.append(el("div", { class: "map-fallback" },
      el("p", { class: "muted", text: "Karte offline – Auswahl unten als Streckenskizze." })));
    crosshair.style.display = "none";
    radiusToggleBtn.disabled = true;
    applySelectionUI(false);
  }

  // ---- styling / selection --------------------------------------
  // Selected = red; otherwise recorded tours = blue, planned routes = violet.
  // All solid – the colour carries the meaning, no dashes.
  function styleFor(t) {
    if (selected.has(t.fileName)) {
      return { color: SELECT_COLOR, weight: 6, opacity: 1, lineCap: "round" };
    }
    if (effectiveIsPlan(t)) {
      return { color: PLAN_COLOR, weight: 3, opacity: 0.85, lineCap: "round" };
    }
    return { color: TOUR_COLOR, weight: 3, opacity: 0.75, lineCap: "round" };
  }

  function refreshLineStyles() {
    for (const [fn, line] of lineByFile) {
      const t = byFile.get(fn);
      if (!t) continue;
      const st = styleFor(t);
      line.setStyle(st);
      const casing = casingByFile.get(fn);
      if (casing) casing.setStyle(casingStyleFor(st.weight, palette));
      if (selected.has(fn)) line.bringToFront();
    }
    if (haloLayer) {
      haloLayer.clearLayers();
      for (const fn of selected) {
        const t = byFile.get(fn);
        if (t && (t.polyline || []).length > 1) {
          L.polyline(t.polyline, {
            color: SELECT_HALO, weight: 18, opacity: 1, lineCap: "round",
            interactive: false, pane: "haloPane",
          }).addTo(haloLayer);
        }
      }
    }
  }

  function addLineFor(t) {
    const pts = t.polyline || [];
    if (pts.length < 2) return;
    const st = styleFor(t);
    // white/dark casing first so it sits directly under the coloured route
    const casing = L.polyline(pts, { ...casingStyleFor(st.weight, palette), pane: "casingPane" })
      .addTo(casingLayer);
    casingByFile.set(t.fileName, casing);
    const line = L.polyline(pts, { ...st, bubblingMouseEvents: false });
    line.bindTooltip(effectiveTitle(t), { sticky: true });
    line.on("click", (e) => {
      // a canvas-rendered layer's click still bubbles to the map's own
      // click handler unless stopped here – would instantly clear the
      // selection we're about to set below.
      L.DomEvent.stopPropagation(e.originalEvent);
      toggle(t.fileName);
    });
    line.on("mouseover", () => line.setStyle({ weight: styleFor(t).weight + 2 }));
    line.on("mouseout", () => line.setStyle(styleFor(t)));
    line.addTo(lineLayer);
    lineByFile.set(t.fileName, line);
  }

  // redraw the route lines for the current (filtered) tour list, keeping the
  // map's own pan/zoom untouched – used whenever the display filter changes.
  function rebuildLines() {
    if (!map || !lineLayer) return;
    lineLayer.clearLayers();
    casingLayer.clearLayers();
    lineByFile.clear();
    casingByFile.clear();
    for (const t of tours) addLineFor(t);
    applySelectionUI(false);
  }

  function toggle(fileName) {
    if (selected.has(fileName)) selected.delete(fileName);
    else selected.add(fileName);
    applySelectionUI(false);
  }

  function clearSelection() {
    selected.clear();
    applySelectionUI(false);
  }

  function toggleRadiusSearch() {
    radiusSearchEnabled = !radiusSearchEnabled;
    crosshair.style.display = radiusSearchEnabled ? "" : "none";
    radiusToggleBtn.classList.toggle("active", radiusSearchEnabled);
    radiusSlider.disabled = !radiusSearchEnabled;
    searchBtn.disabled = !radiusSearchEnabled;
    if (circle) {
      if (radiusSearchEnabled) {
        circle.addTo(map);
        updateCircle();
      } else {
        map.removeLayer(circle);
      }
    }
    state.settings.radiusSearchEnabled = radiusSearchEnabled;
    ctx.saveSettings?.();
  }

  function selectByRadius() {
    const c = map
      ? { lat: map.getCenter().lat, lon: map.getCenter().lng }
      : state.searchCenter || { lat: DEFAULT_CENTER[0], lon: DEFAULT_CENTER[1] };
    const hits = toursWithinRadius(tours, c, radius.km * 1000);
    selected.clear();
    for (const t of hits) selected.add(t.fileName);
    applySelectionUI(true);
  }

  function applySelectionUI(fitToSelection) {
    const active = selected.size > 0;
    view.classList.toggle("has-selection", active);
    clearBtn.style.display = active ? "" : "none";
    refreshLineStyles();
    renderResults();

    if (map) {
      // the map box just resized – let Leaflet recompute, then optionally frame
      setTimeout(() => {
        map.invalidateSize();
        if (fitToSelection && active) {
          const group = [];
          for (const fn of selected) {
            const line = lineByFile.get(fn);
            if (line) group.push(line);
          }
          if (group.length) {
            const b = group[0].getBounds();
            for (let i = 1; i < group.length; i++) b.extend(group[i].getBounds());
            map.fitBounds(b, { padding: [30, 30] });
          }
        }
      }, 80);
    }
  }

  function updateCircle() {
    if (!map || !circle) return;
    circle.setLatLng(map.getCenter());
    circle.setRadius(radius.km * 1000);
  }

  // ---- place search ------------------------------------------
  placeBtn.onclick = doPlaceSearch;
  placeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doPlaceSearch();
  });
  async function doPlaceSearch() {
    const q = placeInput.value.trim();
    if (!q) return;
    placeStatus.textContent = "suche…";
    try {
      const hit = await searchPlace(q);
      if (!hit) { placeStatus.textContent = "nicht gefunden"; return; }
      placeStatus.textContent = "";
      state.searchCenter = { lat: hit.lat, lon: hit.lon };
      if (map) map.setView([hit.lat, hit.lon], 11);
    } catch {
      placeStatus.textContent = "offline?";
    }
  }

  // ---- results list ----------------------------------------
  function renderResults() {
    clear(results);
    if (!selected.size) return;
    const rows = [...selected].map((fn) => byFile.get(fn)).filter(Boolean)
      .sort((a, b) => b.distanceM - a.distanceM);

    results.append(el("div", { class: "list-count muted small" },
      `${rows.length} ausgewählt`));
    const list = el("div", { class: "tour-list" });
    for (const t of rows) {
      const cat = effectiveCategory(t);
      list.append(el("div", { class: "tour-row selectable" },
        el("button", {
          class: "row-open",
          onclick: () => ctx.openDetail(t.fileName),
        },
          el("div", { class: "thumb", html: routeSvg(t.polyline, t.bbox, 56, 56) }),
          el("div", { class: "tour-main" },
            el("div", { class: "tour-title-row" },
              el("span", { class: "cat-tag", style: `--c:${CATEGORY_COLOR[cat]}` }, CATEGORY_LABEL[cat]),
              effectiveIsPlan(t) ? el("span", { class: "plan-badge" }, "Planung") : null,
              el("span", { class: "tour-title" }, effectiveTitle(t)),
              t.rating ? el("span", { class: "stars small" }, starString(t.rating)) : null),
            el("div", { class: "tour-sub muted small" },
              fmtDate(t.tourDate) + (t.country ? ` · ${t.country}` : "")),
            el("div", { class: "tour-stats muted small" },
              el("span", { class: "stat" }, fmtDistance(t.distanceM)),
              el("span", { class: "stat" }, `↑ ${fmtElevation(t.ascentM)}`),
              t.totalS > 0 ? el("span", { class: "stat" }, fmtDuration(t.totalS)) : null))),
        el("button", {
          class: "row-remove", title: "aus Auswahl entfernen",
          text: "×", onclick: () => toggle(t.fileName),
        })));
    }
    results.append(list);
  }
}
