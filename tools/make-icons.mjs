// One-off generator for the PWA icons (not a build step – the PNGs are committed).
// Draws the app's mark: two white mountain peaks on the accent orange, with a
// GPS-track squiggle. Pure Node (zlib), 4x4 supersampling for smooth edges.
//   node tools/make-icons.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BG = [0xe0, 0x7d, 0x21];
const FG = [0xff, 0xff, 0xff];
const TRACK = [0x5a, 0x2d, 0x06];

// shapes in unit coordinates (0..1), y down
const peaks = [
  [[0.14, 0.76], [0.42, 0.30], [0.70, 0.76]],
  [[0.44, 0.76], [0.64, 0.44], [0.86, 0.76]],
];
const inTri = ([a, b, c], x, y) => {
  const s = (p, q) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
  const d1 = s(a, b), d2 = s(b, c), d3 = s(c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};
// dashed-free track: a sine path along the foot of the mountains
const onTrack = (x, y) => {
  if (x < 0.14 || x > 0.86) return false;
  const ty = 0.83 + 0.03 * Math.sin((x - 0.14) * 14);
  return Math.abs(y - ty) < 0.022;
};

function pixel(x, y, maskable) {
  // maskable icons need the art inside the central 80 % safe zone
  const k = maskable ? 0.78 : 1;
  const ux = (x - 0.5) / k + 0.5, uy = (y - 0.5) / k + 0.5;
  if (onTrack(ux, uy)) return TRACK;
  if (peaks.some((t) => inTri(t, ux, uy))) return FG;
  return BG;
}

function render(size, maskable) {
  const SS = 4;
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let px = 0; px < size; px++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const c = pixel((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, maskable);
          acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
        }
      for (let i = 0; i < 3; i++) row[1 + px * 3 + i] = Math.round(acc[i] / (SS * SS));
    }
    rows.push(row);
  }
  return png(size, Buffer.concat(rows));
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
writeFileSync(new URL("icon-192.png", out), render(192, false));
writeFileSync(new URL("icon-512.png", out), render(512, false));
writeFileSync(new URL("icon-maskable-512.png", out), render(512, true));
writeFileSync(new URL("apple-touch-icon.png", out), render(180, false));
console.log("icons written");
