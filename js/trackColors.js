// Track line colours for the Leaflet maps (map search + tour detail).
//
// Why this exists: the relief and satellite base maps are visually busy.
// OpenTopoMap already uses blue for water and power lines and a magenta dash for
// administrative boundaries, so the old hard-coded blue tour / violet plan lines
// barely separated from the ground. Two fixes, both applied here:
//   1. high-chroma line colours picked to sit in a hue gap of the base map, and
//   2. a contrasting *casing* – a wider line drawn underneath the coloured one –
//      so the route reads on any background. Every routing app (komoot, Strava,
//      Google, Mapbox) does this.
// The user chooses a palette in Settings; the id lives in
// state.settings.trackPalette.

export const TRACK_PALETTES = [
  {
    id: "kraeftig",
    name: "Kräftig (Standard)",
    hint: "Magenta / Violett mit hellem Rand – klarster Kontrast auf Relief- und Straßenkarte.",
    tour: "#ff2d78",
    plan: "#8b46ff",
    select: "#ffb300",
    casing: "rgba(255,255,255,0.85)",
  },
  {
    id: "kontrast",
    name: "Kontrast",
    hint: "Klassisches Dunkelblau, durch den hellen Rand trotzdem klar abgesetzt.",
    tour: "#1140c8",
    plan: "#c81e78",
    select: "#ff6a00",
    casing: "rgba(255,255,255,0.9)",
  },
  {
    id: "neon",
    name: "Neon (Luftbild)",
    hint: "Maximale Leuchtkraft mit dunklem Rand – gedacht für die Satellitenansicht.",
    tour: "#ff1f9c",
    plan: "#00e5ff",
    select: "#faff00",
    casing: "rgba(0,0,0,0.5)",
  },
];

export const DEFAULT_TRACK_PALETTE = "kraeftig";

/** Active palette object for the current settings (never null). */
export function resolveTrackPalette(settings = {}) {
  return (
    TRACK_PALETTES.find((p) => p.id === settings.trackPalette) ||
    TRACK_PALETTES.find((p) => p.id === DEFAULT_TRACK_PALETTE)
  );
}

/** Translucent glow behind the picked route, derived from its select colour. */
export function selectHalo(palette) {
  return hexToRgba(palette.select, 0.24);
}

/**
 * Leaflet style for the casing line drawn *under* a route of weight `baseWeight`.
 * Always 3 px wider (1.5 px lip on each side) and non-interactive.
 */
export function casingStyleFor(baseWeight, palette) {
  return {
    color: palette.casing,
    weight: baseWeight + 3,
    opacity: 1,
    lineCap: "round",
    lineJoin: "round",
    interactive: false,
  };
}

function hexToRgba(hex, alpha) {
  const h = String(hex).replace("#", "").trim();
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const num = parseInt(n, 16);
  if (n.length !== 6 || Number.isNaN(num)) return `rgba(255,59,48,${alpha})`;
  return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`;
}
