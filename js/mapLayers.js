// Selectable base maps plus stackable overlays for the Leaflet maps in the map
// search and the tour detail view. The current choice lives in state.settings
// (`mapBase` string, `mapOverlays` array of ids) so it survives view switches
// and restarts.
//
// All sources below are key-free and were reachable when last checked
// (2026-09-03). CyclOSM (tile-cyclosm.openstreetmap.fr) and 4UMaps (4umaps.eu)
// were tried earlier but dropped: CyclOSM's tile server is down (HTTP 502 /
// timeouts, a known OSM-FR outage) and 4UMaps blocks third-party embedding via
// Cloudflare. Their intent is covered here by OpenTopoMap + the Waymarked Trails
// hiking/cycling route overlays.

import { offlineTileLayer } from "./offlineTiles.js";

// `maxNativeZoom` = deepest zoom the server renders; Leaflet upscales past it so
// switching layers while zoomed in never blanks the map.
const BASES = [
  {
    id: "osm",
    name: "OpenStreetMap",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    options: { maxZoom: 19, attribution: "© OpenStreetMap" },
  },
  {
    id: "topo",
    name: "OpenTopoMap (Relief)",
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    options: {
      maxZoom: 19,
      maxNativeZoom: 17,
      subdomains: "abc",
      attribution:
        "© OpenStreetMap, SRTM · Kartografie © OpenTopoMap (CC-BY-SA)",
    },
  },
  {
    // Luftbild – am nützlichsten zur Fehlersuche: folgt der Track dem echten Weg?
    id: "sat",
    name: "Satellit (Esri)",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    options: {
      maxZoom: 19,
      maxNativeZoom: 19,
      attribution: "Luftbild © Esri, Maxar, Earthstar Geographics",
    },
  },
];

// Overlays are checkboxes and stack on top of the base map and each other.
const OVERLAYS = [
  {
    // The public GPS-traces layer openstreetmap.org offers – every track anyone
    // ever uploaded, as faint lines. Good for spotting where a recording drifts.
    id: "gps",
    name: "Öffentliche GPS-Tracks (OSM)",
    url: "https://gps.tile.openstreetmap.org/lines/{z}/{x}/{y}.png",
    options: { maxZoom: 20, opacity: 0.7, className: "gps-trace-tiles" },
  },
  {
    // Signposted hiking route network (SAC scale, tour symbols, …).
    id: "hiking",
    name: "Wanderwege (Waymarked Trails)",
    url: "https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png",
    options: {
      maxZoom: 19,
      maxNativeZoom: 18,
      attribution: "Wege © waymarkedtrails.org (CC-BY-SA)",
    },
  },
  {
    // Signposted cycle route network (national/regional routes, EuroVelo, …) –
    // the stand-in for CyclOSM.
    id: "cycling",
    name: "Radrouten (Waymarked Trails)",
    url: "https://tile.waymarkedtrails.org/cycling/{z}/{x}/{y}.png",
    options: {
      maxZoom: 19,
      maxNativeZoom: 18,
      attribution: "Routen © waymarkedtrails.org (CC-BY-SA)",
    },
  },
];

const DEFAULT_BASE = "osm";

/** Base-map definitions (id, name, url, options) – used by the offline downloader. */
export function baseLayerDefs() {
  return BASES;
}

export function baseLayerDef(id) {
  return BASES.find((b) => b.id === id) || BASES[0];
}

// Older builds stored a single boolean `mapGpsOverlay`; fold it into the list.
function activeOverlayIds(settings) {
  if (Array.isArray(settings.mapOverlays)) return new Set(settings.mapOverlays);
  return new Set(settings.mapGpsOverlay ? ["gps"] : []);
}

/**
 * Add a base-map switcher and the overlay checkboxes to a Leaflet map, and
 * remember the choice in state.settings.
 *
 * @param {import("leaflet").Map} map
 * @param {object}    [opts]
 * @param {object}    [opts.settings]      read/written: `mapBase`, `mapOverlays`
 * @param {() => any} [opts.save]          persist settings (fire-and-forget)
 * @param {boolean}   [opts.collapsed=true]
 * @returns {{ baseLayers: Record<string, any>, overlays: Record<string, any> }}
 */
export function attachLayerControl(
  map,
  { settings = {}, save, collapsed = true } = {}
) {
  const L = window.L;
  const wantBase = BASES.some((b) => b.id === settings.mapBase)
    ? settings.mapBase
    : DEFAULT_BASE;

  const baseLayers = {};
  for (const def of BASES) {
    // offline-aware: serves tiles from the IndexedDB cache when they were saved
    const layer = offlineTileLayer(def.id, def.url, def.options);
    layer._layerId = def.id;
    baseLayers[def.name] = layer;
    if (def.id === wantBase) layer.addTo(map);
  }

  const wantOverlays = activeOverlayIds(settings);
  const overlays = {};
  const overlayById = new Map();
  for (const def of OVERLAYS) {
    const layer = L.tileLayer(def.url, def.options);
    layer._layerId = def.id;
    overlays[def.name] = layer;
    overlayById.set(def.id, layer);
    if (wantOverlays.has(def.id)) layer.addTo(map);
  }

  L.control.layers(baseLayers, overlays, { collapsed }).addTo(map);

  map.on("baselayerchange", (e) => {
    if (!e.layer || !e.layer._layerId) return;
    settings.mapBase = e.layer._layerId;
    save?.();
  });

  const persistOverlays = () => {
    settings.mapOverlays = [...overlayById]
      .filter(([, layer]) => map.hasLayer(layer))
      .map(([id]) => id);
    delete settings.mapGpsOverlay; // migrated away
    save?.();
  };
  map.on("overlayadd", (e) => e.layer._layerId && persistOverlays());
  map.on("overlayremove", (e) => e.layer._layerId && persistOverlays());

  return { baseLayers, overlays };
}
