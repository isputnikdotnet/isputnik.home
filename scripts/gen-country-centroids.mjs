// Regenerates apps/web/src/features/control/sections/dashboard/countryCentroids.ts.
//
// The Locations map needs one coordinate per country to stand a bubble on, and
// the connection data behind it is country-granular. Rather than hand-carry a
// table of 250 coordinates, this derives them from the path data of
// @svg-maps/world (CC BY 4.0, a devDependency of apps/web) — the same path set
// the old SVG choropleth drew — by taking the area centroid of each country's
// largest closed subpath and inverse-projecting it.
//
// The projection is the Mercator fit that was measured for that map: 1010.9px
// per 360° of longitude, which matches the viewBox width to a tenth of a percent
// (the signature of a plain Mercator with R = width / 2π). Spot-checked against
// known coordinates — the US lands in Kansas, Russia in Krasnoyarsk Krai, Belarus
// at 53.6/28.0. A country of scattered islands gets its biggest island, so New
// Zealand comes out on the South Island; the map treats these as anchors, not as
// claims about where a country's middle is.
//
// Run from the repo root:  node scripts/gen-country-centroids.mjs

import { writeFileSync } from "node:fs";
import World from "@svg-maps/world";

const OUT = "apps/web/src/features/control/sections/dashboard/countryCentroids.ts";

// The fit. x is linear in longitude; y is linear in the Mercator projection of
// latitude, with the axis pointing down the screen.
const X_SCALE = 2.808;
const X_OFFSET = 475.01;
const Y_SCALE = -160.098;
const Y_OFFSET = 463.17;

const toLongitude = (x) => (x - X_OFFSET) / X_SCALE;
const toLatitude = (y) => {
  const mercator = (y - Y_OFFSET) / Y_SCALE;
  return ((Math.atan(Math.exp(mercator)) - Math.PI / 4) * 360) / Math.PI;
};

// Islands drawn past the right edge of the map (the Pacific) come back as
// longitudes over 180; fold them into the range Leaflet expects.
const wrap = (longitude) => {
  let value = longitude;
  while (value > 180) value -= 360;
  while (value < -180) value += 360;
  return value;
};

const NUMBER = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

/**
 * The closed polygons of an SVG path. The world set uses nothing but moveto and
 * closepath — every coordinate pair after the first is an implicit lineto — so
 * this handles those two commands and no curves.
 */
function polygons(d) {
  const shapes = [];
  let cursor = [0, 0];
  for (const part of d.split(/(?=[mM])/)) {
    const segment = part.trim();
    if (!segment) continue;
    const relative = segment[0] === "m";
    const numbers = (segment.slice(1).match(NUMBER) ?? []).map(Number);
    if (numbers.length < 2) continue;
    let x = relative ? cursor[0] + numbers[0] : numbers[0];
    let y = relative ? cursor[1] + numbers[1] : numbers[1];
    const points = [[x, y]];
    for (let i = 2; i + 1 < numbers.length; i += 2) {
      if (relative) {
        x += numbers[i];
        y += numbers[i + 1];
      } else {
        x = numbers[i];
        y = numbers[i + 1];
      }
      points.push([x, y]);
    }
    // After a closepath the current point returns to where the subpath started,
    // which is what the next relative moveto is measured from.
    cursor = /z\s*$/i.test(segment) ? points[0] : [x, y];
    if (points.length >= 3) shapes.push(points);
  }
  return shapes;
}

/** The signed-area centroid of a polygon, plus its area. */
function centroid(points) {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const cross = points[j][0] * points[i][1] - points[i][0] * points[j][1];
    area += cross;
    cx += (points[j][0] + points[i][0]) * cross;
    cy += (points[j][1] + points[i][1]) * cross;
  }
  area *= 0.5;
  if (Math.abs(area) < 1e-9) return null;
  return { area: Math.abs(area), x: cx / (6 * area), y: cy / (6 * area) };
}

const rows = [];
for (const location of World.locations) {
  const shapes = polygons(location.path).map(centroid).filter(Boolean);
  if (shapes.length === 0) {
    console.warn(`no closed shape for ${location.id} (${location.name}) — skipped`);
    continue;
  }
  shapes.sort((a, b) => b.area - a.area);
  const biggest = shapes[0];
  rows.push({
    id: location.id,
    name: location.name,
    lat: Number(toLatitude(biggest.y).toFixed(2)),
    lng: Number(wrap(toLongitude(biggest.x)).toFixed(2))
  });
}
rows.sort((a, b) => a.id.localeCompare(b.id));

const header = `// Where to put a country's bubble on the Locations map.
//
// The connection data behind that map is country-granular unless a city-level
// database is in use, so a country needs one coordinate to stand at. These are
// area centroids of each country's largest landmass, computed once from the
// path data of @svg-maps/world (CC BY 4.0) and inverse-projected through a
// measured Mercator fit — see scripts/gen-country-centroids.mjs, which
// regenerates this file.
//
// They are anchors, not facts: a country made of scattered islands gets the
// biggest island, so New Zealand sits on the South Island and the United States
// on the lower 48. The map labels a bubble with the country's name and count, and
// never claims more precision than that.

export const COUNTRY_CENTROIDS: Record<string, [lat: number, lng: number]> = {`;

const body = rows
  .map((row) => {
    const key = /^[a-z]{2,3}$/.test(row.id) ? row.id : JSON.stringify(row.id);
    return `  ${key}: [${row.lat}, ${row.lng}], // ${row.name}`;
  })
  .join("\n");

const footer = `};

/** The centre of a country, or null when it isn't one this map knows. */
export function countryCentroid(code: string): [number, number] | null {
  return COUNTRY_CENTROIDS[code.toLowerCase()] ?? null;
}
`;

writeFileSync(OUT, `${header}\n${body}\n${footer}`, "utf8");
console.log(`${rows.length} countries written to ${OUT}`);
