// Mobile "Karte" sheet: base map, overlays, route colours and the offline
// download – replaces Leaflet's tiny layers control on phones.

import { el } from "../dom.js";
import { icon } from "../icons.js";
import { TRACK_PALETTES, resolveTrackPalette } from "../trackColors.js";
import { openSheet, switchEl } from "./ui.js";
import { openOfflineMapDialog } from "./offlineDialog.js";

/**
 * @param {object} o
 * @param {import("leaflet").Map} o.map
 * @param {ReturnType<import("../mapLayers.js").attachLayerControl>} o.layers
 * @param {object} o.settings     state.settings (trackPalette is written here)
 * @param {() => any} o.save      persist settings
 * @param {() => void} [o.onPalette]  re-style the routes after a palette change
 */
export function openLayerSheet({ map, layers, settings, save, onPalette }) {
  const h = (t) => el("h3", { class: "mfilter-h", text: t });

  const baseGrid = el("div", { class: "mbase-grid" });
  for (const b of layers.bases) {
    const btn = el("button", {
      type: "button",
      class: "mbase" + (layers.baseId() === b.id ? " on" : ""),
      onclick: () => {
        layers.setBase(b.id);
        for (const x of baseGrid.children) x.classList.toggle("on", x === btn);
      },
    },
    el("span", { class: `mbase-prev mbase-${b.id}` }),
    el("span", { class: "mbase-name", text: b.short || b.name }));
    baseGrid.append(btn);
  }

  const overlayGroup = el("div", { class: "mgroup" },
    ...layers.overlayDefs.map((o) =>
      el("div", { class: "mcell" },
        el("span", { class: "mcell-k", text: o.short || o.name }),
        switchEl({
          checked: layers.hasOverlay(o.id),
          label: o.short || o.name,
          onchange: (on) => layers.setOverlay(o.id, on),
        }))));

  const paletteGroup = el("div", { class: "mgroup" });
  const legend = el("div", { class: "mlegend" });
  function renderPalettes() {
    const active = resolveTrackPalette(settings);
    paletteGroup.replaceChildren(...TRACK_PALETTES.map((p) =>
      el("button", {
        type: "button",
        class: "mcell mcell-btn" + (p.id === active.id ? " on" : ""),
        onclick: () => {
          settings.trackPalette = p.id;
          save?.();
          renderPalettes();
          onPalette?.();
        },
      },
      el("span", { class: "palette-sw" },
        el("i", { style: `background:${p.tour}` }),
        el("i", { style: `background:${p.plan}` }),
        el("i", { style: `background:${p.select}` })),
      el("span", { class: "mcell-k", text: p.name.replace(/\s*\(.*\)$/, "") }),
      p.id === active.id ? el("span", { class: "mcell-check", text: "✓" }) : null)));
    legend.replaceChildren(
      ...[["Tour", active.tour], ["Planung", active.plan], ["Ausgewählt", active.select]].map(([k, c]) =>
        el("span", { class: "lg" }, el("i", { style: `background:${c}` }), k)));
  }
  renderPalettes();

  const offlineBtn = el("button", {
    type: "button",
    class: "btn mbtn-wide mbtn-icon",
    html: icon("offline", 18) + "<span>Ausschnitt offline speichern</span>",
    onclick: () => {
      sheet.close();
      setTimeout(() => openOfflineMapDialog(map, settings), 280);
    },
  });

  const sheet = openSheet({
    title: "Karte",
    content: el("div", { class: "mlayers" },
      h("Kartenstil"), baseGrid,
      h("Zusatzebenen"), overlayGroup,
      h("Linienfarben"), paletteGroup, legend,
      el("div", { class: "mlayers-offline" }, offlineBtn,
        el("p", { class: "muted small", text: "Speichert die Basiskarte des sichtbaren Ausschnitts für unterwegs ohne Netz." }))),
  });
  return sheet;
}
