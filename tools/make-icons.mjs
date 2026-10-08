// One-off generator for the app icons (not a build step – the files are committed).
// Motif "Spur" in the "Wald" colourway: a route from an open start ring to a map
// pin, on a deep-green gradient. One geometry, two outputs:
//   icons/icon.svg      vector master (also the browser-tab icon)
//   icons/*.png         rasterised here with signed distance fields – pure Node
//                       (zlib only), analytic anti-aliasing, no renderer needed
//   node tools/make-icons.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

// ---- design (1024 grid) ------------------------------------------------------
const C = {
  bg1: "#2F7658", // gradient top-left
  bg2: "#1A4634", // gradient bottom-right
  fg: "#F6F2E8", // route, start ring, pin
  mid: "#255F46", // inside of the start ring
  ac: "#F3B94A", // pin dot (the one accent)
};
const ROUTE = [
  [[300, 744], [480, 744], [452, 584], [588, 584]],
  [[588, 584], [627, 584], [665, 584], [704, 584]],
];
const ROUTE_W = 64;
const START = { c: [300, 744], r: 50, ring: 30 };
// the pin stands just above the route's end point, as on a map (a line running
// into the narrow tip would bulge out on both sides)
const PIN = { c: [704, 324], r: 112, d: 196, round: 14 }; // d = tip below centre
const DOT = { c: [704, 324], r: 44 };
const GRAD = [0.35, 1]; // gradient direction (objectBoundingBox x2/y2)

const phi = Math.acos(PIN.r / PIN.d);
const tip = [PIN.c[0], PIN.c[1] + PIN.d];
const tanL = [PIN.c[0] - PIN.r * Math.sin(phi), PIN.c[1] + PIN.r * Math.cos(phi)];
const tanR = [PIN.c[0] + PIN.r * Math.sin(phi), PIN.c[1] + PIN.r * Math.cos(phi)];

// ---- SVG master ----------------------------------------------------------------
function svg() {
  const f = (n) => +n.toFixed(1);
  const route = ROUTE.map((b, i) => (i ? "" : `M${b[0].join(" ")} `) + `C ${b.slice(1).map((p) => p.join(" ")).join(" ")}`).join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="${GRAD[0]}" y2="${GRAD[1]}"><stop offset="0" stop-color="${C.bg1}"/><stop offset="1" stop-color="${C.bg2}"/></linearGradient></defs>
  <rect width="1024" height="1024" fill="url(#bg)"/>
  <path d="${route}" fill="none" stroke="${C.fg}" stroke-width="${ROUTE_W}" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="${START.c[0]}" cy="${START.c[1]}" r="${START.r}" fill="${C.mid}" stroke="${C.fg}" stroke-width="${START.ring}"/>
  <path d="M${tip.join(" ")} L${f(tanL[0])} ${f(tanL[1])} A${PIN.r} ${PIN.r} 0 1 1 ${f(tanR[0])} ${f(tanR[1])} Z" fill="${C.fg}" stroke="${C.fg}" stroke-width="${PIN.round}" stroke-linejoin="round"/>
  <circle cx="${DOT.c[0]}" cy="${DOT.c[1]}" r="${DOT.r}" fill="${C.ac}"/>
</svg>
`;
}

// ---- signed distances (1024 units) ----------------------------------------------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function segDist(p, a, b) {
  const ab = sub(b, a), ap = sub(p, a);
  const t = clamp(dot(ap, ab) / dot(ab, ab), 0, 1);
  return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t);
}

// route as a dense polyline
const routePts = [];
for (const [p0, p1, p2, p3] of ROUTE) {
  for (let i = routePts.length ? 1 : 0; i <= 96; i++) {
    const t = i / 96, u = 1 - t;
    routePts.push([0, 1].map((k) => u * u * u * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * p3[k]));
  }
}
function sdRoute(p) {
  let d = Infinity;
  for (let i = 1; i < routePts.length; i++) d = Math.min(d, segDist(p, routePts[i - 1], routePts[i]));
  return d - ROUTE_W / 2;
}
const sdCircle = (p, c, r) => Math.hypot(p[0] - c[0], p[1] - c[1]) - r;

// exact triangle distance (Inigo Quilez), negative inside
function sdTriangle(p, p0, p1, p2) {
  const e0 = sub(p1, p0), e1 = sub(p2, p1), e2 = sub(p0, p2);
  const v0 = sub(p, p0), v1 = sub(p, p1), v2 = sub(p, p2);
  const pq = (v, e) => { const t = clamp(dot(v, e) / dot(e, e), 0, 1); return [v[0] - e[0] * t, v[1] - e[1] * t]; };
  const q0 = pq(v0, e0), q1 = pq(v1, e1), q2 = pq(v2, e2);
  const s = Math.sign(e0[0] * e2[1] - e0[1] * e2[0]);
  const cand = [
    [dot(q0, q0), s * (v0[0] * e0[1] - v0[1] * e0[0])],
    [dot(q1, q1), s * (v1[0] * e1[1] - v1[1] * e1[0])],
    [dot(q2, q2), s * (v2[0] * e2[1] - v2[1] * e2[0])],
  ];
  const d = Math.min(cand[0][0], cand[1][0], cand[2][0]);
  const inside = cand[0][1] > 0 && cand[1][1] > 0 && cand[2][1] > 0;
  return inside ? -Math.sqrt(d) : Math.sqrt(d);
}
const sdPin = (p) => Math.min(sdCircle(p, PIN.c, PIN.r), sdTriangle(p, tip, tanL, tanR)) - PIN.round / 2;

// ---- raster ----------------------------------------------------------------------
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const RGB = Object.fromEntries(Object.entries(C).map(([k, v]) => [k, hex(v)]));
const mix = (a, b, t) => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t);

function render(size, artScale = 1) {
  const unit = 1024 / size; // design units per pixel
  const gv = [GRAD[0] * 1024, GRAD[1] * 1024];
  const gl = dot(gv, gv);
  const raw = Buffer.alloc(size * (1 + size * 3));
  let o = 0;
  for (let py = 0; py < size; py++) {
    raw[o++] = 0; // filter: none
    for (let px = 0; px < size; px++) {
      const q = [(px + 0.5) * unit, (py + 0.5) * unit];
      let col = mix(RGB.bg1, RGB.bg2, clamp(dot(q, gv) / gl, 0, 1));
      // artwork coordinates (maskable icons shrink the art around the centre)
      const p = [(q[0] - 512) / artScale + 512, (q[1] - 512) / artScale + 512];
      const aa = unit / artScale; // one output pixel, in artwork units
      const paint = (sd, rgb) => {
        const cov = clamp(0.5 - sd / aa, 0, 1);
        if (cov > 0) col = mix(col, rgb, cov);
      };
      paint(sdRoute(p), RGB.fg);
      paint(sdCircle(p, START.c, START.r + START.ring / 2), RGB.fg);
      paint(sdCircle(p, START.c, START.r - START.ring / 2), RGB.mid);
      paint(sdPin(p), RGB.fg);
      paint(sdCircle(p, DOT.c, DOT.r), RGB.ac);
      for (let i = 0; i < 3; i++) raw[o++] = Math.round(col[i]);
    }
  }
  return png(size, raw);
}

function png(size, raw) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = new URL("../icons/", import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL("icon.svg", out), svg());
writeFileSync(new URL("icon-192.png", out), render(192));
writeFileSync(new URL("icon-512.png", out), render(512));
// Android crops maskable icons to a circle/squircle: keep the art well inside 80 %
writeFileSync(new URL("icon-maskable-512.png", out), render(512, 0.86));
writeFileSync(new URL("apple-touch-icon.png", out), render(180));
console.log("icons written");
