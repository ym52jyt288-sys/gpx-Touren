// Tiny dependency-free route thumbnail as an inline SVG string.
// Used in list rows and search results, and as the offline map fallback.

/**
 * @param {Array<[number,number]>} polyline  [[lat,lon],...]
 * @param {{minLat:number,maxLat:number,minLon:number,maxLon:number}} bbox
 */
export function routeSvg(polyline, bbox, width = 64, height = 64, opts = {}) {
  const stroke = opts.stroke || "var(--accent)";
  const strokeWidth = opts.strokeWidth || 2;
  const pad = opts.pad ?? 4;

  if (!polyline || polyline.length < 2 || !bbox || !isFinite(bbox.minLat)) {
    return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"
      xmlns="http://www.w3.org/2000/svg" class="minimap-svg"></svg>`;
  }

  const latRange = Math.max(bbox.maxLat - bbox.minLat, 1e-6);
  const lonRange = Math.max(bbox.maxLon - bbox.minLon, 1e-6);
  const scale = Math.min((width - 2 * pad) / lonRange, (height - 2 * pad) / latRange);
  const drawnW = lonRange * scale;
  const drawnH = latRange * scale;
  const ox = (width - drawnW) / 2;
  const oy = (height - drawnH) / 2;

  const project = ([lat, lon]) => {
    const x = (lon - bbox.minLon) * scale + ox;
    const y = drawnH - (lat - bbox.minLat) * scale + oy; // north up
    return [x, y];
  };

  let d = "";
  polyline.forEach((pt, i) => {
    const [x, y] = project(pt);
    d += (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1) + " ";
  });

  const [sx, sy] = project(polyline[0]);
  const [ex, ey] = project(polyline[polyline.length - 1]);

  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"
      xmlns="http://www.w3.org/2000/svg" class="minimap-svg" preserveAspectRatio="xMidYMid meet">
    <path d="${d.trim()}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}"
      stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="${strokeWidth + 1}" fill="#2e9e50"/>
    <circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="${strokeWidth + 1}" fill="#d1453b"/>
  </svg>`;
}
