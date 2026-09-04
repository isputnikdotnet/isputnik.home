import { Bike, Bus, Car, Footprints, Plane, Ship, TrainFront, type LucideIcon } from "lucide-react";
import type { StoryMapPin } from "./StoryMap";
import type { StoryMapPoint, TravelMode } from "./types";

/** What a map block draws. A block written before routes existed has no stops
 *  of its own, so its single place becomes a route of one — every reader then
 *  has exactly one shape to handle. */
export function routeStops(block: {
  lat: number;
  lng: number;
  label: string | null;
  points: StoryMapPoint[];
}): StoryMapPoint[] {
  if (block.points.length > 0) return block.points;
  return [{ lat: block.lat, lng: block.lng, label: block.label, mode: null, geometry: null }];
}

/** The stops as numbered pins, in travel order. The id is the position: a route
 *  pin opens nothing, so it needs a key and not an identity. */
export function routePins(stops: StoryMapPoint[]): StoryMapPin[] {
  return stops.map((stop, index) => ({
    id: String(index),
    lat: stop.lat,
    lng: stop.lng,
    label: String(index + 1),
    title: stop.label ?? String(index + 1)
  }));
}

/** "Minsk → Vilnius → Riga", or null when a stop went unnamed — a caption with
 *  a hole in it reads worse than a plain count. */
export function routeNames(stops: StoryMapPoint[]): string | null {
  const names = stops.map((stop) => stop.label?.trim()).filter((name): name is string => Boolean(name));
  return names.length === stops.length ? names.join(" → ") : null;
}

export const MODE_ICONS: Record<TravelMode, LucideIcon> = {
  walk: Footprints,
  cycle: Bike,
  drive: Car,
  bus: Bus,
  train: TrainFront,
  plane: Plane,
  boat: Ship
};

export type LatLng = [number, number];

/** One hop of the journey, ready to draw. */
export interface RouteLeg {
  mode: TravelMode | null;
  /** Every point of the line, start and end included. */
  coords: LatLng[];
  /** True when these are real roads from the routing service rather than a line
   *  this app drew. Only that deserves a solid stroke. */
  routed: boolean;
  /** Where to hang the mode's icon: the middle of the drawn line. */
  midpoint: LatLng;
}

export function routeLegs(stops: StoryMapPoint[]): RouteLeg[] {
  const legs: RouteLeg[] = [];
  for (let index = 1; index < stops.length; index += 1) {
    const from = stops[index - 1];
    const to = stops[index];
    const mode = stops[index].mode;
    const geometry = stops[index].geometry;
    const coords = geometry
      ? decodePolyline(geometry)
      : mode === "plane"
        // A flight's honest line is the great circle, which on a flat map is a
        // curve — the same arc every airline route map draws.
        ? greatCircle([from.lat, from.lng], [to.lat, to.lng])
        : [[from.lat, from.lng] as LatLng, [to.lat, to.lng] as LatLng];
    // A decoded line can come back empty from a truncated string; never draw a
    // leg with nothing in it.
    const line = coords.length >= 2 ? coords : [[from.lat, from.lng] as LatLng, [to.lat, to.lng] as LatLng];
    legs.push({ mode, coords: line, routed: Boolean(geometry), midpoint: line[Math.floor(line.length / 2)] });
  }
  return legs;
}

/** Solid for a line the world actually has, dashed for one this app drew. */
export function legStyle(leg: RouteLeg): { className: string; weight: number; dashArray?: string } {
  return leg.routed
    ? { className: "story-map-route is-routed", weight: 4 }
    : { className: "story-map-route", weight: 3, dashArray: "6 6" };
}

/**
 * Google's encoded-polyline format at precision 5 — what OpenRouteService
 * returns and what gets stored. Roughly ten times smaller than the same line as
 * JSON, which matters when a drive is two thousand points long.
 */
export function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const axis of [0, 1]) {
      let result = 0;
      let shift = 0;
      let byte: number;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        if (Number.isNaN(byte)) return points;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      // The low bit is the sign, and the value is a delta from the point before.
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

const ARC_STEPS = 48;

/**
 * The great-circle path between two points, sampled evenly — the shortest way
 * across a sphere, which is the route a plane actually takes and why a flight
 * from Europe to America bends over Greenland.
 */
export function greatCircle(from: LatLng, to: LatLng): LatLng[] {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;
  const [lat1, lng1] = [toRad(from[0]), toRad(from[1])];
  const [lat2, lng2] = [toRad(to[0]), toRad(to[1])];

  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lng2 - lng1) / 2) ** 2
  ));
  // Two points in the same place (or as near as makes no difference) have no
  // arc between them, and the interpolation below would divide by zero.
  if (!Number.isFinite(d) || d < 1e-9) return [from, to];

  const points: LatLng[] = [];
  for (let step = 0; step <= ARC_STEPS; step += 1) {
    const f = step / ARC_STEPS;
    const a = Math.sin((1 - f) * d) / Math.sin(d);
    const b = Math.sin(f * d) / Math.sin(d);
    const x = a * Math.cos(lat1) * Math.cos(lng1) + b * Math.cos(lat2) * Math.cos(lng2);
    const y = a * Math.cos(lat1) * Math.sin(lng1) + b * Math.cos(lat2) * Math.sin(lng2);
    const z = a * Math.sin(lat1) + b * Math.sin(lat2);
    points.push([toDeg(Math.atan2(z, Math.hypot(x, y))), toDeg(Math.atan2(y, x))]);
  }
  return points;
}

const EARTH_RADIUS_KM = 6371;

/** How far the journey is as the crow flies, stop to stop. The editor shows it
 *  before any real roads exist: the routed distance is only known once the
 *  server has drawn the legs, and a rough figure beats none while planning. */
export function routeDistanceKm(stops: { lat: number; lng: number }[]): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  let total = 0;
  for (let index = 1; index < stops.length; index += 1) {
    const from = stops[index - 1];
    const to = stops[index];
    const dLat = toRad(to.lat - from.lat);
    const dLng = toRad(to.lng - from.lng);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(dLng / 2) ** 2;
    total += 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  return total;
}
