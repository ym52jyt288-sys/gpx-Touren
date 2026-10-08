import { el, clear, debounce } from "../dom.js";
import { matchesFilter, sortTours, filterIsActive, SORTS } from "../filter.js";
import {
  fmtDistance,
  fmtElevation,
  fmtDuration,
  fmtDate,
  effectiveCategory,
  effectiveIsPlan,
  effectiveTitle,
  starString,
  eyeIconSvg,
  CATEGORY_LABEL,
  CATEGORY_COLOR,
} from "../format.js";
import { routeSvg } from "../minimap.js";
import { buildFilterPanel, makeFilterButton } from "./filterPanel.js";

export function renderList(mount, ctx) {
  clear(mount);
  const { state } = ctx;

  const search = el("input", {
    type: "search",
    class: "search",
    placeholder: "Titel, Ort, Land…",
    value: state.filter.text,
    oninput: debounce((e) => {
      state.filter.text = e.target.value;
      renderBody();
    }, 180),
  });

  const sortSel = el(
    "select",
    {
      class: "select",
      onchange: (e) => {
        state.sort = e.target.value;
        renderBody();
      },
    },
    ...Object.entries(SORTS).map(([k, v]) =>
      el("option", { value: k, selected: state.sort === k }, v.label)
    )
  );

  const countries = [
    ...new Set(state.tours.map((t) => t.country).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, "de"));

  const filterPanel = buildFilterPanel(state.filter, countries, () => {
    filterBtnApi.update();
    renderBody();
  });
  const filterBtnApi = makeFilterButton(state.filter, filterPanel);

  const toolbar = el(
    "div",
    { class: "toolbar" },
    search,
    el("div", { class: "toolbar-right" }, sortSel, filterBtnApi.btn)
  );

  const body = el("div", { class: "list-body" });
  mount.append(toolbar, filterPanel, body);

  function renderBody() {
    filterBtnApi.update();
    clear(body);

    if (!state.tours.length) {
      body.append(
        emptyState(
          ctx.scanStatus === "scanning"
            ? "Der Ordner wird indexiert…"
            : "Noch keine Touren im Index. Oben rechts „Aktualisieren“."
        )
      );
      return;
    }

    const all = state.tours;
    const visible = sortTours(all.filter((t) => matchesFilter(t, state.filter)), state.sort);
    const hiddenCount = all.filter((t) => t.hidden).length;

    const countTxt =
      filterIsActive(state.filter) || state.filter.text
        ? `${visible.length} von ${all.length} Touren`
        : `${all.length} Touren`;
    body.append(
      el("div", { class: "list-count muted small" },
        countTxt +
          (hiddenCount && !state.filter.showHidden ? ` · ${hiddenCount} ausgeblendet` : ""))
    );

    if (!visible.length) {
      body.append(emptyState("Keine Tour passt zu den Filtern."));
      return;
    }

    const toggleHidden = async (tour) => {
      tour.hidden = !tour.hidden;
      await ctx.saveTour?.(tour);
      renderBody();
    };

    const ul = el("div", { class: "tour-list" });
    for (const tour of visible) {
      ul.append(rowFor(tour, () => ctx.openDetail(tour.fileName), () => toggleHidden(tour)));
    }
    body.append(ul);
  }

  renderBody();
  ctx._rerenderList = renderBody;
}

function rowFor(tour, onOpen, onToggleHide) {
  const cat = effectiveCategory(tour);
  return el(
    "div",
    { class: "tour-row selectable" + (tour.hidden ? " is-hidden" : "") },
    el(
      "button",
      { class: "row-open", onclick: onOpen },
      el("div", { class: "thumb", html: routeSvg(tour.polyline, tour.bbox, 64, 64) }),
      el(
        "div",
        { class: "tour-main" },
        el(
          "div",
          { class: "tour-title-row" },
          el("span", { class: "cat-tag", style: `--c:${CATEGORY_COLOR[cat]}`, title: CATEGORY_LABEL[cat] }, CATEGORY_LABEL[cat]),
          effectiveIsPlan(tour) ? el("span", { class: "plan-badge", title: "geplante Route (nicht selbst aufgezeichnet)" }, "Planung") : null,
          tour.hidden ? el("span", { class: "hidden-tag" }, "ausgeblendet") : null,
          el("span", { class: "tour-title" }, effectiveTitle(tour)),
          tour.rating ? el("span", { class: "stars small" }, starString(tour.rating)) : null
        ),
        el(
          "div",
          { class: "tour-sub muted small" },
          fmtDate(tour.tourDate) + (tour.country ? ` · ${tour.country}` : "")
        ),
        el(
          "div",
          { class: "tour-stats muted small" },
          stat(fmtDistance(tour.distanceM)),
          stat(`↑ ${fmtElevation(tour.ascentM)}`),
          tour.totalS > 0 ? stat(fmtDuration(tour.totalS)) : null
        )
      )
    ),
    el("button", {
      class: "row-hide" + (tour.hidden ? " on" : ""),
      title: tour.hidden ? "Wieder einblenden" : "Track ausblenden",
      html: eyeIconSvg(tour.hidden),
      onclick: onToggleHide,
    })
  );
}

function stat(value) {
  return el("span", { class: "stat" }, value);
}

function emptyState(text) {
  return el("div", { class: "empty" }, el("p", { class: "muted" }, text));
}
