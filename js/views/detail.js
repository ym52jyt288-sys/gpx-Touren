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
  fmtDateLong,
  avgSpeedKmh,
  normRating,
  effectiveTitle,
  effectiveIsPlan,
  effectiveCategory,
  shortTitle,
  CATEGORY_LABEL,
  CATEGORY_COLOR,
} from "../format.js";
import { buildRouteName } from "../analyzer.js";
import { attachLayerControl } from "../mapLayers.js";
import { resolveTrackPalette, casingStyleFor } from "../trackColors.js";
import { icon } from "../icons.js";
import { switchEl, toast } from "./ui.js";
import { openLayerSheet } from "./layerSheet.js";
import { openOfflineMapDialog } from "./offlineDialog.js";

/**
 * Tour detail. Desktop: modal sheet (map + scrolling detail pane). Phones
 * (ctx.mobile): a full-screen page – map fixed on top, content scrolling below,
 * closed by the back button or the system back gesture.
 *
 * @param {object} ctx  { state, dirHandle, saveTour, refreshTours, closeDetail, mobile }
 * @param {string} fileName
 */
export async function openDetail(ctx, fileName) {
  const tour = ctx.state.tours.find((t) => t.fileName === fileName);
  if (!tour) return;
  const mobile = !!ctx.mobile;

  const disposers = [];
  const overlay = el("div", { class: mobile ? "overlay mdetail-page" : "overlay" });
  const sheet = el("div", { class: mobile ? "sheet mdetail" : "sheet" });
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

  // phones: the back gesture / Android back button closes the page instead of
  // leaving the app
  let historyPushed = false;
  const onPop = () => {
    historyPushed = false;
    close();
  };
  if (mobile) {
    try {
      history.pushState({ gpxDetail: fileName }, "");
      historyPushed = true;
      window.addEventListener("popstate", onPop);
    } catch {
      /* noop */
    }
  }

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    for (const d of disposers) {
      try {
        d();
      } catch {
        /* noop */
      }
    }
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("popstate", onPop);
    if (historyPushed) {
      historyPushed = false;
      history.back();
    }
    if (mobile) {
      overlay.classList.add("closing");
      setTimeout(() => overlay.remove(), 200);
    } else {
      overlay.remove();
    }
    document.body.classList.remove("no-scroll");
    ctx.closeDetail?.();
  }

  const hasLeaflet = typeof window.L !== "undefined";
  const persist = async () => {
    await ctx.saveTour(tour);
    ctx.refreshTours?.();
  };

  const mapBox = el("div", { class: "detail-map" });
  const chartWrap = el("div", { class: "chart-wrap" });
  const canvas = el("canvas", { class: "elev-canvas" });
  const elevTip = el("div", { class: "elev-tip", hidden: true });
  chartWrap.append(canvas, elevTip);
  const placesBox = el("div", { class: "places-box" });

  // filled by the layout builders
  let titleInput = null; // desktop: editable heading
  let refreshHeading = () => {};
  let detailMap = null;
  let hoverMarker = null;
  let profileSamples = null; // [{d, ele, t, lat, lon}] once the full file is parsed
  let gpxText = null; // kept for "share" – iOS needs navigator.share() right in the tap
  let mapLayersApi = null;
  let restyleRoute = () => {};
  let frameRoute = null;
  let sheetCover = null; // phones: () => px of the map hidden under the content panel
  let onSheetChange = null; // phones: the panel moved – keep the route in view

  if (mobile) buildMobile();
  else buildDesktop();

  // ---- desktop layout ------------------------------------------------
  function buildDesktop() {
    titleInput = el("input", {
      class: "title-input",
      value: effectiveTitle(tour),
      title: "Name überschreiben – leeren für den automatischen Namen",
      oninput: debounce(async (e) => {
        const v = e.target.value.trim();
        tour.titleUser = v || null;
        await persist();
      }, 400),
    });
    refreshHeading = () => {
      if (!tour.titleUser) titleInput.value = effectiveTitle(tour);
    };

    const metrics = el("div", { class: "metric-grid" });
    const chartHint = el("div", { class: "chart-hint muted small" },
      "Zeiger über Profil oder Route: die Position wird auf beiden angezeigt (Distanz, Höhe, Zeit).");
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

    // edit controls
    const catSel = el(
      "select",
      {
        class: "select",
        onchange: async (e) => {
          tour.categoryUser = e.target.value || null;
          await persist();
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
        await persist();
        planHint.textContent = planHintText(tour);
      },
    });
    const planHint = el("span", { class: "muted small" }, planHintText(tour));
    const planRow = el("div", { class: "control-row" },
      el("label", { class: "chk", htmlFor: "is-plan" }, planCb,
        " Planung (nicht selbst gefahren – z. B. aus dem Netz oder einem Tourenplaner)"),
      planHint);

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
      await persist();
    };
    paintHide();

    controls.append(
      el("div", { class: "control-row" }, el("label", { text: "Kategorie" }), catSel),
      planRow,
      el("div", { class: "control-row" }, el("label", { text: "Bewertung" }), ratingStars()),
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
              onclick: deleteTour,
            }))
        : null
    );
  }

  // ---- phone layout --------------------------------------------------
  function buildMobile() {
    // map: fills the page; the content panel lies over its lower part as a
    // sheet with two rest positions – "half" (default) and "down" (only the
    // grab handle peeks out, the whole map is free). The enlarge button, a tap
    // on the handle or a swipe on the panel switch between them.
    const expandBtn = el("button", {
      type: "button", class: "mdetail-fab", "aria-label": "Karte vergrößern", html: icon("expand", 18),
      onclick: () => setSheet(!sheetDown),
    });
    mapBox.append(
      el("button", {
        type: "button", class: "mdetail-fab mdetail-back", "aria-label": "Zurück",
        html: icon("chevronLeft", 24), onclick: close,
      }),
      el("div", { class: "mdetail-tools" },
        el("button", {
          type: "button", class: "mdetail-fab", "aria-label": "Kartenstil und Ebenen", html: icon("layers", 20),
          onclick: () => {
            if (!detailMap || !mapLayersApi) return;
            openLayerSheet({
              map: detailMap,
              layers: mapLayersApi,
              settings: ctx.state.settings,
              save: () => ctx.saveSettings?.(),
              onPalette: () => restyleRoute(),
            });
          },
        }),
        expandBtn));

    // heading: name, category · date, region, rating
    const head = el("div", { class: "mdetail-head" });
    const stars = ratingStars();
    refreshHeading = () => {
      const cat = effectiveCategory(tour);
      const where = [tour.region, tour.country].filter(Boolean).join(" · ");
      head.replaceChildren(...[
        el("h1", { class: "mdetail-title", text: shortTitle(tour) }),
        el("div", { class: "mdetail-meta" },
          el("i", { class: "cdot", style: `--c:${CATEGORY_COLOR[cat]}` }),
          el("span", { text: `${CATEGORY_LABEL[cat]} · ${fmtDateLong(tour.tourDate)}` }),
          effectiveIsPlan(tour) ? el("span", { class: "mtag plan", text: "Planung" }) : null,
          tour.hidden ? el("span", { class: "mtag", text: "ausgeblendet" }) : null),
        where ? el("div", { class: "mdetail-where", text: where }) : null,
        stars,
      ].filter(Boolean));
    };
    refreshHeading();

    // key figures: three big numbers + a quiet second line
    const timed = tour.totalS > 0;
    const prim = [
      ["Distanz", fmtDistance(tour.distanceM)],
      ["Aufstieg", fmtElevation(tour.ascentM)],
      timed ? ["Dauer", fmtDuration(tour.totalS)] : ["Abstieg", fmtElevation(tour.descentM)],
    ];
    const speed = avgSpeedKmh(tour);
    const sub = [
      timed ? `↓ ${fmtElevation(tour.descentM)}` : null,
      speed > 0 ? `Ø ${fmtSpeed(speed)}` : null,
      Number.isFinite(tour.maxEleM) ? `höchster Punkt ${fmtElevation(tour.maxEleM)}` : null,
    ].filter(Boolean);
    // "6,8 km" -> big number, small unit
    const statValue = (v) => {
      const m = /^(.*\S)\s+(\S+)$/.exec(v);
      return m
        ? el("div", { class: "mstat-v" }, m[1], el("small", { text: ` ${m[2]}` }))
        : el("div", { class: "mstat-v", text: v });
    };
    const stats = el("div", { class: "mstats" },
      ...prim.map(([k, v]) =>
        el("div", { class: "mstat" }, statValue(v), el("div", { class: "mstat-k", text: k }))));

    // quick actions
    const canShare = canShareGpx();
    const actions = el("div", { class: "mactions" },
      el("button", {
        type: "button", class: "mact",
        html: icon(canShare ? "share" : "download", 20) + `<span>${canShare ? "GPX teilen" : "GPX laden"}</span>`,
        onclick: () => shareGpx(),
      }),
      el("button", {
        type: "button", class: "mact", disabled: !hasLeaflet,
        html: icon("offline", 20) + "<span>Karte offline</span>",
        onclick: () => detailMap && openOfflineMapDialog(detailMap, ctx.state.settings),
      }));

    // edit group (grouped list)
    const nameInput = el("input", {
      class: "mcell-input",
      value: tour.titleUser || "",
      placeholder: effectiveTitle({ ...tour, titleUser: null }),
      enterkeyhint: "done",
      oninput: debounce(async (e) => {
        tour.titleUser = e.target.value.trim() || null;
        refreshHeading();
        await persist();
      }, 400),
      onkeydown: (e) => {
        if (e.key === "Enter") e.target.blur();
      },
    });
    const catSel = el("select", {
      class: "mcell-select",
      onchange: async (e) => {
        tour.categoryUser = e.target.value || null;
        refreshHeading();
        await persist();
      },
    },
    el("option", { value: "" }, `Automatisch (${CATEGORY_LABEL[tour.category] || "–"})`),
    ...["cycling", "hiking", "unknown"].map((c) =>
      el("option", { value: c, selected: tour.categoryUser === c }, CATEGORY_LABEL[c])));
    const planCaption = el("span", { class: "mcell-sub", text: planHintText(tour) });
    const notes = el("textarea", {
      class: "mcell-notes",
      rows: "3",
      placeholder: "Notizen zur Tour…",
      value: tour.notes || "",
      oninput: debounce(async (e) => {
        tour.notes = e.target.value;
        await ctx.saveTour(tour);
      }, 400),
    });
    const placesBtn = el("button", {
      type: "button", class: "mcell mcell-btn accent",
      onclick: () => resolvePlacesNow(placesBtn.querySelector(".mcell-k")),
    }, el("span", { class: "mcell-k", text: placesButtonText() }));
    placesBtn.disabled = !navigator.onLine;

    const edit = el("div", { class: "mgroup" },
      el("label", { class: "mcell mcell-col" },
        el("span", { class: "mcell-sub", text: "Name – leer lassen für den automatischen" }), nameInput),
      el("label", { class: "mcell" }, el("span", { class: "mcell-k", text: "Kategorie" }), catSel),
      el("div", { class: "mcell" },
        el("span", { class: "mcell-k" }, "Planung", planCaption),
        switchEl({
          checked: effectiveIsPlan(tour), label: "Planung",
          onchange: async (on) => {
            tour.isPlanUser = on;
            planCaption.textContent = planHintText(tour);
            refreshHeading();
            await persist();
          },
        })),
      el("div", { class: "mcell" },
        el("span", { class: "mcell-k" }, "Ausblenden",
          el("span", { class: "mcell-sub", text: "nicht in Liste und Karte zeigen" })),
        switchEl({
          checked: !!tour.hidden, label: "Ausblenden",
          onchange: async (on) => {
            tour.hidden = on;
            refreshHeading();
            await persist();
          },
        })),
      el("label", { class: "mcell mcell-col" }, el("span", { class: "mcell-sub", text: "Notizen" }), notes));

    const more = el("div", { class: "mgroup" },
      placesBtn,
      ctx.local
        ? el("button", { type: "button", class: "mcell mcell-btn danger", onclick: deleteTour },
            el("span", { class: "mcell-k", text: "Tour löschen" }))
        : null);

    const scroller = el("div", { class: "mdetail-scroll" },
        head,
        stats,
        sub.length ? el("div", { class: "mstats-sub", text: sub.join(" · ") }) : null,
        actions,
        el("section", { class: "msec" },
          el("h2", { class: "msec-h", text: "Höhenprofil" }),
          chartWrap,
          el("p", { class: "chart-hint muted small", text: "Antippen oder wischen – die Stelle erscheint auf der Karte." })),
        el("section", { class: "msec" },
          el("h2", { class: "msec-h", text: "Orte entlang der Strecke" }),
          placesBox),
        el("section", { class: "msec" },
          el("h2", { class: "msec-h", text: "Bearbeiten" }),
          edit,
          more,
          el("p", { class: "mfile muted small", text: tour.fileName })));
    const grab = el("button", {
      type: "button", class: "mdetail-grab", "aria-label": "Details ausblenden",
      onclick: () => setSheet(!sheetDown),
    }, el("span", { class: "mdetail-grab-bar" }));
    const panel = el("div", { class: "mdetail-panel" }, grab, scroller);
    // measures the peeking strip (CSS --peek includes the home-indicator inset)
    const peekProbe = el("div", { class: "mdetail-peek-probe", "aria-hidden": "true" });
    sheet.append(mapBox, panel, peekProbe);

    let sheetDown = false;
    const downOffset = () => Math.max(0, panel.offsetHeight - peekProbe.offsetHeight);
    // px of the map hidden under the panel in its resting position
    sheetCover = () => sheet.clientHeight - panel.offsetTop - (sheetDown ? downOffset() : 0);
    function setSheet(down) {
      if (down === sheetDown) return;
      const coverBefore = sheetCover();
      sheetDown = down;
      sheet.classList.toggle("sheet-down", down);
      scroller.inert = down;
      expandBtn.innerHTML = icon(down ? "shrink" : "expand", 18);
      expandBtn.setAttribute("aria-label", down ? "Details einblenden" : "Karte vergrößern");
      grab.setAttribute("aria-label", down ? "Details einblenden" : "Details ausblenden");
      onSheetChange?.(coverBefore);
    }

    // swipe: down on the panel (scrolled to its top) or on the handle hides it,
    // up brings it back. Decided on the first move so native scrolling wins
    // everywhere else.
    let drag = null;
    panel.addEventListener("touchstart", (e) => {
      drag = e.touches.length === 1
        ? { x0: e.touches[0].clientX, y0: e.touches[0].clientY, target: e.target, active: false, decided: false }
        : null;
    }, { passive: true });
    panel.addEventListener("touchmove", (e) => {
      if (!drag) return;
      const t = e.touches[0];
      const dx = t.clientX - drag.x0;
      const dy = t.clientY - drag.y0;
      if (!drag.decided) {
        if (dx === 0 && dy === 0) return;
        drag.decided = true;
        const vertical = Math.abs(dy) > Math.abs(dx);
        const onGrab = grab.contains(drag.target);
        const inChart = !!drag.target.closest?.(".chart-wrap, textarea");
        drag.active = vertical && (sheetDown || onGrab || (dy > 0 && scroller.scrollTop <= 0 && !inChart));
        if (!drag.active) {
          drag = null;
          return;
        }
        drag.base = sheetDown ? downOffset() : 0;
        drag.max = downOffset();
        drag.samples = [];
        panel.style.transition = "none";
      }
      e.preventDefault();
      let y = drag.base + dy;
      if (y < 0) y *= 0.25; // pulled up past the top: give way a little
      y = Math.min(y, drag.max);
      drag.y = y;
      drag.samples.push([e.timeStamp, t.clientY]);
      if (drag.samples.length > 6) drag.samples.shift();
      panel.style.transform = `translateY(${y}px)`;
    }, { passive: false });
    const endDrag = (e) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (!d.active) return;
      if (e.type === "touchend") e.preventDefault(); // no click on the handle after a swipe
      let v = 0; // px per ms, + = downwards
      const s = d.samples;
      if (s.length > 1) {
        const [t0, y0] = s[0];
        const [t1, y1] = s[s.length - 1];
        if (t1 - t0 > 0 && e.timeStamp - t1 < 120) v = (y1 - y0) / (t1 - t0);
      }
      const down = e.type === "touchcancel"
        ? sheetDown
        : Math.abs(v) > 0.3 ? v > 0 : (d.y ?? d.base) > d.max / 2;
      panel.style.transition = "";
      panel.style.transform = "";
      if (down !== sheetDown) setSheet(down);
    };
    panel.addEventListener("touchend", endDrag);
    panel.addEventListener("touchcancel", endDrag);
  }

  // ---- shared pieces ----------------------------------------------------

  function ratingStars() {
    const wrap = el("div", { class: "rate" });
    const btns = [];
    const paint = () => {
      const r = normRating(tour.rating);
      btns.forEach((b, i) => {
        b.textContent = i < r ? "★" : "☆";
        b.classList.toggle("on", i < r);
      });
    };
    for (let i = 1; i <= 5; i++) {
      const b = el("button", {
        class: "star-btn",
        type: "button",
        title: `${i} Stern${i > 1 ? "e" : ""}`,
        "aria-label": `${i} Stern${i > 1 ? "e" : ""}`,
        onclick: async () => {
          // tap the current rating again -> clear
          tour.rating = normRating(tour.rating) === i ? 0 : i;
          paint();
          await persist();
        },
      });
      btns.push(b);
      wrap.append(b);
    }
    paint();
    return wrap;
  }

  async function deleteTour() {
    if (!confirm(`„${effectiveTitle(tour)}“ aus der App löschen? Das Original in iCloud bleibt erhalten; ein erneuter Import holt die Tour zurück (ohne Bewertung/Notizen).`)) return;
    close();
    await ctx.deleteTour(tour.fileName);
  }

  function canShareGpx() {
    try {
      return !!(navigator.canShare && navigator.canShare({ files: [gpxFile("<gpx/>")] }));
    } catch {
      return false;
    }
  }

  function gpxFile(text) {
    return new File([text], tour.fileName, { type: "application/gpx+xml" });
  }

  async function shareGpx() {
    if (gpxText != null && canShareGpx()) {
      try {
        // no await before this call – iOS only shares from inside the tap
        await navigator.share({ files: [gpxFile(gpxText)], title: shortTitle(tour) });
        return;
      } catch (err) {
        if (err && err.name === "AbortError") return; // user closed the share sheet
      }
    }
    downloadOriginal(ctx, tour.fileName, gpxText);
  }

  // elevation chart – interactive both ways: hovering the chart moves a marker on
  // the map; hovering the route on the map moves the chart cursor + readout.
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
    if (mobile) return; // phones: the button sits in the "Bearbeiten" group
    const btn = el("button", {
      class: "btn subtle small",
      text: placesButtonText(),
      disabled: !navigator.onLine,
      onclick: () => resolvePlacesNow(btn),
    });
    placesBox.append(btn);
  }

  function placesButtonText() {
    return navigator.onLine
      ? tour.placesResolved
        ? "Orte neu ermitteln"
        : "Orte online ermitteln"
      : "Orte ermitteln – offline nicht möglich";
  }

  async function resolvePlacesNow(labelEl) {
    const btn = labelEl.closest("button") || labelEl;
    btn.disabled = true;
    labelEl.textContent = "ermittle… (kann ~15 s dauern)";
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
      refreshHeading();
      renderPlaces();
      if (mobile) {
        labelEl.textContent = placesButtonText();
        btn.disabled = !navigator.onLine;
        toast("Orte aktualisiert");
      }
      ctx.refreshTours?.();
    } catch {
      labelEl.textContent = "fehlgeschlagen – nochmal versuchen";
      btn.disabled = false;
    }
  }

  // full-resolution route + a distance/elevation/time profile from the raw points
  let fullLine = tour.polyline;
  try {
    const text = await readFile(ctx, tour.fileName);
    if (text) {
      gpxText = text;
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
  if (closed) return; // closed while the file was loading

  if (hasLeaflet) {
    const mapEl = el("div", { class: "map-canvas" });
    mapBox.append(mapEl);
    requestAnimationFrame(() => {
      if (closed) return;
      const map = window.L.map(mapEl, { zoomControl: !mobile });
      detailMap = map;
      mapLayersApi = attachLayerControl(map, {
        settings: ctx.state.settings,
        save: () => ctx.saveSettings?.(),
        control: !mobile, // phones use the layer sheet instead
      });
      const routeWeight = mobile ? 5 : 4;
      let palette = resolveTrackPalette(ctx.state.settings);
      // white/dark casing under the route so it stays legible on relief/satellite
      const casing = window.L.polyline(fullLine, casingStyleFor(routeWeight, palette)).addTo(map);
      const line = window.L
        .polyline(fullLine, {
          color: effectiveIsPlan(tour) ? palette.plan : palette.tour,
          weight: routeWeight,
          lineCap: "round",
        })
        .addTo(map);
      restyleRoute = () => {
        palette = resolveTrackPalette(ctx.state.settings);
        casing.setStyle(casingStyleFor(routeWeight, palette));
        line.setStyle({ color: effectiveIsPlan(tour) ? palette.plan : palette.tour });
      };
      // phones: the map runs under the content panel – frame the route in the
      // part that stays visible
      let userMoved = false;
      frameRoute = () => {
        try {
          if (sheetCover) {
            map.fitBounds(line.getBounds(), {
              paddingTopLeft: [28, 28],
              paddingBottomRight: [28, sheetCover() + 28],
            });
          } else {
            map.fitBounds(line.getBounds(), { padding: mobile ? [28, 28] : [20, 20] });
          }
        } catch {
          map.setView(tour.start || [47, 11], 12);
        }
        userMoved = false;
      };
      frameRoute();
      if (mobile) {
        map.on("dragstart", () => (userMoved = true));
        mapEl.addEventListener("touchstart", (e) => {
          if (e.touches.length > 1) userMoved = true; // pinch zoom
        }, { passive: true });
        map.on("dblclick", () => (userMoved = true));
        // untouched map: re-frame the route for the new visible area; otherwise
        // keep what was in the middle of the visible part in the middle
        onSheetChange = (coverBefore) => {
          if (!userMoved) frameRoute();
          else map.panBy([0, (sheetCover() - coverBefore) / 2]);
        };
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
  } else if (mobile) {
    mapBox.append(el("div", {
      class: "map-canvas svg-map",
      html: routeSvg(fullLine, tour.bbox, 600, 300, { strokeWidth: 3 }),
    }));
  } else {
    mapBox.classList.add("svg-map");
    mapBox.innerHTML = routeSvg(fullLine, tour.bbox, 600, 300, { strokeWidth: 3 });
  }
}

function planHintText(tour) {
  return (
    `automatisch erkannt: ${tour.isPlan ? "Planung" : "selbst aufgezeichnet"}` +
    (tour.isPlanUser === true || tour.isPlanUser === false ? " · manuell gesetzt" : "")
  );
}

async function readFile(ctx, fileName) {
  if (!ctx.dirHandle) return null;
  const fh = await ctx.dirHandle.getFileHandle(fileName);
  const file = await fh.getFile();
  return file.text();
}

async function downloadOriginal(ctx, fileName, knownText = null) {
  try {
    const text = knownText != null ? knownText : await readFile(ctx, fileName);
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
