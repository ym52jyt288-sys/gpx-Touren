// Dependency-free GPX reader. Works on the main thread and inside a Web Worker
// (no DOMParser needed). Handles the <trk>/<trkseg>/<trkpt> structure that
// APE@MAP exports, plus <rte>/<rtept> planning routes and self-closing points.

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function getAttr(attrs, name) {
  const m =
    attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i")) ||
    attrs.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, "i"));
  return m ? m[1] : "";
}

function extractPoints(xml, tag) {
  const points = [];
  const re = new RegExp(
    `<${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}\\s*>)`,
    "gi"
  );
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1] || "";
    const body = m[2] || "";
    const lat = parseFloat(getAttr(attrs, "lat"));
    const lon = parseFloat(getAttr(attrs, "lon"));
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    ) {
      continue;
    }
    const eleM = body.match(/<ele>\s*([-+0-9.eE]+)\s*<\/ele>/i);
    const timeM = body.match(/<time>\s*([^<]+?)\s*<\/time>/i);
    const nameM = body.match(/<name>\s*([\s\S]*?)\s*<\/name>/i);
    const ele = eleM ? parseFloat(eleM[1]) : NaN;
    const t = timeM ? Date.parse(timeM[1].trim()) : NaN;
    points.push({
      lat,
      lon,
      ele: Number.isFinite(ele) ? ele : null,
      time: Number.isFinite(t) ? t : null,
      name: nameM ? decodeEntities(nameM[1]).trim() : null,
    });
  }
  return points;
}

function firstName(xml) {
  const within = (openTag) => {
    const i = xml.search(new RegExp(`<${openTag}\\b`, "i"));
    if (i < 0) return null;
    const seg = xml.slice(i, i + 8000);
    const m = seg.match(/<name>\s*([\s\S]*?)\s*<\/name>/i);
    return m ? decodeEntities(m[1]).trim() : null;
  };
  return (
    within("metadata") ||
    within("trk") ||
    within("rte") ||
    null
  );
}

/**
 * @returns {{name: string|null, creator: string|null,
 *   points: Array<{lat:number,lon:number,ele:number|null,time:number|null}>,
 *   waypoints: Array<{lat:number,lon:number,ele:number|null,name:string|null}>,
 *   isRouteOnly: boolean, waypointCount: number}}
 */
export function parseGpxText(text) {
  const xml = String(text).replace(/<!--[\s\S]*?-->/g, "");

  const creatorMatch = xml.match(/<gpx\b[^>]*\bcreator\s*=\s*"([^"]*)"/i);
  const creator = creatorMatch ? decodeEntities(creatorMatch[1]) : null;

  const trkpts = extractPoints(xml, "trkpt");
  const rtepts = extractPoints(xml, "rtept");
  const isRouteOnly = trkpts.length === 0 && rtepts.length > 0;
  const points = trkpts.length > 0 ? trkpts : rtepts;

  const waypoints = extractPoints(xml, "wpt");

  return {
    name: firstName(xml),
    creator,
    points,
    waypoints,
    isRouteOnly,
    waypointCount: waypoints.length,
  };
}
