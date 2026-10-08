// Shared filter panel UI (list + map search use the same filter criteria).

import { el, parseNumber, debounce } from "../dom.js";
import { filterIsActive, QUICK_RANGES, rangeToDates } from "../filter.js";
import { CATEGORY_LABEL } from "../format.js";

const CATS = ["cycling", "hiking", "unknown"];

export function makeFilterButton(filter, panel) {
  const btn = el("button", {
    class: "btn",
    onclick: () => panel.classList.toggle("open"),
  });
  const update = () => {
    btn.textContent = filterIsActive(filter) ? "Filter •" : "Filter";
    btn.classList.toggle("active", filterIsActive(filter));
  };
  update();
  return { btn, update };
}

export function buildFilterPanel(filter, countries, onChange) {
  const panel = el("div", { class: "filter-panel" });

  // country
  const countrySel = el(
    "select",
    {
      class: "select",
      onchange: (e) => {
        filter.country = e.target.value;
        onChange();
      },
    },
    el("option", { value: "" }, "alle Länder"),
    ...countries.map((c) =>
      el("option", { value: c, selected: filter.country === c }, c)
    )
  );
  const countryRow = countries.length
    ? el("div", { class: "filter-row" },
        el("span", { class: "filter-label" }, "Land"), countrySel)
    : el("div", { class: "filter-row muted small" },
        "Land: erst nach „Orte online ermitteln“ verfügbar");

  // categories + planning flag
  const catRow = el("div", { class: "filter-row" });
  for (const c of CATS) {
    const cb = el("input", {
      type: "checkbox",
      checked: filter.categories.has(c),
      onchange: (e) => {
        e.target.checked ? filter.categories.add(c) : filter.categories.delete(c);
        onChange();
      },
    });
    catRow.append(el("label", { class: "chk" }, cb, ` ${CATEGORY_LABEL[c]}`));
  }

  const planSel = el(
    "select",
    {
      class: "select",
      onchange: (e) => {
        filter.plan = e.target.value;
        onChange();
      },
    },
    el("option", { value: "", selected: !filter.plan }, "Planungen: einschließen"),
    el("option", { value: "only", selected: filter.plan === "only" }, "nur Planungen"),
    el("option", { value: "exclude", selected: filter.plan === "exclude" }, "ohne Planungen")
  );
  const planRow = el("div", { class: "filter-row" },
    el("span", { class: "filter-label" }, "Planung"), planSel);

  const hiddenCb = el("input", {
    type: "checkbox",
    checked: !!filter.showHidden,
    onchange: (e) => {
      filter.showHidden = e.target.checked;
      onChange();
    },
  });
  const hiddenRow = el("div", { class: "filter-row" },
    el("span", { class: "filter-label" }, "Ausgeblendet"),
    el("label", { class: "chk" }, hiddenCb, " ausgeblendete Touren anzeigen"));

  // minimum rating
  const ratingSel = el(
    "select",
    {
      class: "select",
      onchange: (e) => {
        filter.minRating = Number(e.target.value) || 0;
        onChange();
      },
    },
    el("option", { value: "0", selected: !filter.minRating }, "Bewertung: egal"),
    ...[1, 2, 3, 4, 5].map((n) =>
      el("option", { value: String(n), selected: filter.minRating === n }, `${"★".repeat(n)} und mehr`)
    )
  );

  // quick date range
  const rangeSel = el(
    "select",
    {
      class: "select",
      onchange: (e) => {
        filter.range = e.target.value;
        const d = rangeToDates(filter.range);
        filter.dateFrom = d.dateFrom;
        filter.dateTo = d.dateTo;
        dateFrom.value = toDateValue(filter.dateFrom);
        dateTo.value = toDateValue(filter.dateTo);
        onChange();
      },
    },
    ...Object.entries(QUICK_RANGES).map(([k, v]) =>
      el("option", { value: k, selected: filter.range === k }, v.label)
    )
  );

  const dateFrom = dateInput(filter.dateFrom, (ms) => {
    filter.dateFrom = ms;
    filter.range = "";
    rangeSel.value = "";
    onChange();
  });
  const dateTo = dateInput(filter.dateTo, (ms) => {
    filter.dateTo = ms == null ? null : ms + 86_399_000;
    filter.range = "";
    rangeSel.value = "";
    onChange();
  });

  const num = (ph, get, set) =>
    el("input", {
      type: "number",
      class: "num",
      placeholder: ph,
      value: get() ?? "",
      min: "0",
      oninput: debounce((e) => {
        set(parseNumber(e.target.value));
        onChange();
      }, 200),
    });

  panel.append(
    countryRow,
    catRow,
    planRow,
    hiddenRow,
    el("div", { class: "filter-row" },
      el("span", { class: "filter-label" }, "Bewertung"), ratingSel),
    el("div", { class: "filter-row" },
      el("span", { class: "filter-label" }, "Schnellfilter"), rangeSel),
    el("div", { class: "filter-row" },
      el("span", { class: "filter-label" }, "Zeitraum"),
      dateFrom, el("span", { text: "–" }), dateTo),
    el("div", { class: "filter-row" },
      el("span", { class: "filter-label" }, "Distanz km"),
      num("min", () => filter.minKm, (v) => (filter.minKm = v)),
      el("span", { text: "–" }),
      num("max", () => filter.maxKm, (v) => (filter.maxKm = v))),
    el("div", { class: "filter-row" },
      el("span", { class: "filter-label" }, "Aufstieg m"),
      num("min", () => filter.minAscent, (v) => (filter.minAscent = v)),
      el("span", { text: "–" }),
      num("max", () => filter.maxAscent, (v) => (filter.maxAscent = v))),
    el("div", { class: "filter-row" },
      el("button", {
        class: "btn subtle",
        text: "Filter zurücksetzen",
        onclick: () => {
          filter.categories.clear();
          filter.plan = "";
          filter.country = "";
          filter.minRating = 0;
          filter.showHidden = false;
          filter.range = "";
          filter.dateFrom = filter.dateTo = null;
          filter.minKm = filter.maxKm = filter.minAscent = filter.maxAscent = null;
          panel.querySelectorAll("input").forEach((i) => {
            if (i.type === "checkbox") i.checked = false;
            else i.value = "";
          });
          panel.querySelectorAll("select").forEach((s) => (s.selectedIndex = 0));
          onChange();
        },
      }))
  );

  return panel;
}

function toDateValue(m) {
  if (m == null) return "";
  const d = new Date(m);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function dateInput(ms, onSet) {
  return el("input", {
    type: "date",
    class: "date",
    value: toDateValue(ms),
    onchange: (e) => {
      const v = e.target.value;
      onSet(v ? new Date(v + "T00:00:00").getTime() : null);
    },
  });
}

