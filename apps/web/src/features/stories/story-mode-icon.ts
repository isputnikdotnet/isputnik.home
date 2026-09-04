import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MODE_ICONS } from "./story-route";
import type { TravelMode } from "./types";

// Leaflet's divIcon takes HTML; lucide gives React components. This introduces
// the two, once per mode — the markup is identical every time, so it is built
// on first use and kept, rather than re-rendered on every redraw of the map.
//
// The alternative was hand-copying seven icons' path data, which would drift
// from the lucide art used everywhere else in the app the first time it is
// updated. Rendering the real component cannot drift.
const cache = new Map<TravelMode, string>();

export function modeIconMarkup(mode: TravelMode): string {
  const cached = cache.get(mode);
  if (cached) return cached;
  const markup = renderToStaticMarkup(createElement(MODE_ICONS[mode], { size: 13 }));
  cache.set(mode, markup);
  return markup;
}
