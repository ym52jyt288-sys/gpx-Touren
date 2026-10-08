// Tour list for phones: sticky search + quick-filter chips, tours grouped by
// year with per-year sums, slim two-line rows. Filter state is shared with the
// map (state.filter); the full filter set lives in a bottom sheet.

import { el, clear, debounce } from "../dom.js";
import {
  matchesFilter,
  sortTours,
  activeFilterCount,
  resetFilter,
  groupToursByYear,
  rangeToDates,
  SORTS,
} from "../filter.js";
import {
  fmtDistance,
  fmtTotalDistance,
  fmtElevation,
  fmtDuration,
  fmtDate,
  fmtDateShort,
  effectiveCategory,
  effectiveIsPlan,
  shortTitle,
  normRating,
  CATEGORY_LABEL,
  CATEGORY_COLOR,
} from "../format.js";
import { routeSvg } from "../minimap.js";
import { icon } from "../icons.js";
import { chip } from "./ui.js";
import { openFilterSheet, openSortSheet } from "./filterSheet.js";

export function renderMobileList(mount, ctx) {
  clear(mount);
  const { state } = ctx;
  const f = state.filter;

  // ---- search ----------------------------------------------------
  const input = el("input", {
    type: "search",
    class: "msearch-input",
    placeholder: "Touren, Orte, Länder",
    value: f.text,
    enterkeyhint: "search",
    autocomplete: "off",
    autocorrect: "off",
    autocapitalize: "off",
    spellcheck: false,
    oninput: debounce((e) => {
      f.text = e.target.value;
      clearBtn.hidden = !f.text;
      renderChips();
      renderBody();
    }, 160),
    onkeydown: (e) => {
      if (e.key === "Enter") e.target.blur();
    },
  });
  const clearBtn = el("button", {
    type: "button",
    class: "msearch-clear",
    "aria-label": "Suche leeren",
    html: icon("x", 14),
    hidden: !f.text,
    onclick: () => {
      input.value = "";
      f.text = "";
      clearBtn.hidden = true;
      renderChips();
      renderBody();
    },
  });
  const search = el("label", { class: "msearch" }, el("span", { class: "msearch-ico", html: icon("search", 18) }), input, clearBtn);

  const chips = el("div", { class: "mchips" });
  const toolbar = el("div", { class: "mlist-toolbar" }, search, chips);
  const body = el("div", { class: "mlist-body" });
  mount.append(el("div", { class: "mlist" }, toolbar, body));

  // dragging the list dismisses the keyboard (as native lists do)
  body.addEventListener("touchstart", () => {
    if (document.activeElement === input) input.blur();
  }, { passive: true });

  const refresh = () => {
    renderChips();
    renderBody();
  };

  // ---- quick-filter chips --------------------------------------
  function renderChips() {
    const n = activeFilterCount(f);
    const quick = [
      {
        label: CATEGORY_LABEL.cycling,
        on: f.categories.has("cycling"),
        toggle: () => toggleSet(f.categories, "cycling"),
      },
      {
        label: CATEGORY_LABEL.hiking,
        on: f.categories.has("hiking"),
        toggle: () => toggleSet(f.categories, "hiking"),
      },
      {
        label: "Planungen",
        on: f.plan === "only",
        toggle: () => (f.plan = f.plan === "only" ? "" : "only"),
      },
      {
        label: "4★ +",
        on: f.minRating === 4,
        toggle: () => (f.minRating = f.minRating === 4 ? 0 : 4),
      },
      {
        label: "12 Monate",
        on: f.range === "12m",
        toggle: () => {
          f.range = f.range === "12m" ? "" : "12m";
          Object.assign(f, rangeToDates(f.range));
        },
      },
    ];
    chips.replaceChildren(...[
      chip({
        label: "Filter",
        iconName: "filter",
        badge: n,
        on: n > 0,
        onclick: () => openFilterSheet(state, { onChange: refreshFromSheet }),
      }),
      chip({
        label: (SORTS[state.sort] || SORTS.dateDesc).short,
        iconName: "sort",
        onclick: () => openSortSheet(state, refresh),
      }),
      el("span", { class: "mchips-sep" }),
      ...quick.map((q) =>
        chip({
          label: q.label,
          on: q.on,
          onclick: () => {
            q.toggle();
            refresh();
          },
        })
      ),
      n || f.text
        ? chip({
            label: "Zurücksetzen",
            iconName: "x",
            className: "ghost",
            onclick: () => {
              resetFilter(f, { keepText: false });
              input.value = "";
              clearBtn.hidden = true;
              refresh();
            },
          })
        : null,
    ].filter(Boolean));
  }

  // the sheet may clear the search text – keep the field in sync
  function refreshFromSheet() {
    if (input.value !== f.text) {
      input.value = f.text;
      clearBtn.hidden = !f.text;
    }
    refresh();
  }

  // ---- body ------------------------------------------------------
  function renderBody() {
    clear(body);
    const all = state.tours;

    if (!all.length) {
      body.append(emptyState(
        ctx.scanStatus === "scanning" ? "Touren werden eingelesen…" : "Noch keine Touren",
        ctx.local ? "Importiere die GPX-Exporte aus APE@MAP." : "Den Ordner neu einlesen.",
        ctx.scanStatus === "scanning"
          ? null
          : ctx.local
            ? { label: "GPX importieren", onclick: () => ctx.importFiles() }
            : { label: "Neu einlesen", onclick: () => ctx.rescan() }
      ));
      return;
    }

    const visible = sortTours(all.filter((t) => matchesFilter(t, f)), state.sort);
    if (!visible.length) {
      body.append(emptyState("Keine Treffer", "Keine Tour passt zu Suche und Filter.", {
        label: "Filter zurücksetzen",
        onclick: () => {
          resetFilter(f, { keepText: false });
          input.value = "";
          clearBtn.hidden = true;
          refresh();
        },
      }));
      return;
    }

    const filtered = visible.length !== all.length;
    const sumKm = visible.reduce((s, t) => s + (t.distanceM || 0), 0);
    const sumUp = visible.reduce((s, t) => s + (t.ascentM || 0), 0);
    const hiddenCount = f.showHidden ? 0 : all.filter((t) => t.hidden).length;
    body.append(el("div", { class: "msummary" },
      (filtered
        ? `${visible.length} von ${all.length} Touren`
        : `${all.length} ${all.length === 1 ? "Tour" : "Touren"}`) +
        ` · ${fmtTotalDistance(sumKm)} · ↑ ${fmtElevation(sumUp)}` +
        (hiddenCount ? ` · ${hiddenCount} ausgeblendet` : "")));

    const byDate = state.sort === "dateDesc" || state.sort === "dateAsc";
    const open = (t) => ctx.openDetail(t.fileName);
    if (byDate) {
      for (const g of groupToursByYear(visible)) {
        body.append(el("section", { class: "msection" },
          el("div", { class: "msection-head" },
            el("span", { class: "msection-year", text: g.year == null ? "Ohne Datum" : String(g.year) }),
            el("span", { class: "msection-sum",
              text: `${g.tours.length} ${g.tours.length === 1 ? "Tour" : "Touren"} · ${fmtTotalDistance(g.distanceM)}` })),
          el("div", { class: "mgroup" }, ...g.tours.map((t) => mobileTourRow(t, () => open(t), { yearShown: true })))));
      }
    } else {
      body.append(el("div", { class: "mgroup" }, ...visible.map((t) => mobileTourRow(t, () => open(t)))));
    }
  }

  refresh();
  // background updates (place names arriving, edits in the detail page) only
  // redraw the rows – keeps scroll position, focus and the open keyboard
  mount._softRefresh = refresh;
}

/**
 * One tour as a slim two-line row. Shared with the mobile map's sheet.
 * @param {object} tour
 * @param {() => void} onOpen
 * @param {{yearShown?: boolean}} [opts]  the date drops the year under a year heading
 */
export function mobileTourRow(tour, onOpen, { yearShown = false } = {}) {
  const cat = effectiveCategory(tour);
  const color = CATEGORY_COLOR[cat];
  const rating = normRating(tour.rating);
  const meta = [
    CATEGORY_LABEL[cat],
    yearShown ? fmtDateShort(tour.tourDate) : fmtDate(tour.tourDate),
    tour.country || "",
  ].filter(Boolean);

  return el("button", {
    type: "button",
    class: "mrow" + (tour.hidden ? " is-hidden" : ""),
    onclick: onOpen,
  },
  el("span", {
    class: "mrow-thumb",
    html: routeSvg(tour.polyline, tour.bbox, 52, 52, { stroke: color, strokeWidth: 2.2 }),
  }),
  el("span", { class: "mrow-main" },
    el("span", { class: "mrow-title", text: shortTitle(tour) }),
    el("span", { class: "mrow-meta" },
      el("i", { class: "cdot", style: `--c:${color}` }),
      el("span", { class: "mrow-meta-txt", text: meta.join(" · ") }),
      effectiveIsPlan(tour) ? el("span", { class: "mtag plan", text: "Planung" }) : null,
      tour.hidden ? el("span", { class: "mtag", text: "ausgeblendet" }) : null),
    el("span", { class: "mrow-stats" },
      el("span", { text: fmtDistance(tour.distanceM) }),
      el("span", { text: `↑ ${fmtElevation(tour.ascentM)}` }),
      tour.totalS > 0 ? el("span", { text: fmtDuration(tour.totalS) }) : null,
      rating ? el("span", { class: "mrow-stars", text: `★ ${rating}` }) : null)));
}

function toggleSet(set, v) {
  set.has(v) ? set.delete(v) : set.add(v);
}

function emptyState(title, text, action) {
  return el("div", { class: "mempty" },
    el("div", { class: "mempty-ico", html: icon("route", 30) }),
    el("h2", { text: title }),
    el("p", { class: "muted", text }),
    action ? el("button", { class: "btn primary", type: "button", text: action.label, onclick: action.onclick }) : null);
}
