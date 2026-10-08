import { el, clear, debounce } from "../dom.js";
import { parseGpxText } from "../gpx.js";
import { createElevationChart, toProfileSamples } from "../chart.js";
import { routeSvg } from "../minimap.js";
import { resolveRoutePlaces, GEOCODE_VERSION } from "../geocode.js";
import {
  fmtDistance,
  fmtElevation,
  fmtDuration,
  fmtSpeed,
  fmtDate,
  avgSpeedKmh,
  normRating,
  effectiveTitle,
  effectiveIsPlan,
  CATEGORY_LABEL,
} from "../format.js";
import { buildRouteName } from "../analyzer.js";
import { attachLayerControl } from "../mapLayers.js";
import { resolveTrackPalette, casingStyleFor } from "../trackColors.js";

/**
 * @param {object} ctx  { state, dirHandle, saveTour, refreshTours, closeDetail }
 * @param {string} fileName
 */
export async function openDetail(ctx, fileName) {
  const tour = ctx.state.tours.find((t) => t.fileName === fileName);
  if (!tour) return;

  const disposers = [];
  const overlay = el("div", { class: "overlay" });
  const sheet = el("div", { class: "sheet" });
  overlay.append(sheet);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
  document.body.classList.add("no-scroll");

  function close() {
    for (const d of disposers) {
      try {
        d();
      } catch {
        /* noop */
      }
    }
    document.removeEventListener("keydown", onKey);
    overlay.remove();
    document.body.classList.remove("no-scroll");
    ctx.closeDetail?.();
  }

  const hasLeaflet = typeof window.L !== "undefined";

  const titleInput = el("input", {
    class: "title-input",
    value: effectiveTitle(tour),
    title: "Name überschreiben – leeren für den automatischen Namen",
    oninput: debounce(async (e) => {
      const v = e.target.value.trim();
      tour.titleUser = v || null;
      await ctx.saveTour(tour);
      ctx.refreshTours?.();
    }, 400),
  });

  const mapBox = el("div", { class: "detail-map" });
  const metrics = el("div", { class: "metric-grid" });
  const chartWrap = el("div", { class: "chart-wrap" });
  const canvas = el("canvas", { class: "elev-canvas" });
  const elevTip = el("div", { class: "elev-tip", hidden: true });
  chartWrap.append(canvas, elevTip);
  const chartHint = el("div", { class: "chart-hint muted small" },
    "Zeiger über Profil oder Route: die Position wird auf beiden angezeigt (Distanz, Höhe, Zeit).");
  const placesBox = el("div", { class: "places-box" });
  const controls = el("div", { class: "detail-controls" });

  // Layout: header on top, then a body that on wide screens splits into a large
  // map pane (left) and a scrolling detail pane (right); on narrow screens it
  // stacks (tall map, everything scrolling under it).
  const detailPane = el("div", { class: "detail-pane" },
    el("h3", { text: "Kennzahlen" }),
    metrics,
    el("h3", { text: "Höhenprofil" }),
    chartWrap,
    chartHint,
    el("h3", { text: "Orte entlang der Strecke" }),
    placesBox,
    el("h3", { text: "Bearbeiten" }),
    controls
  );

  sheet.append(
    el(
      "div",
      { class: "sheet-header" },
      titleInput,
      el("button", { class: "icon-btn", text: "✕", title: "Schließen", onclick: close })
    ),
    el("div", { class: "sheet-body" }, mapBox, detailPane)
  );

  // metrics
  for (const [k, v] of [
    ["Distanz", fmtDistance(tour.distanceM)],
    ["Dauer", fmtDuration(tour.totalS)],
    ["Aufstieg", fmtElevation(tour.ascentM)],
    ["Abstieg", fmtElevation(tour.descentM)],
    ["Ø Tempo", fmtSpeed(avgSpeedKmh(tour))],
    ["Datum", fmtDate(tour.tourDate)],
  ]) {
    metrics.append(
      el("div", { class: "metric" },
        el("div", { class: "metric-k muted small" }, k),
        el("div", { class: "metric-v" }, v))
    );
  }

  // elevation chart – interactive both ways: hovering the chart moves a marker on
  // the map; hovering the route on the map moves the chart cursor + readout.
  let detailMap = null;
  let hoverMarker = null;
  let profileSamples = null; // [{d, ele, t, lat, lon}] once the full file is parsed
  const accentColor =
    getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() ||
    "#e07d21";

  const chart = createElevationChart(canvas, {
    onHover: (s) => {
      if (!s) {
        elevTip.hidden = true;
        if (hoverMarker) {
          hoverMarker.remove();
          hoverMarker = null;
        }
        return;
      }
      const bits = [`<b>${fmtDistance(s.d)}</b>`, `${fmtElevation(s.ele)}`];
      if (s.t != null && s.t > 0) bits.push(fmtDuration(s.t));
      elevTip.innerHTML = bits.join('<span class="sep">·</span>');
      elevTip.hidden = false;
      const wrapW = chartWrap.clientWidth;
      const tw = elevTip.offsetWidth;
      const left = canvas.offsetLeft + s.px - tw / 2;
      elevTip.style.left = `${Math.max(2, Math.min(wrapW - tw - 2, left))}px`;

      if (s.lat != null && detailMap && window.L) {
        if (!hoverMarker) {
          hoverMarker = window.L.circleMarker([s.lat, s.lon], {
            radius: 6,
            color: "#fff",
            weight: 2,
            fillColor: accentColor,
            fillOpacity: 1,
            interactive: false, // never steal hover events from the route hit-line
          }).addTo(detailMap);
        } else {
          hoverMarker.setLatLng([s.lat, s.lon]);
        }
      }
    },
  });
  chart.setData(tour.elevation); // offline fallback until the full file is parsed
  setTimeout(() => chart.redraw(), 60); // re-measure once the sheet has laid out
  const onResize = debounce(() => chart.redraw(), 150);
  window.addEventListener("resize", onResize);
  disposers.push(() => {
    window.removeEventListener("resize", onResize);
    chart.destroy();
  });

  // places
  renderPlaces();
  function renderPlaces() {
    clear(placesBox);
    if (tour.isSummitTour) {
      placesBox.append(
        el("p", { class: "small" },
          el("strong", { text: "Gipfel: " }),
          (tour.summitName || "—") +
            (tour.summitEle ? ` (${tour.summitEle} m)` : ""))
      );
    }
    if (tour.region) {
      placesBox.append(
        el("p", { class: "small" }, el("strong", { text: "Region: " }), tour.region)
      );
    }
    if (tour.country) {
      placesBox.append(
        el("p", { class: "small" }, el("strong", { text: "Land: " }), tour.country)
      );
    }
    if (tour.placeNames && tour.placeNames.length) {
      placesBox.append(el("p", { text: tour.placeNames.join(" · ") }));
    } else if (tour.nearPlace) {
      placesBox.append(
        el("p", { class: "muted" },
          `Keine Orte an der Strecke – nächstgelegener Ort: ${tour.nearPlace}`)
      );
    } else {
      placesBox.append(el("p", { class: "muted", text: "Noch nicht ermittelt." }));
    }
    const btn = el("button", {
      class: "btn subtle small",
      text: navigator.onLine
        ? tour.placesResolved
          ? "Orte neu ermitteln"
          : "Orte online ermitteln"
        : "Offline – nicht möglich",
      disabled: !navigator.onLine,
      onclick: async () => {
        btn.disabled = true;
        btn.textContent = "ermittle… (kann ~15 s dauern)";
        try {
          const r = await resolveRoutePlaces(tour.polyline, 12, {
            summitCoord: tour.isSummitTour ? tour.summitCoord : null,
          });
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
          await ctx.saveTour(tour);
          if (!tour.titleUser) titleInput.value = effectiveTitle(tour);
          renderPlaces();
          ctx.refreshTours?.();
        } catch {
          btn.textContent = "fehlgeschlagen";
        }
      },
    });
    placesBox.append(btn);
  }

  // edit controls
  const catSel = el(
    "select",
    {
      class: "select",
      onchange: async (e) => {
        tour.categoryUser = e.target.value || null;
        await ctx.saveTour(tour);
        ctx.refreshTours?.();
      },
    },
    el("option", { value: "" }, `Automatisch (${CATEGORY_LABEL[tour.category] || "–"})`),
    ...["cycling", "hiking", "unknown"].map((c) =>
      el("option", { value: c, selected: tour.categoryUser === c }, CATEGORY_LABEL[c])
    )
  );

  // planning flag (independent of the category)
  const planCb = el("input", {
    type: "checkbox",
    id: "is-plan",
    checked: effectiveIsPlan(tour),
    onchange: async (e) => {
      tour.isPlanUser = e.target.checked;
      await ctx.saveTour(tour);
      ctx.refreshTours?.();
      planHint.textContent = planHintText();
    },
  });
  const planHintText = () =>
    `automatisch erkannt: ${tour.isPlan ? "Planung" : "selbst aufgezeichnet"}` +
    (tour.isPlanUser === true || tour.isPlanUser === false ? " · manuell gesetzt" : "");
  const planHint = el("span", { class: "muted small" }, planHintText());
  const planRow = el("div", { class: "control-row" },
    el("label", { class: "chk", htmlFor: "is-plan" }, planCb,
      " Planung (nicht selbst gefahren – z. B. aus dem Netz oder einem Tourenplaner)"),
    planHint);

  // 5-star rating
  const rateWrap = el("div", { class: "rate" });
  const starBtns = [];
  const paintStars = () => {
    const r = normRating(tour.rating);
    starBtns.forEach((b, i) => {
      b.textContent = i < r ? "★" : "☆";
      b.classList.toggle("on", i < r);
    });
  };
  for (let i = 1; i <= 5; i++) {
    const b = el("button", {
      class: "star-btn",
      type: "button",
      title: `${i} Stern${i > 1 ? "e" : ""}`,
      onclick: async () => {
        // click the current rating again -> clear
        tour.rating = normRating(tour.rating) === i ? 0 : i;
        paintStars();
        await ctx.saveTour(tour);
        ctx.refreshTours?.();
      },
    });
    starBtns.push(b);
    rateWrap.append(b);
  }
  paintStars();

  const notes = el("textarea", {
    class: "notes",
    rows: "3",
    placeholder: "Notizen…",
    value: tour.notes || "",
    oninput: debounce(async (e) => {
      tour.notes = e.target.value;
      await ctx.saveTour(tour);
    }, 400),
  });

  const hideBtn = el("button", { class: "btn" });
  const paintHide = () => {
    hideBtn.textContent = tour.hidden ? "Wieder einblenden" : "Track ausblenden";
    hideBtn.classList.toggle("active", !!tour.hidden);
  };
  hideBtn.onclick = async () => {
    tour.hidden = !tour.hidden;
    paintHide();
    await ctx.saveTour(tour);
    ctx.refreshTours?.();
  };
  paintHide();

  controls.append(
    el("div", { class: "control-row" }, el("label", { text: "Kategorie" }), catSel),
    planRow,
    el("div", { class: "control-row" }, el("label", { text: "Bewertung" }), rateWrap),
    el("div", { class: "control-row" }, el("label", { text: "Notizen" })),
    notes,
    el(
      "div",
      { class: "control-row" },
      hideBtn,
      el("span", { class: "muted small" },
        "ausgeblendete Tracks erscheinen weder in der Liste noch auf der Karte")
    ),
    el(
      "div",
      { class: "control-row" },
      el("button", {
        class: "btn",
        text: "Original-GPX herunterladen",
        onclick: () => downloadOriginal(ctx, tour.fileName),
      }),
      el("span", { class: "muted small" }, tour.fileName)
    ),
    ctx.local
      ? el("div", { class: "control-row" },
          el("button", {
            class: "btn danger",
            text: "Tour löschen",
            onclick: async () => {
              if (!confirm(`„${effectiveTitle(tour)}“ aus der App löschen? Das Original in iCloud bleibt erhalten; ein erneuter Import holt die Tour zurück (ohne Bewertung/Notizen).`)) return;
              close();
              await ctx.deleteTour(tour.fileName);
            },
          }))
      : null
  );

  // full-resolution route + a distance/elevation/time profile from the raw points
  let fullLine = tour.polyline;
  try {
    const text = await readFile(ctx, tour.fileName);
    if (text) {
      const parsed = parseGpxText(text);
      if (parsed.points.length > 1) {
        fullLine = parsed.points.map((p) => [p.lat, p.lon]);
        const profile = toProfileSamples(parsed.points);
        if (profile) {
          profileSamples = profile;
          chart.setData(profile); // upgrades the chart (time axis, map ↔ chart sync)
        }
      }
    }
  } catch {
    /* keep the simplified line + the stored elevation-only profile */
  }

  if (hasLeaflet) {
    const mapEl = el("div", { class: "map-canvas" });
    mapBox.append(mapEl);
    requestAnimationFrame(() => {
      const map = window.L.map(mapEl, { zoomControl: true });
      detailMap = map;
      attachLayerControl(map, {
        settings: ctx.state.settings,
        save: () => ctx.saveSettings?.(),
      });
      const palette = resolveTrackPalette(ctx.state.settings);
      const routeWeight = 4;
      // white/dark casing under the route so it stays legible on relief/satellite
      window.L.polyline(fullLine, casingStyleFor(routeWeight, palette)).addTo(map);
      const line = window.L
        .polyline(fullLine, {
          color: effectiveIsPlan(tour) ? palette.plan : palette.tour,
          weight: routeWeight,
          lineCap: "round",
        })
        .addTo(map);
      try {
        map.fitBounds(line.getBounds(), { padding: [20, 20] });
      } catch {
        map.setView(tour.start || [47, 11], 12);
      }
      window.L.circleMarker(tour.start, { radius: 6, color: "#2e9e50", interactive: false }).addTo(map);
      window.L.circleMarker(tour.end, { radius: 6, color: "#d1453b", interactive: false }).addTo(map);
      setTimeout(() => map.invalidateSize(), 60);

      // hover the route on the map -> show that position in the elevation profile.
      // A wide invisible line gives a comfortable hover target; the pointer is
      // snapped to the nearest profile sample.
      if (profileSamples) {
        const hitLine = window.L
          .polyline(fullLine, { opacity: 0, weight: 22, lineCap: "round", interactive: true })
          .addTo(map);
        const syncToMap = (e) => {
          const { lat, lng } = e.latlng;
          let best = null;
          let bestDsq = Infinity;
          for (const s of profileSamples) {
            const dsq = (s.lat - lat) ** 2 + (s.lon - lng) ** 2;
            if (dsq < bestDsq) {
              bestDsq = dsq;
              best = s;
            }
          }
          if (best) chart.cursorAtDistance(best.d);
        };
        hitLine.on("mousemove", syncToMap);
        hitLine.on("click", syncToMap); // touch: a tap on the route
        hitLine.on("mouseout", () => chart.cursorAtDistance(null));
      }

      // keep the map filling its pane when the window (and thus the split) resizes
      // – invalidateSize keeps the user's current pan/zoom
      const onMapResize = debounce(() => map.invalidateSize(), 150);
      window.addEventListener("resize", onMapResize);
      disposers.push(() => {
        window.removeEventListener("resize", onMapResize);
        if (hoverMarker) hoverMarker.remove();
        hoverMarker = null;
        detailMap = null;
        map.remove();
      });
    });
  } else {
    mapBox.classList.add("svg-map");
    mapBox.innerHTML = routeSvg(fullLine, tour.bbox, 600, 300, { strokeWidth: 3 });
  }
}

async function readFile(ctx, fileName) {
  if (!ctx.dirHandle) return null;
  const fh = await ctx.dirHandle.getFileHandle(fileName);
  const file = await fh.getFile();
  return file.text();
}

async function downloadOriginal(ctx, fileName) {
  try {
    const text = await readFile(ctx, fileName);
    if (text == null) return;
    const url = URL.createObjectURL(new Blob([text], { type: "application/gpx+xml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (err) {
    alert("Konnte die Datei nicht lesen: " + err);
  }
}
