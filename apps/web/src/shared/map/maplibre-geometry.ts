// The arithmetic between this app's map vocabulary and MapLibre's, kept pure so
// it is tested without a WebGL context.
//
// Two conventions differ, and both are easy to get silently wrong:
//  - Order: the vocabulary says [lat, lng], as people do; MapLibre says
//    [lng, lat], as GeoJSON does.
//  - Zoom: the vocabulary is on the raster scale (256 px tiles); MapLibre's
//    512 px tiles show at z what raster shows at z + 1.
import type { LatLng } from "./types";

export type LngLatTuple = [number, number];
export type BoundsTuple = [LngLatTuple, LngLatTuple];

export function toLngLat([lat, lng]: LatLng): LngLatTuple {
  return [lng, lat];
}

/** A raster-scale zoom as MapLibre counts it. */
export function glZoom(zoom: number): number {
  return Math.max(0, zoom - 1);
}

/** A MapLibre zoom back on the raster scale. */
export function rasterZoom(zoom: number): number {
  return zoom + 1;
}

/** Web Mercator stops short of the poles; a bound past this is not drawable. */
const MAX_LAT = 85.0511;

/**
 * The south-west and north-east corners around `points`, grown by `pad` of their
 * own width and height on every side — exactly Leaflet's LatLngBounds.pad(), so a
 * framing reads the same after the renderer changed. Null for no points.
 */
export function paddedBounds(points: LatLng[], pad = 0): BoundsTuple | null {
  if (points.length === 0) return null;
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  for (const [lat, lng] of points) {
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    west = Math.min(west, lng);
    east = Math.max(east, lng);
  }
  const dLat = (north - south) * pad;
  const dLng = (east - west) * pad;
  return [
    [west - dLng, Math.max(-MAX_LAT, south - dLat)],
    [east + dLng, Math.min(MAX_LAT, north + dLat)]
  ];
}

/** Leaflet dash arrays are pixels ("6 6"); MapLibre's are multiples of the line
 *  width. Null when there is no dash. */
export function dashFor(dashArray: string | undefined, weight: number): number[] | null {
  if (!dashArray) return null;
  const parts = dashArray.trim().split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  return parts.length > 0 && weight > 0 ? parts.map((n) => n / weight) : null;
}
