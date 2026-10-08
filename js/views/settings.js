import { el, clear } from "../dom.js";
import { fmtDate } from "../format.js";
import { supportsFileSystemAccess, supportsObserver } from "../folderAccess.js";
import { TRACK_PALETTES, resolveTrackPalette } from "../trackColors.js";
import { getRegions, clearTiles, clearRegions } from "../db.js";
import { removeRegion } from "../offlineTiles.js";
import { baseLayerDef } from "../mapLayers.js";
import { switchEl } from "./ui.js";

const fmtInt = (n) => Number(n || 0).toLocaleString("de-DE");
function fmtBytes(n) {
  const mb = n / 1048576;
  if (mb >= 100) return `${Math.round(mb)} MB`;
  if (mb >= 10) return `${mb.toFixed(0)} MB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function renderSettings(mount, ctx) {
  clear(mount);
  const { state } = ctx;
  const mobile = !!ctx.mobile;

  const row = (label, value) =>
    el("div", { class: "set-row" },
      el("span", { class: "set-k muted" }, label),
      el("span", { class: "set-v" }, value));

  const watchMode = ctx.local
    ? "manuell über „＋ Importieren“"
    : supportsObserver()
      ? "automatisch (FileSystemObserver)"
      : "beim Fensterwechsel + Button";

  const autoPlaces = el("input", {
    type: "checkbox",
    id: "auto-places",
    checked: !!state.settings.resolvePlaces,
    onchange: async (e) => {
      state.settings.resolvePlaces = e.target.checked;
      await ctx.saveSettings();
    },
  });

  // phones: an on/off switch row instead of the checkbox sentence
  const autoPlacesRow = mobile
    ? el("div", { class: "set-row set-switch" },
        el("span", { text: "Orte + Land automatisch ermitteln" }),
        switchEl({
          checked: !!state.settings.resolvePlaces,
          label: "Orte automatisch ermitteln",
          onchange: async (on) => {
            state.settings.resolvePlaces = on;
            await ctx.saveSettings();
          },
        }))
    : el("label", { class: "chk", htmlFor: "auto-places" },
        autoPlaces, " Orte + Land entlang der Strecke automatisch ermitteln (Standard: an)");

  const hiddenCount = state.tours.filter((t) => t.hidden).length;

  // Track-Farbschema: Radios mit kleiner Linien-Vorschau. Greift beim nächsten
  // Öffnen der Karten­suche / Detailansicht (die lesen die Palette beim Rendern).
  const activePaletteId = resolveTrackPalette(state.settings).id;
  const paletteOptions = TRACK_PALETTES.map((p) =>
    el("label", { class: "palette-opt" },
      el("input", {
        type: "radio",
        name: "track-palette",
        value: p.id,
        checked: p.id === activePaletteId,
        onchange: async (e) => {
          if (!e.target.checked) return;
          state.settings.trackPalette = p.id;
          await ctx.saveSettings();
        },
      }),
      el("span", { class: "palette-sw" },
        el("i", { style: `background:${p.tour}` }),
        el("i", { style: `background:${p.plan}` }),
        el("i", { style: `background:${p.select}` })),
      el("span", {},
        el("b", { text: p.name }),
        el("span", { class: "muted small", style: "display:block", text: p.hint }))));

  // Offline-Karten: asynchron befüllt (IndexedDB + storage.estimate)
  const rerender = () => renderSettings(mount, ctx);
  const offlineBody = el("div", { class: "offline-list" },
    el("p", { class: "muted small", text: "lädt…" }));

  async function populateOffline() {
    let regions = [];
    try {
      regions = await getRegions();
    } catch {
      /* store noch nicht angelegt */
    }
    let usageTxt = "";
    try {
      const est = await navigator.storage?.estimate?.();
      if (est && est.usage != null) usageTxt = fmtBytes(est.usage);
    } catch {
      /* ignore */
    }

    clear(offlineBody);
    if (usageTxt) offlineBody.append(row("App-Speicher gesamt", usageTxt));
    if (!regions.length) {
      offlineBody.append(
        el("p", { class: "muted small", text: "Noch keine Ausschnitte gespeichert." })
      );
      return;
    }
    regions.sort((a, b) => b.createdAt - a.createdAt);
    for (const r of regions) {
      const layerName = baseLayerDef(r.layerId).name;
      offlineBody.append(
        el("div", { class: "set-row offline-row" },
          el("span", { style: "min-width:0" },
            el("b", { text: r.name }),
            el("span", { class: "muted small", style: "display:block" },
              `${layerName} · Zoom ${r.minZoom}–${r.maxZoom} · ${fmtInt(r.stored)} Kacheln`
              + ` · ${fmtBytes(r.bytes)} · ${fmtDate(r.createdAt)}`
              + (r.partial ? " · Teil-Download" : ""))),
          el("button", {
            class: "btn subtle", text: "Löschen",
            onclick: async (e) => {
              e.target.disabled = true;
              const all = await getRegions();
              await removeRegion(r, all);
              rerender();
            },
          }))
      );
    }
    offlineBody.append(
      el("button", {
        class: "btn danger", style: "margin-top:10px",
        text: "Alle Offline-Karten löschen",
        onclick: async () => {
          if (!confirm("Alle heruntergeladenen Kartenausschnitte löschen?")) return;
          await clearTiles();
          await clearRegions();
          rerender();
        },
      })
    );
  }

  mount.append(
    el("div", { class: "settings" },
      el("h2", { text: "Einstellungen" }),

      el("section", { class: "card" },
        el("h3", { text: ctx.local ? "Bibliothek" : "Ordner" }),
        ctx.local && !mobile
          ? el("p", { class: "muted small",
              text: "Ohne dauerhaften Ordnerzugriff (iPhone/Safari) hält die App eigene Kopien der GPX-Dateien. Importieren ist additiv; gelöscht wird nur über „Tour löschen“ oder „Bibliothek leeren“." })
          : null,
        ctx.local ? null : row("Name", state.folderName || "–"),
        row(mobile ? "Touren" : "Indexierte Touren", String(state.tours.length)),
        row("Zuletzt aktualisiert", state.lastScan ? fmtDate(state.lastScan) : "–"),
        mobile && ctx.local ? null : row("Änderungserkennung", watchMode),
        ctx.local
          ? el("div", { class: "btn-row" },
              el("button", { class: "btn", text: "＋ GPX-Dateien importieren",
                disabled: ctx.scanStatus === "scanning",
                onclick: () => ctx.importFiles() }),
              el("button", { class: "btn danger", text: "Bibliothek leeren…",
                onclick: async () => {
                  if (confirm("Alle importierten GPX-Kopien samt Bewertungen, Titeln und Notizen löschen? Die Originale in iCloud bleiben unberührt.")) {
                    await ctx.clearLibrary();
                  }
                } }))
          : el("div", { class: "btn-row" },
              el("button", { class: "btn", text: "Jetzt neu indexieren",
                disabled: ctx.scanStatus === "scanning",
                onclick: () => ctx.rescan() }),
              el("button", { class: "btn subtle", text: "Anderen Ordner wählen…",
                onclick: () => ctx.changeFolder() })),
        ctx.local && mobile
          ? el("p", { class: "muted small",
              text: "Die App hält eigene Kopien der GPX-Dateien. Importieren ergänzt nur; die Originale in iCloud bleiben unberührt." })
          : null),

      ctx.mobileCapable
        ? el("section", { class: "card" },
            el("h3", { text: "Darstellung" }),
            el("div", { class: "set-row set-switch" },
              el("span", { text: "Handy-Ansicht" }),
              switchEl({
                checked: state.settings.mobileUi !== false,
                label: "Handy-Ansicht",
                onchange: (on) => ctx.setMobileUi(on),
              })),
            el("p", { class: "muted small",
              text: "Tab-Leiste unten, Vollbild-Karte mit „Touren im Ausschnitt“, Filter als Schnellwahl. Aus = klassische Ansicht wie am Computer (mit Umkreissuche und Mehrfachauswahl)." }))
        : null,

      el("section", { class: "card" },
        el("h3", { text: "Orte" }),
        autoPlacesRow,
        el("p", { class: "muted small",
          text: "Startet direkt nach dem ersten Indexieren. Nutzt OpenStreetMap/Nominatim, läuft gedrosselt im Hintergrund, nur online. Asiatische Namen werden latinisiert." })),

      el("section", { class: "card" },
        el("h3", { text: "Track-Farben" }),
        el("p", { class: "muted small",
          text: "Farbschema der Routenlinien in der Kartensuche und der Detailansicht (Tour · Planung · ausgewählt). Jede Linie bekommt zusätzlich einen hellen bzw. dunklen Rand, damit sie sich auch auf Relief- und Satellitenkarten klar abhebt." }),
        ...paletteOptions),

      el("section", { class: "card" },
        el("h3", { text: "Offline-Karten" }),
        el("p", { class: "muted small",
          text: (mobile
            ? "Heruntergeladene Kartenausschnitte für unterwegs ohne Netz. Neue Ausschnitte: in einer Tour „Karte offline“ oder auf der Karte über den Ebenen-Knopf."
            : "Heruntergeladene Kartenausschnitte für die Nutzung ohne Internet. Neue Ausschnitte lädst du über „Offline-Karte“ in der Kartensuche.")
            + " Nur kleine, selbst genutzte Gebiete – die Kachel-Anbieter (OSM, OpenTopoMap, Esri) sehen Massen-Downloads nicht vor." }),
        offlineBody),

      el("section", { class: "card" },
        el("h3", { text: "Ausgeblendete Tracks" }),
        row("Anzahl", String(hiddenCount)),
        hiddenCount
          ? el("button", { class: "btn", text: "Alle wieder einblenden",
              onclick: () => ctx.unhideAll() })
          : el("p", { class: "muted small",
              text: mobile
                ? "Ausblenden geht in einer Tour unter „Bearbeiten“."
                : "Ausblenden geht in der Detailansicht oder über das Augen-Symbol in der Liste." })),

      ...advanced(
      el("section", { class: "card" },
        el("h3", { text: "Index" }),
        el("button", { class: "btn danger", text: "Index zurücksetzen",
          onclick: async () => {
            if (confirm("Alle gespeicherten Metadaten (inkl. Bewertungen, Titel, Notizen) löschen? Die GPX-Dateien bleiben unberührt und werden neu eingelesen.")) {
              await ctx.resetIndex();
            }
          } }),
        el("p", { class: "muted small",
          text: "Löscht nur den lokalen Index (IndexedDB), nicht deine Dateien." })),

      el("section", { class: "card" },
        el("h3", { text: "Umgebung" }),
        row("File System Access API", supportsFileSystemAccess()
          ? (ctx.local ? "verfügbar (lokale Bibliothek erzwungen)" : "verfügbar")
          : "fehlt – lokale Bibliothek aktiv"),
        row("Als App installiert",
          window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone ? "ja" : "nein"),
        row("Karte", typeof window.L !== "undefined" ? "Leaflet geladen" : "offline / nicht geladen"),
        row("Online", navigator.onLine ? "ja" : "nein")))
    )
  );

  function advanced(...cards) {
    if (!mobile) return cards;
    return [el("details", { class: "card madv" },
      el("summary", { text: "Erweitert" }),
      ...cards)];
  }

  populateOffline();
}
