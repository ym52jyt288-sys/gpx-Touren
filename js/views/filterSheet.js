// Mobile filter + sort sheets (shared by the mobile list and map). They edit
// state.filter / state.sort in place and call onChange after every tap, so the
// screen behind updates live; the footer shows the resulting tour count.

import { el, parseNumber, debounce } from "../dom.js";
import {
  matchesFilter,
  resetFilter,
  rangeToDates,
  QUICK_RANGES,
  SORTS,
} from "../filter.js";
import { CATEGORY_LABEL } from "../format.js";
import { openSheet, segmented, switchEl, chip } from "./ui.js";

const RANGE_SHORT = { "": "Alle", "3m": "3 Monate", "12m": "12 Monate", "36m": "3 Jahre", "60m": "5 Jahre" };

export function openFilterSheet(state, { onChange, applyLabel = "anzeigen" } = {}) {
  const f = state.filter;
  const countries = [...new Set(state.tours.map((t) => t.country).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "de")
  );

  const content = el("div", { class: "mfilter" });
  const applyBtn = el("button", { class: "btn primary mbtn-wide", type: "button" });
  const resetBtn = el("button", { class: "btn subtle", type: "button", text: "Zurücksetzen" });

  function changed() {
    onChange?.();
    const n = state.tours.filter((t) => matchesFilter(t, f)).length;
    applyBtn.textContent = `${n} ${n === 1 ? "Tour" : "Touren"} ${applyLabel}`;
  }

  const group = (title, ...children) =>
    el("section", { class: "mfilter-group" }, el("h3", { class: "mfilter-h", text: title }), ...children);

  function build() {
    content.replaceChildren();

    if (f.text) {
      content.append(group("Suchbegriff",
        el("div", { class: "mchips wrap" },
          chip({
            label: `„${f.text}“`, on: true, iconName: "x",
            onclick: () => { f.text = ""; build(); changed(); },
          }))));
    }

    // categories (multi-select)
    const cats = el("div", { class: "mchips wrap" });
    for (const c of ["cycling", "hiking", "unknown"]) {
      cats.append(chip({
        label: CATEGORY_LABEL[c], on: f.categories.has(c),
        onclick: (e) => {
          f.categories.has(c) ? f.categories.delete(c) : f.categories.add(c);
          e.currentTarget.classList.toggle("on", f.categories.has(c));
          changed();
        },
      }));
    }
    content.append(group("Kategorie", cats));

    content.append(group("Planungen",
      segmented(
        [{ value: "", label: "Alle" }, { value: "only", label: "Nur Planungen" }, { value: "exclude", label: "Ohne" }],
        f.plan || "",
        (v) => { f.plan = v; changed(); })));

    // time: quick ranges + explicit from/to
    const dateFrom = dateInput(f.dateFrom, (ms) => {
      f.dateFrom = ms; f.range = ""; rangeSeg.setValue(null); changed();
    });
    const dateTo = dateInput(f.dateTo, (ms) => {
      f.dateTo = ms == null ? null : ms + 86_399_000; f.range = ""; rangeSeg.setValue(null); changed();
    });
    const custom = f.range === "" && (f.dateFrom != null || f.dateTo != null);
    const rangeSeg = segmented(
      Object.keys(QUICK_RANGES).map((k) => ({ value: k, label: RANGE_SHORT[k] || QUICK_RANGES[k].label })),
      custom ? null : f.range || "",
      (v) => {
        f.range = v;
        const d = rangeToDates(v);
        f.dateFrom = d.dateFrom;
        f.dateTo = d.dateTo;
        dateFrom.value = toDateValue(f.dateFrom);
        dateTo.value = toDateValue(f.dateTo);
        changed();
      });
    rangeSeg.classList.add("scroll");
    content.append(group("Zeitraum", rangeSeg,
      el("div", { class: "mrange" }, dateFrom, el("span", { class: "muted", text: "bis" }), dateTo)));

    content.append(group("Distanz (km)", minMax(
      () => f.minKm, (v) => (f.minKm = v), () => f.maxKm, (v) => (f.maxKm = v))));
    content.append(group("Aufstieg (Höhenmeter)", minMax(
      () => f.minAscent, (v) => (f.minAscent = v), () => f.maxAscent, (v) => (f.maxAscent = v))));

    content.append(group("Bewertung",
      segmented(
        [{ value: 0, label: "Egal" }, ...[2, 3, 4].map((n) => ({ value: n, label: `${n}★ +` })), { value: 5, label: "5★" }],
        f.minRating || 0,
        (v) => { f.minRating = v; changed(); })));

    if (countries.length) {
      const sel = el("select", {
        class: "select mselect",
        onchange: (e) => { f.country = e.target.value; changed(); },
      },
      el("option", { value: "" }, "Alle Länder"),
      ...countries.map((c) => el("option", { value: c, selected: f.country === c }, c)));
      content.append(group("Land", sel));
    }

    content.append(el("section", { class: "mfilter-group mcell-inline" },
      el("span", { text: "Ausgeblendete Touren anzeigen" }),
      switchEl({ checked: !!f.showHidden, label: "Ausgeblendete anzeigen",
        onchange: (on) => { f.showHidden = on; changed(); } })));
  }

  function minMax(getMin, setMin, getMax, setMax) {
    const num = (ph, get, set) => el("input", {
      type: "text",
      inputmode: "decimal",
      class: "num mnum",
      placeholder: ph,
      value: get() ?? "",
      oninput: debounce((e) => { set(parseNumber(e.target.value)); changed(); }, 250),
    });
    return el("div", { class: "mrange" },
      num("min", getMin, setMin), el("span", { class: "muted", text: "bis" }), num("max", getMax, setMax));
  }

  build();
  const sheet = openSheet({
    title: "Filter",
    content,
    footer: el("div", { class: "mfoot-row" }, resetBtn, applyBtn),
  });
  resetBtn.onclick = () => { resetFilter(f); build(); changed(); };
  applyBtn.onclick = () => sheet.close();
  changed();
  return sheet;
}

/** Action sheet with the sort orders; calls onChange(key). */
export function openSortSheet(state, onChange) {
  const list = el("div", { class: "mgroup mpick" });
  const sheet = openSheet({ title: "Sortieren", content: list });
  for (const [key, s] of Object.entries(SORTS)) {
    list.append(el("button", {
      type: "button",
      class: "mcell mcell-btn" + (state.sort === key ? " on" : ""),
      onclick: () => {
        state.sort = key;
        onChange?.(key);
        sheet.close();
      },
    },
    el("span", { class: "mcell-k", text: s.label }),
    state.sort === key ? el("span", { class: "mcell-check", text: "✓" }) : null));
  }
  return sheet;
}

function toDateValue(m) {
  if (m == null) return "";
  const d = new Date(m);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dateInput(ms, onSet) {
  return el("input", {
    type: "date",
    class: "date mdate",
    value: toDateValue(ms),
    onchange: (e) => onSet(e.target.value ? new Date(e.target.value + "T00:00:00").getTime() : null),
  });
}
