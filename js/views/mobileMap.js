// Map for phones: full-screen map, floating place search + filter, buttons for
// map style and own position, and a bottom sheet that always answers "which
// tours are here?" – the tours inside the visible map area, or the tours under
// the finger after a tap (overlapping tracks are all offered, not just the
// topmost). Replaces the desktop's crosshair/radius search on small screens.

import { el, clear } from "../dom.js";
import { densestClusterBox, toursIntersectingRect, toursNearPoint } from "../spatial.js";
import { matchesFilter, sortTours, activeFilterCount } from "../filter.js";
import { effectiveIsPlan } from "../format.js";
import { bboxValid } from "../geo.js";
import { searchPlace } from "../geocode.js";
import { attachLayerControl } from "../mapLayers.js";
import { resolveTrackPalette, selectHalo, casingStyleFor } from "../trackColors.js";
import { icon } from "../icons.js";
import { toast } from "./ui.js";
import { openFilterSheet } from "./filterSheet.js";
import { openLayerSheet } from "./layerSheet.js";
import { mobileTourRow } from "./mobileList.js";

const DEFAULT_CENTER = [47.27, 11.39]; // Innsbruck
const TAP_TOLERANCE_PX = 18;
const MAX_PICKED = 12;

export function renderMobileMap(mount, ctx) {
  clear(mount);
  const { state } = ctx;
  const L = window.L;
  // survives tab switches and background re-renders
  const ms = (state.mobileMap ||= { view: null, picked: [], expanded: false, loc: null });

  let palette = resolveTrackPalette(state.settings);
  let tours = [];
  let byFile = new Map();
  let inView = [];
  const picked = new Set(ms.picked);

  function recompute() {
    tours = state.tours.filter((t) => matchesFilter(t, state.filter));
    byFile = new Map(tours.map((t) => [t.fileName, t]));
    for (const fn of [...picked]) if (!byFile.has(fn)) picked.delete(fn);
    ms.picked = [...picked];
  }
  recompute();

  // ---- DOM -------------------------------------------------------
  const searchInput = el("input", {
    type: "search",
    class: "msearch-input",
    placeholder: "Ort suchen",
    enterkeyhint: "search",
    autocomplete: "off",
    autocorrect: "off",
    spellcheck: false,
  });
  const filterBtn = el("button", {
    type: "button", class: "mfab", "aria-label": "Filter", html: icon("filter"),
    onclick: () => openFilterSheet(state, { onChange: afterFilter }),
  });
  const top = el("form", {
    class: "mmap-top",
    onsubmit: (e) => {
      e.preventDefault();
      placeSearch();
    },
  },
  el("label", { class: "msearch mmap-search" },
    el("span", { class: "msearch-ico", html: icon("search", 18) }), searchInput),
  filterBtn);

  const layersBtn = el("button", {
    type: "button", class: "mfab", "aria-label": "Kartenstil und Ebenen", html: icon("layers"),
    onclick: openLayers,
  });
  const locateBtn = el("button", {
    type: "button", class: "mfab", "aria-label": "Mein Standort", html: icon("locate"),
    onclick: locate,
  });
  const fabs = el("div", { class: "mmap-fabs" }, layersBtn, locateBtn);
  const sheet = el("div", { class: "mmap-sheet" });
  const mapEl = el("div", { class: "mmap-canvas" });
  const view = el("div", { class: "mmap" }, mapEl, top, fabs, sheet);
  mount.append(view);

  // ---- map -------------------------------------------------------
  let map = null;
  let layers = null;
  let haloLayer = null;
  let casingLayer = null;
  let lineLayer = null;
  let locLayer = null;
  const lines = new Map(); // fileName -> { line, casing }

  if (L) {
    requestAnimationFrame(initMap);
  } else {
    layersBtn.disabled = locateBtn.disabled = true;
    inView = tours;
    ms.expanded = true;
  }

  function initMap() {
    if (!mapEl.isConnected) return; // view was replaced before the first frame
    map = L.map(mapEl, { zoomControl: false, preferCanvas: true });
    layers = attachLayerControl(map, {
      settings: state.settings,
      save: () => ctx.saveSettings?.(),
      control: false,
    });
    // glow < casing < route lines, independent of insertion order
    map.createPane("haloPane").style.zIndex = 370;
    map.createPane("casingPane").style.zIndex = 380;
    map.createPane("locPane").style.zIndex = 450;
    haloLayer = L.layerGroup().addTo(map);
    casingLayer = L.layerGroup().addTo(map);
    lineLayer = L.layerGroup().addTo(map);
    locLayer = L.layerGroup().addTo(map);

    buildLines();
    if (ms.view) map.setView(ms.view.center, ms.view.zoom);
    else frame(densestClusterBox(tours));
    if (ms.loc) showLocation(ms.loc.ll, ms.loc.acc);

    map.on("moveend", () => {
      const c = map.getCenter();
      ms.view = { center: [c.lat, c.lng], zoom: map.getZoom() };
      recount();
      if (!picked.size) renderSheet();
    });
    map.on("click", onTap);
    setTimeout(() => {
      if (!map) return;
      map.invalidateSize();
      recount();
      renderSheet();
    }, 60);
  }

  function frame(box) {
    if (!map) return;
    if (box && bboxValid(box)) {
      map.fitBounds([[box.minLat, box.minLon], [box.maxLat, box.maxLon]], {
        paddingTopLeft: [24, 76],
        paddingBottomRight: [24, (sheet.offsetHeight || 64) + 24],
        maxZoom: 15,
      });
    } else {
      map.setView(DEFAULT_CENTER, 9);
    }
  }

  function unionBox(list) {
    let b = null;
    for (const t of list) {
      if (!bboxValid(t.bbox)) continue;
      if (!b) b = { ...t.bbox };
      else {
        b.minLat = Math.min(b.minLat, t.bbox.minLat);
        b.maxLat = Math.max(b.maxLat, t.bbox.maxLat);
        b.minLon = Math.min(b.minLon, t.bbox.minLon);
        b.maxLon = Math.max(b.maxLon, t.bbox.maxLon);
      }
    }
    return b;
  }

  function recount() {
    if (!map) return;
    const b = map.getBounds();
    inView = toursIntersectingRect(tours, {
      minLat: b.getSouth(), maxLat: b.getNorth(), minLon: b.getWest(), maxLon: b.getEast(),
    });
  }

  // ---- route lines -----------------------------------------------
  function styleFor(t) {
    if (picked.has(t.fileName)) return { color: palette.select, weight: 6, opacity: 1 };
    if (effectiveIsPlan(t)) return { color: palette.plan, weight: 3, opacity: 0.9 };
    return { color: palette.tour, weight: 3, opacity: 0.85 };
  }

  function buildLines() {
    if (!map) return;
    lineLayer.clearLayers();
    casingLayer.clearLayers();
    lines.clear();
    for (const t of tours) {
      const pts = t.polyline || [];
      if (pts.length < 2) continue;
      const st = styleFor(t);
      // taps are hit-tested by hand (onTap), so the lines stay non-interactive
      const casing = L.polyline(pts, { ...casingStyleFor(st.weight, palette), pane: "casingPane" })
        .addTo(casingLayer);
      const line = L.polyline(pts, { ...st, lineCap: "round", lineJoin: "round", interactive: false })
        .addTo(lineLayer);
      lines.set(t.fileName, { line, casing });
    }
    styleLines();
  }

  function styleLines() {
    if (!map) return;
    for (const [fn, { line, casing }] of lines) {
      const t = byFile.get(fn);
      if (!t) continue;
      const st = styleFor(t);
      line.setStyle(st);
      casing.setStyle(casingStyleFor(st.weight, palette));
    }
    haloLayer.clearLayers();
    for (const fn of picked) {
      const entry = lines.get(fn);
      if (!entry) continue;
      entry.casing.bringToFront();
      entry.line.bringToFront();
      L.polyline(byFile.get(fn).polyline, {
        color: selectHalo(palette), weight: 18, opacity: 1, lineCap: "round",
        interactive: false, pane: "haloPane",
      }).addTo(haloLayer);
    }
  }

  // ---- tap: which tours are under the finger? ----------------------
  function onTap(e) {
    if (document.activeElement === searchInput) searchInput.blur();
    const p = map.latLngToContainerPoint(e.latlng);
    const corner = map.containerPointToLatLng([p.x + TAP_TOLERANCE_PX, p.y + TAP_TOLERANCE_PX]);
    const dLat = Math.abs(corner.lat - e.latlng.lat);
    const dLon = Math.abs(corner.lng - e.latlng.lng);
    const hits = toursNearPoint(
      tours,
      p,
      (ll) => map.latLngToContainerPoint(ll),
      TAP_TOLERANCE_PX,
      {
        minLat: e.latlng.lat - dLat, maxLat: e.latlng.lat + dLat,
        minLon: e.latlng.lng - dLon, maxLon: e.latlng.lng + dLon,
      }
    );
    if (!hits.length) {
      // tap on empty map: drop the pick, or fold the list away
      if (picked.size) picked.clear();
      else if (ms.expanded) ms.expanded = false;
      else return;
    } else {
      picked.clear();
      for (const t of hits.slice(0, MAX_PICKED)) picked.add(t.fileName);
    }
    ms.picked = [...picked];
    styleLines();
    renderSheet();
  }

  function clearPick() {
    picked.clear();
    ms.picked = [];
    styleLines();
    recount();
    renderSheet();
  }

  // ---- bottom sheet ----------------------------------------------
  function renderSheet() {
    const pickedTours = [...picked].map((fn) => byFile.get(fn)).filter(Boolean);
    const open = (t) => ctx.openDetail(t.fileName);
    let head;
    let list = null;

    if (pickedTours.length) {
      head = el("div", { class: "mmap-sheet-head" },
        el("span", { class: "mmap-sheet-title",
          text: pickedTours.length === 1 ? "Ausgewählte Tour" : `${pickedTours.length} Touren an dieser Stelle` }),
        el("button", { type: "button", class: "mmap-sheet-btn", "aria-label": "Auswahl aufheben",
          html: icon("x", 18), onclick: clearPick }));
      list = pickedTours;
      view.classList.remove("sheet-expanded");
    } else {
      const n = inView.length;
      const title = !state.tours.length
        ? "Noch keine Touren"
        : !tours.length
          ? "Keine Tour passt zum Filter"
          : n
            ? `${n} ${n === 1 ? "Tour" : "Touren"} im Ausschnitt`
            : "Keine Tour im Ausschnitt";
      const canExpand = n > 0;
      const expanded = canExpand && ms.expanded;
      head = el("div", {
        class: "mmap-sheet-head" + (canExpand ? " tappable" : ""),
        onclick: (e) => {
          if (!canExpand || e.target.closest(".mmap-sheet-btn")) return;
          ms.expanded = !ms.expanded;
          renderSheet();
        },
      },
      el("span", { class: "mmap-grab" }),
      el("span", { class: "mmap-sheet-title", text: title }),
      tours.length && map
        ? el("button", { type: "button", class: "mmap-sheet-btn text", text: "Alle zeigen",
            onclick: () => frame(unionBox(tours)) })
        : null,
      canExpand ? el("span", { class: "mmap-sheet-chev", html: icon(expanded ? "chevronDown" : "chevronUp", 20) }) : null);
      list = expanded ? sortTours(inView, "dateDesc") : null;
      view.classList.toggle("sheet-expanded", expanded);
    }

    sheet.replaceChildren(head);
    if (list && list.length) {
      sheet.append(el("div", { class: "mmap-sheet-body" },
        el("div", { class: "mgroup flat" }, ...list.map((t) => mobileTourRow(t, () => open(t))))));
    }
    // keep Leaflet's attribution visible above the sheet
    requestAnimationFrame(() => view.style.setProperty("--sheet-h", `${sheet.offsetHeight + 12}px`));
  }

  // ---- filter / layers / search / location -----------------------
  function updateFilterDot() {
    filterBtn.classList.toggle("has-dot", activeFilterCount(state.filter) > 0 || !!state.filter.text);
  }

  function afterFilter() {
    recompute();
    buildLines();
    recount();
    renderSheet();
    updateFilterDot();
  }

  function openLayers() {
    if (!map || !layers) return;
    openLayerSheet({
      map,
      layers,
      settings: state.settings,
      save: () => ctx.saveSettings?.(),
      onPalette: () => {
        palette = resolveTrackPalette(state.settings);
        styleLines();
      },
    });
  }

  async function placeSearch() {
    const q = searchInput.value.trim();
    searchInput.blur();
    if (!q || !map) return;
    if (!navigator.onLine) {
      toast("Die Ortssuche braucht Internet");
      return;
    }
    try {
      const hit = await searchPlace(q);
      if (!hit) {
        toast(`„${q}“ nicht gefunden`);
        return;
      }
      map.setView([hit.lat, hit.lon], 12);
    } catch {
      toast("Ortssuche fehlgeschlagen");
    }
  }

  function showLocation(ll, acc) {
    if (!locLayer) return;
    locLayer.clearLayers();
    if (acc) {
      L.circle(ll, {
        radius: acc, pane: "locPane", color: "#1a73e8", weight: 1, opacity: 0.35,
        fillOpacity: 0.12, interactive: false,
      }).addTo(locLayer);
    }
    L.circleMarker(ll, {
      radius: 7, pane: "locPane", color: "#fff", weight: 3, fillColor: "#1a73e8",
      fillOpacity: 1, interactive: false,
    }).addTo(locLayer);
  }

  function locate() {
    if (!map) return;
    if (!navigator.geolocation) {
      toast("Standort wird hier nicht unterstützt");
      return;
    }
    locateBtn.classList.add("busy");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        locateBtn.classList.remove("busy");
        if (!map) return;
        const ll = [pos.coords.latitude, pos.coords.longitude];
        ms.loc = { ll, acc: pos.coords.accuracy };
        showLocation(ll, pos.coords.accuracy);
        map.setView(ll, Math.max(map.getZoom(), 12));
      },
      (err) => {
        locateBtn.classList.remove("busy");
        toast(err && err.code === 1 ? "Standortzugriff ist nicht erlaubt" : "Standort nicht verfügbar");
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  }

  updateFilterDot();
  renderSheet();

  // background updates (place names, edits in the detail page): restyle in
  // place – rebuilding the map would throw away pan/zoom
  mount._softRefresh = () => {
    palette = resolveTrackPalette(state.settings);
    afterFilter();
  };
  mount._dispose = () => {
    if (map) map.remove();
    map = null;
  };
}
