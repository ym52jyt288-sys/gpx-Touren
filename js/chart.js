// Elevation profile on a <canvas>. No charting library.
//
// Bottom axis = distance (km), left axis = elevation (m). When the samples carry
// timestamps a second axis on top marks elapsed time, placed at the distance
// where each round time value was actually reached (so pauses show as the curve
// "standing still" under a time tick). A pointer over the chart scrubs a
// crosshair and reports the sample beneath it via `opts.onHover` – distance,
// elevation, elapsed time and coordinate – so the caller can show a readout and
// move a marker on the map.

import { haversine } from "./geo.js";

const PAD_L = 46;
const PAD_R = 12;
const PAD_T_TIME = 26; // room for the top time axis
const PAD_T_PLAIN = 12;
const PAD_B = 24;

/**
 * Turn raw GPX points into chart samples: cumulative distance (m), elevation (m),
 * elapsed time (s since the first timestamp – null when the track has no times,
 * e.g. planned routes) and the coordinate. Down-sampled by index so the canvas
 * stays cheap.
 * @param {Array<{lat:number,lon:number,ele:number|null,time:number|null}>} points
 * @returns {Array<{d:number,ele:number,t:number|null,lat:number,lon:number}>|null}
 */
export function toProfileSamples(points, target = 400) {
  if (!points || points.length < 2) return null;
  let t0 = null;
  for (const p of points) {
    if (p.time != null) {
      t0 = p.time;
      break;
    }
  }
  const out = [];
  let cum = 0;
  let prev = null;
  for (const p of points) {
    if (prev) cum += haversine(prev, p);
    prev = p;
    if (p.ele == null) continue;
    out.push({
      d: cum,
      ele: p.ele,
      t: t0 != null && p.time != null ? (p.time - t0) / 1000 : null,
      lat: p.lat,
      lon: p.lon,
    });
  }
  if (out.length < 2) return null;
  if (out.length <= target) return out;
  const step = (out.length - 1) / (target - 1);
  const thin = [];
  for (let i = 0; i < target; i++) thin.push(out[Math.round(i * step)]);
  return thin;
}

function normalize(samples) {
  if (!samples || !samples.length) return [];
  if (Array.isArray(samples[0])) {
    return samples.map(([d, ele]) => ({ d, ele, t: null, lat: null, lon: null }));
  }
  return samples.map((s) => ({
    d: s.d,
    ele: s.ele,
    t: Number.isFinite(s.t) ? s.t : null,
    lat: Number.isFinite(s.lat) ? s.lat : null,
    lon: Number.isFinite(s.lon) ? s.lon : null,
  }));
}

// compact "h:mm" for axis ticks (0:30, 1:00, 2:30)
function fmtHM(sec) {
  const m = Math.round(sec / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

// pick a tick spacing that yields ~4–6 labels
function timeStep(maxT) {
  const steps = [300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200];
  for (const s of steps) if (maxT / s <= 6) return s;
  return steps[steps.length - 1];
}

function distAtTime(arr, t) {
  if (t <= 0) return arr[0].d;
  for (let i = 1; i < arr.length; i++) {
    const a = arr[i - 1];
    const b = arr[i];
    if (a.t == null || b.t == null) continue;
    if (b.t >= t) {
      const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
      return a.d + (b.d - a.d) * Math.max(0, Math.min(1, f));
    }
  }
  return arr[arr.length - 1].d;
}

function rgba(color, alpha) {
  const h = String(color).replace("#", "").trim();
  if (h.length === 6) {
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  if (h.length === 3) {
    const r = parseInt(h[0] + h[0], 16);
    const g = parseInt(h[1] + h[1], 16);
    const b = parseInt(h[2] + h[2], 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return `rgba(136,136,136,${alpha})`;
}

/**
 * Interactive elevation chart bound to `canvas`.
 * @param {HTMLCanvasElement} canvas
 * @param {{onHover?: (s: null | {d:number, ele:number, t:number|null,
 *          lat:number|null, lon:number|null, px:number}) => void}} [opts]
 * @returns {{ setData(samples:any[]): void, redraw(): void, destroy(): void }}
 */
export function createElevationChart(canvas, opts = {}) {
  const onHover = opts.onHover || (() => {});
  let samples = [];
  let geom = null;
  let cursor = -1;
  let raf = 0;

  function draw() {
    raf = 0;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 600;
    const cssH = canvas.clientHeight || 200;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const st = getComputedStyle(document.documentElement);
    const accent = st.getPropertyValue("--accent").trim() || "#e07d21";
    const fg = st.getPropertyValue("--fg-muted").trim() || "#888";
    const grid = st.getPropertyValue("--border").trim() || "#ddd";
    const surface = st.getPropertyValue("--surface").trim() || "#fff";

    if (samples.length < 2) {
      ctx.fillStyle = fg;
      ctx.font = "13px system-ui, sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText("Kein Höhenprofil verfügbar", 12, cssH / 2);
      geom = null;
      return;
    }

    const timed = samples.filter((s) => s.t != null).length;
    const hasTime =
      timed > samples.length * 0.5 && samples[samples.length - 1].t > 60;
    const padT = hasTime ? PAD_T_TIME : PAD_T_PLAIN;
    const plotW = cssW - PAD_L - PAD_R;
    const plotH = cssH - padT - PAD_B;

    const maxDist = samples[samples.length - 1].d || 1;
    let minEle = Infinity;
    let maxEle = -Infinity;
    for (const s of samples) {
      if (s.ele < minEle) minEle = s.ele;
      if (s.ele > maxEle) maxEle = s.ele;
    }
    if (maxEle - minEle < 10) {
      maxEle += 5;
      minEle -= 5;
    }

    const x = (d) => PAD_L + (d / maxDist) * plotW;
    const y = (e) => padT + plotH - ((e - minEle) / (maxEle - minEle)) * plotH;
    geom = { x, plotW, cssW, cssH, maxDist, padT, plotH };

    ctx.font = "11px system-ui, sans-serif";

    // horizontal grid + elevation labels
    ctx.strokeStyle = grid;
    ctx.fillStyle = fg;
    ctx.lineWidth = 1;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    for (let i = 0; i <= 4; i++) {
      const e = minEle + ((maxEle - minEle) * i) / 4;
      const yy = Math.round(y(e)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD_L, yy);
      ctx.lineTo(cssW - PAD_R, yy);
      ctx.stroke();
      ctx.fillText(`${Math.round(e)}`, 6, yy);
    }

    // distance labels (km)
    ctx.textBaseline = "top";
    ctx.textAlign = "center";
    const kmTicks = Math.min(6, Math.max(2, Math.round(maxDist / 1000 / 2)));
    for (let i = 0; i <= kmTicks; i++) {
      const d = (maxDist * i) / kmTicks;
      ctx.fillText(
        (d / 1000).toFixed(maxDist < 3000 ? 1 : 0),
        Math.min(cssW - PAD_R, Math.max(PAD_L, x(d))),
        cssH - PAD_B + 6
      );
    }
    ctx.textAlign = "right";
    ctx.fillText("km", cssW - PAD_R, cssH - PAD_B + 6);

    // filled area + line
    ctx.beginPath();
    ctx.moveTo(x(samples[0].d), y(samples[0].ele));
    for (const s of samples) ctx.lineTo(x(s.d), y(s.ele));
    ctx.lineTo(x(maxDist), padT + plotH);
    ctx.lineTo(x(samples[0].d), padT + plotH);
    ctx.closePath();
    ctx.fillStyle = rgba(accent, 0.18);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(x(samples[0].d), y(samples[0].ele));
    for (const s of samples) ctx.lineTo(x(s.d), y(s.ele));
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();

    // top axis: elapsed time
    if (hasTime) {
      const maxT = samples[samples.length - 1].t;
      const step = timeStep(maxT);
      const axisY = padT - 0.5;
      ctx.strokeStyle = grid;
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.moveTo(PAD_L, axisY);
      ctx.lineTo(cssW - PAD_R, axisY);
      ctx.stroke();
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "center";
      for (let t = 0; t <= maxT + 1; t += step) {
        const xx = Math.round(x(distAtTime(samples, t))) + 0.5;
        ctx.beginPath();
        ctx.moveTo(xx, padT);
        ctx.lineTo(xx, padT - 4);
        ctx.stroke();
        ctx.fillText(fmtHM(t), xx, padT - 8);
      }
      ctx.textAlign = "left";
      ctx.fillText("h", PAD_L - 2, padT - 8);
    }

    // hover crosshair
    if (cursor >= 0 && cursor < samples.length) {
      const s = samples[cursor];
      const cx = Math.round(x(s.d)) + 0.5;
      const cy = y(s.ele);
      ctx.strokeStyle = rgba(fg, 0.5);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, padT);
      ctx.lineTo(cx, padT + plotH);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x(s.d), cy, 4, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = surface;
      ctx.stroke();
    }
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(draw);
  }

  function nearestIndex(d) {
    let lo = 0;
    let hi = samples.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].d < d) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(samples[lo - 1].d - d) < Math.abs(samples[lo].d - d)) {
      lo--;
    }
    return lo;
  }

  // single place that moves the cursor + notifies the caller
  function setCursor(idx) {
    if (idx === cursor) return;
    cursor = idx;
    schedule();
    if (idx < 0) {
      onHover(null);
      return;
    }
    const s = samples[idx];
    onHover({ ...s, px: geom ? geom.x(s.d) : PAD_L });
  }

  function locate(clientX) {
    if (!geom || samples.length < 2) return;
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    if (px < PAD_L - 8 || px > geom.cssW - PAD_R + 8) {
      setCursor(-1);
      return;
    }
    const d = ((px - PAD_L) / geom.plotW) * geom.maxDist;
    setCursor(nearestIndex(d));
  }

  function clearCursor() {
    setCursor(-1);
  }

  const onMove = (e) => locate(e.clientX);
  const onLeave = () => clearCursor();
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerdown", onMove);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("pointercancel", onLeave);

  return {
    setData(next) {
      samples = normalize(next);
      cursor = -1;
      schedule();
    },
    redraw() {
      schedule();
    },
    /**
     * Drive the cursor from outside (e.g. hovering the map): pass a distance in
     * metres to show the crosshair + readout there, or null to clear it.
     */
    cursorAtDistance(dist) {
      if (samples.length < 2) return;
      if (dist == null) setCursor(-1);
      else setCursor(nearestIndex(dist));
    },
    destroy() {
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("pointercancel", onLeave);
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
