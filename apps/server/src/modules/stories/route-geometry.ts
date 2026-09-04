import { isRoutableMode, routeLeg } from "../../core/routing.js";
import type { RoutePoint } from "./stories.js";

// Turning the stops an author saved into the lines a reader sees. This is the
// only place that asks a routing service anything, and it runs on SAVE — the
// reading path never comes near it.
//
// Geometry is never accepted from the browser. A block's lines are derived here
// from its coordinates and modes, so a crafted request cannot draw a route
// through somewhere the stops never went.

/** What the editor sends: where, called what, reached how. */
export interface RouteStopInput {
  lat: number;
  lng: number;
  label: string | null;
  mode: string | null;
}

/** Two coordinates and a mode identify a leg. Six decimals is ~10cm — far finer
 *  than anyone drags a pin, and coarse enough that float noise doesn't cause a
 *  needless re-route. */
function legKey(from: RouteStopInput, to: RouteStopInput, mode: string | null): string {
  const at = (point: RouteStopInput) => `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;
  return `${at(from)}>${at(to)}:${mode ?? ""}`;
}

/** How many legs are asked for at once. The free allowance is per day and the
 *  limit that bites is per minute, so a fifty-stop route walks rather than
 *  sprints — and an author is waiting, so it doesn't crawl either. */
const CONCURRENCY = 4;

/**
 * Fill in each leg's line. A leg whose two ends and mode are unchanged keeps
 * the geometry already stored — reordering, renaming a stop, or adding one at
 * the end therefore costs nothing. A leg that can't be followed (a train, a
 * flight, no key, a service that won't answer) gets null and is drawn instead.
 */
export async function resolveRouteGeometry(
  stops: RouteStopInput[],
  existing: RoutePoint[]
): Promise<RoutePoint[]> {
  // Every leg already stored, by what it is rather than where it sat: a route
  // whose stops were reordered still recognises the legs it kept.
  const known = new Map<string, string>();
  for (let index = 1; index < existing.length; index += 1) {
    const geometry = existing[index].geometry;
    if (geometry) known.set(legKey(existing[index - 1], existing[index], existing[index].mode), geometry);
  }

  const resolved: RoutePoint[] = stops.map((stop) => ({
    lat: stop.lat,
    lng: stop.lng,
    label: stop.label,
    mode: stop.mode,
    geometry: null
  }));
  if (resolved.length > 0) {
    // Nothing precedes the first stop, so it is never a leg.
    resolved[0].mode = null;
  }

  const pending: number[] = [];
  for (let index = 1; index < resolved.length; index += 1) {
    const mode = resolved[index].mode;
    if (!isRoutableMode(mode)) continue;
    const cached = known.get(legKey(stops[index - 1], stops[index], mode));
    if (cached) {
      resolved[index].geometry = cached;
      continue;
    }
    pending.push(index);
  }

  for (let at = 0; at < pending.length; at += CONCURRENCY) {
    const batch = pending.slice(at, at + CONCURRENCY);
    await Promise.all(batch.map(async (index) => {
      resolved[index].geometry = await routeLeg(resolved[index - 1], resolved[index], resolved[index].mode);
    }));
  }

  return resolved;
}
