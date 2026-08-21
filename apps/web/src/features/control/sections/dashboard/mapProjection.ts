// Where a coordinate lands on the bundled world map.
//
// @svg-maps/world ships path data with no projection metadata, so this was
// measured rather than assumed: the bbox centre of 44 compact countries (islands
// and small states, where the centre of the box really is the centre of the
// country) was fitted against their known coordinates. Mercator came out at
// 1.1px RMS on a 1010px-wide map; equirectangular, Miller and Gall–Peters were
// all 3–7× worse, and the fitted x scale (1010.9px per 360°) matches the viewBox
// width to a tenth of a percent, which is the signature of a plain Mercator with
// R = width / 2π.
//
// Checked afterwards against 56 world cities using the browser's own hit testing:
// 48 land inside their country's filled path, and every one of the other 8 is a
// coastal or riverside city (Istanbul, Sydney, New York, Lagos…) sitting 0.5px
// outside a generalised coastline. That is the map's resolution, not an error in
// these numbers — so a dot is trustworthy to about a pixel, which at this scale
// is roughly 40km at the equator. Country granularity is what the data behind it
// claims anyway.

export const MAP_VIEWBOX_WIDTH = 1010;
export const MAP_VIEWBOX_HEIGHT = 666;

const X_SCALE = 2.808;
const X_OFFSET = 475.01;
const Y_SCALE = -160.098;
const Y_OFFSET = 463.17;

/** The Mercator y for a latitude, in radians-ish units before scaling. */
function mercatorY(latitude: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360));
}

export interface MapPoint {
  x: number;
  y: number;
}

/**
 * Projects a coordinate onto the map's viewBox. Returns null for anything that
 * would land off the drawing — the poles run to infinity under Mercator, and the
 * map itself is cropped below roughly 57°S.
 */
export function projectToMap(latitude: number, longitude: number): MapPoint | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude > 84 || latitude < -84) return null;
  const x = X_SCALE * longitude + X_OFFSET;
  const y = Y_SCALE * mercatorY(latitude) + Y_OFFSET;
  if (x < 0 || x > MAP_VIEWBOX_WIDTH || y < 0 || y > MAP_VIEWBOX_HEIGHT) return null;
  return { x, y };
}
