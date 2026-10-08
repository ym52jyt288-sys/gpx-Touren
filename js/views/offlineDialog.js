import { el } from "../dom.js";
import { baseLayerDef } from "../mapLayers.js";
import {
  countTiles,
  estimateBytes,
  downloadRegion,
  MAX_ZOOM_CAP,
  SOFT_TILE_LIMIT,
  HARD_TILE_LIMIT,
} from "../offlineTiles.js";

function fmtMB(bytes) {
  const mb = bytes / (1024 * 1024);
  if (mb >= 100) return `${Math.round(mb)} MB`;
  if (mb >= 10) return `${mb.toFixed(0)} MB`;
  return `${mb.toFixed(1)} MB`;
}

const fmtInt = (n) => n.toLocaleString("de-DE");

/**
 * Modal to download the current map view (base layer only) for offline use.
 * @param {import("leaflet").Map} map
 * @param {object} settings  state.settings (reads `mapBase`)
 */
export function openOfflineMapDialog(map, settings) {
  if (!map) return;

  const b = map.getBounds();
  const bounds = {
    north: b.getNorth(),
    south: b.getSouth(),
    east: b.getEast(),
    west: b.getWest(),
  };

  const layerId = settings.mapBase || "osm";
  const def = baseLayerDef(layerId);
  const capZoom = Math.min(
    MAX_ZOOM_CAP,
    (def.options && (def.options.maxNativeZoom || def.options.maxZoom)) || MAX_ZOOM_CAP
  );
  const minZoom = Math.max(1, Math.min(Math.round(map.getZoom()), capZoom));
  let maxZoom = Math.min(minZoom + 3, capZoom);

  let downloading = false;
  let stopped = false;

  // ---- elements ----
  const nameInput = el("input", {
    type: "text",
    class: "search",
    placeholder: "Name, z. B. Karwendel",
  });

  const zoomOut = el("span", { class: "radius-out" });
  const zoomSlider = el("input", {
    type: "range",
    min: String(minZoom),
    max: String(capZoom),
    step: "1",
    value: String(maxZoom),
    class: "slider",
    oninput: (e) => {
      maxZoom = parseInt(e.target.value, 10);
      refreshEstimate();
    },
  });

  const estLine = el("p", { class: "muted small" });
  const warnLine = el("p", { class: "small", style: "margin:4px 0 0" });
  const progWrap = el("div", { class: "offline-prog", hidden: true },
    el("div", { class: "offline-bar" }, el("i")),
    el("div", { class: "muted small offline-prog-txt" }));
  const bar = progWrap.querySelector("i");
  const progTxt = progWrap.querySelector(".offline-prog-txt");

  const dlBtn = el("button", { class: "btn primary", text: "Herunterladen" });
  const cancelBtn = el("button", { class: "btn subtle", text: "Schließen" });

  function close() {
    if (downloading) return;
    window.removeEventListener("keydown", onKey);
    ovl.remove();
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }

  function refreshEstimate() {
    if (minZoom === maxZoom) zoomOut.textContent = `nur Zoom ${minZoom}`;
    else zoomOut.textContent = `Zoom ${minZoom}–${maxZoom}`;
    const n = countTiles(bounds, minZoom, maxZoom);
    const bytes = estimateBytes(layerId, n);
    estLine.textContent = `≈ ${fmtInt(n)} Kacheln · ≈ ${fmtMB(bytes)}`;
    if (n > HARD_TILE_LIMIT) {
      warnLine.textContent = `Zu groß (Limit ${fmtInt(HARD_TILE_LIMIT)} Kacheln). Kleineren Ausschnitt wählen oder weniger tief zoomen.`;
      warnLine.style.color = "var(--danger, #d1453b)";
      dlBtn.disabled = true;
    } else if (n > SOFT_TILE_LIMIT) {
      warnLine.textContent = "Großes Gebiet – der Download dauert und belastet den Kachel-Server spürbar. Bitte nur für den Eigenbedarf.";
      warnLine.style.color = "var(--warn, #b8860b)";
      dlBtn.disabled = false;
    } else {
      warnLine.textContent = "";
      dlBtn.disabled = false;
    }
  }

  async function startDownload() {
    downloading = true;
    stopped = false;
    dlBtn.disabled = true;
    zoomSlider.disabled = true;
    nameInput.disabled = true;
    cancelBtn.textContent = "Stopp";
    cancelBtn.classList.add("subtle");
    progWrap.hidden = false;

    const spec = {
      name: nameInput.value,
      layerId,
      layerDef: def,
      bounds,
      minZoom,
      maxZoom,
    };

    let region = null;
    try {
      region = await downloadRegion(spec, {
        shouldStop: () => stopped,
        onProgress: ({ done, total, stored, bytes }) => {
          const pct = total ? Math.round((done / total) * 100) : 0;
          bar.style.width = `${pct}%`;
          progTxt.textContent = `${fmtInt(done)} / ${fmtInt(total)} · ${fmtInt(stored)} gespeichert · ${fmtMB(bytes)}`;
        },
      });
    } catch (err) {
      progTxt.textContent = "Fehler beim Download: " + (err && err.message ? err.message : err);
    }

    downloading = false;
    // let the visible base layer pick up the freshly cached tiles
    map.eachLayer((ly) => ly && ly._layerId && typeof ly.redraw === "function" && ly.redraw());

    if (region) {
      bar.style.width = "100%";
      progTxt.textContent =
        (region.partial ? "Abgebrochen – " : "Fertig – ") +
        `${fmtInt(region.stored)} Kacheln (${fmtMB(region.bytes)})` +
        (region.failed ? `, ${fmtInt(region.failed)} fehlgeschlagen` : "");
    } else if (!progTxt.textContent.startsWith("Fehler")) {
      progTxt.textContent = "Nichts gespeichert (schon vorhanden oder offline).";
    }
    dlBtn.hidden = true;
    cancelBtn.textContent = "Schließen";
    cancelBtn.classList.remove("subtle");
  }

  dlBtn.onclick = startDownload;
  cancelBtn.onclick = () => {
    if (downloading) {
      stopped = true;
      cancelBtn.disabled = true;
      cancelBtn.textContent = "wird gestoppt…";
    } else {
      close();
    }
  };

  const card = el("div", { class: "mini-sheet" },
    el("div", { class: "sheet-header" },
      el("h2", { class: "sheet-title", text: "Karte offline speichern" })),
    el("div", { class: "mini-body" },
      el("p", { class: "muted small", style: "margin-top:0" },
        `Basiskarte: ${def.name}. Gespeichert wird der aktuelle Kartenausschnitt.`),
      el("label", { class: "filter-label", text: "Name" }),
      nameInput,
      el("div", { class: "row", style: "margin-top:12px" },
        el("span", { class: "filter-label" }, "Detailtiefe"), zoomSlider, zoomOut),
      estLine,
      warnLine,
      progWrap,
      el("p", { class: "muted small", style: "margin:12px 0 0" },
        "Hinweis: Die Kachel-Anbieter (OSM, OpenTopoMap, Esri) sehen Massen-Downloads nicht vor. Nur kleine, selbst genutzte Gebiete speichern.")),
    el("div", { class: "mini-foot" }, cancelBtn, dlBtn));

  const ovl = el("div", { class: "overlay", onclick: (e) => { if (e.target === ovl) close(); } }, card);
  document.body.append(ovl);
  window.addEventListener("keydown", onKey);
  refreshEstimate();
}
