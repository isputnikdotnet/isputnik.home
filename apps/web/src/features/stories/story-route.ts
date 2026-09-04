import type { StoryMapPin } from "./StoryMap";
import type { StoryMapPoint } from "./types";

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
  return [{ lat: block.lat, lng: block.lng, label: block.label }];
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
