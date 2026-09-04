import L from "leaflet";
import { legStyle, routeLegs } from "./story-route";
import { modeIconMarkup } from "./story-mode-icon";
import type { StoryMapPoint } from "./types";

/** OpenRouteService asks for a credit wherever its directions are shown. Added
 *  only when a line on this map actually came from it. */
export const ROUTING_ATTRIBUTION =
  'routing by <a href="https://openrouteservice.org/" target="_blank" rel="noreferrer">openrouteservice.org</a>';

// Drawing a route onto a Leaflet layer: one line per leg, in its own style,
// with the mode's icon sitting on it. Shared by the reading map and the
// editor's picker so the author is looking at what the reader will get.
//
// Returns whether any leg was followed rather than drawn, which is what decides
// the credit line above.
export function drawRouteLegs(layer: L.LayerGroup, stops: StoryMapPoint[]): boolean {
  let routed = false;
  for (const leg of routeLegs(stops)) {
    routed = routed || leg.routed;
    L.polyline(leg.coords, { ...legStyle(leg), interactive: false }).addTo(layer);
    if (!leg.mode) continue;
    // The icon rides the middle of its own line rather than the midpoint
    // between the stops, so on a road that loops it stays on the road.
    L.marker(leg.midpoint, {
      icon: L.divIcon({
        className: "story-map-mode",
        html: `<span class="story-map-mode-badge">${modeIconMarkup(leg.mode)}</span>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      }),
      interactive: false,
      // Under the numbered stops: which places, in which order, is the first
      // thing to read; how you got between them is the second.
      zIndexOffset: -100
    }).addTo(layer);
  }
  return routed;
}
