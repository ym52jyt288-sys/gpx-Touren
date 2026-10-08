// Small UI primitives for the mobile layout: bottom sheet, toast, switch,
// segmented control, chip. Plain DOM, styled in styles.css (".msheet", …).

import { el } from "../dom.js";
import { icon } from "../icons.js";

/**
 * Slide-up bottom sheet over a dimmed backdrop. Closes on backdrop tap, the ✕,
 * Escape, or a downward swipe on the header.
 *
 * @param {{title?:string, content?:Node, footer?:Node, className?:string, onClose?:()=>void}} o
 * @returns {{close:()=>void, body:HTMLElement, sheet:HTMLElement}}
 */
export function openSheet({ title = "", content = null, footer = null, className = "", onClose } = {}) {
  const handle = el("div", { class: "msheet-handle" });
  const closeBtn = el("button", {
    class: "msheet-close",
    type: "button",
    "aria-label": "Schließen",
    html: icon("x", 18),
    onclick: () => close(),
  });
  const head = el("div", { class: "msheet-head" },
    handle,
    title ? el("h2", { class: "msheet-title", text: title }) : null,
    closeBtn);
  const body = el("div", { class: "msheet-body" }, content);
  const sheet = el("div", { class: `msheet ${className}`.trim(), role: "dialog", "aria-modal": "true" },
    head, body, footer ? el("div", { class: "msheet-foot" }, footer) : null);
  const backdrop = el("div", { class: "msheet-backdrop", onclick: () => close() });
  const root = el("div", { class: "msheet-root" }, backdrop, sheet);
  document.body.append(root);
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add("open")));

  // Escape: capture on window so an underlying detail page doesn't close too
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    close();
  };
  window.addEventListener("keydown", onKey, true);

  // swipe down on the header to dismiss
  let startY = null;
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    startY = e.clientY;
    head.setPointerCapture?.(e.pointerId);
    sheet.style.transition = "none";
  });
  head.addEventListener("pointermove", (e) => {
    if (startY == null) return;
    const dy = Math.max(0, e.clientY - startY);
    sheet.style.transform = `translateY(${dy}px)`;
  });
  const endDrag = (e) => {
    if (startY == null) return;
    const dy = e.clientY - startY;
    startY = null;
    sheet.style.transition = "";
    sheet.style.transform = "";
    if (dy > 70) close();
  };
  head.addEventListener("pointerup", endDrag);
  head.addEventListener("pointercancel", endDrag);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    window.removeEventListener("keydown", onKey, true);
    root.classList.remove("open");
    setTimeout(() => root.remove(), 280);
    onClose?.();
  }

  return { close, body, sheet };
}

let toastEl = null;
let toastTimer = null;

/** Short message floating above the tab bar. */
export function toast(text, ms = 2600) {
  if (!toastEl) {
    toastEl = el("div", { class: "mtoast", role: "status" });
    document.body.append(toastEl);
  }
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
}

/** iOS-style on/off switch. */
export function switchEl({ checked = false, onchange, label = "" } = {}) {
  const input = el("input", {
    type: "checkbox",
    role: "switch",
    checked: !!checked,
    "aria-label": label || null,
    onchange: (e) => onchange?.(e.target.checked),
  });
  return el("label", { class: "mswitch" }, input, el("span", { class: "mswitch-track" }));
}

/**
 * Segmented control. `options` = [{value, label}]; calls onchange(value).
 * Returns the element; `.setValue(v)` updates the highlight.
 */
export function segmented(options, value, onchange) {
  const wrap = el("div", { class: "mseg", role: "radiogroup" });
  const btns = options.map((o) =>
    el("button", {
      type: "button",
      class: "mseg-btn",
      role: "radio",
      text: o.label,
      onclick: () => {
        wrap.setValue(o.value);
        onchange(o.value);
      },
    })
  );
  wrap.setValue = (v) => {
    options.forEach((o, i) => {
      const on = o.value === v;
      btns[i].classList.toggle("on", on);
      btns[i].setAttribute("aria-checked", on ? "true" : "false");
    });
  };
  wrap.append(...btns);
  wrap.setValue(value);
  return wrap;
}

/** Pill-shaped toggle/action chip. */
export function chip({ label, on = false, iconName = null, badge = 0, onclick, className = "" }) {
  return el("button", {
    type: "button",
    class: `mchip ${on ? "on" : ""} ${className}`.trim(),
    "aria-pressed": on ? "true" : "false",
    onclick,
    html:
      (iconName ? icon(iconName, 16) : "") +
      `<span>${escapeHtml(label)}</span>` +
      (badge ? `<b class="mchip-badge">${badge}</b>` : ""),
  });
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
