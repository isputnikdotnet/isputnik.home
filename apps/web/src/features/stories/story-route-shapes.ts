import { legStyle, routeLegs } from "./story-route";
import { modeIconMarkup } from "./story-mode-icon";
import type { MapLine, MapMarker } from "../../shared/map";
import type { StoryMapPoint } from "./types";

/** OpenRouteService asks for a credit wherever its directions are shown. Added
 *  only when a line on this map actually came from it. */
export const ROUTING_ATTRIBUTION =
  'routing by <a href="https://openrouteservice.org/" target="_blank" rel="noreferrer">openrouteservice.org</a>';

export interface RouteShapes {
  lines: MapLine[];
  /** The mode icons that ride the lines. Markers, but not stops. */
  badges: MapMarker[];
  /** Whether any leg was followed rather than drawn — what decides the credit. */
  routed: boolean;
}

// A route as shapes to draw: one line per leg, in its own style, with the
// mode's icon sitting on it. Shared by the reading map and the editor's picker
// so the author is looking at what the reader will get.
//
// Pure — it knows nothing about a map library. It used to draw straight onto a
// Leaflet layer, which is exactly the coupling `shared/map` exists to remove.
export function routeShapes(stops: StoryMapPoint[]): RouteShapes {
  const lines: MapLine[] = [];
  const badges: MapMarker[] = [];
  let routed = false;

  routeLegs(stops).forEach((leg, index) => {
    routed = routed || leg.routed;
    const style = legStyle(leg);
    lines.push({
      id: `leg-${index}`,
      points: leg.coords,
      className: style.className,
      weight: style.weight,
      ...(style.dashArray === undefined ? {} : { dashArray: style.dashArray })
    });
    if (!leg.mode) return;
    badges.push({
      id: `mode-${index}`,
      // The icon rides the middle of its own line rather than the midpoint
      // between the stops, so on a road that loops it stays on the road.
      lat: leg.midpoint[0],
      lng: leg.midpoint[1],
      className: "story-map-mode",
      html: `<span class="story-map-mode-badge">${modeIconMarkup(leg.mode)}</span>`,
      size: [22, 22],
      interactive: false,
      // Under the numbered stops: which places, in which order, is the first
      // thing to read; how you got between them is the second.
      zIndex: -100
    });
  });

  return { lines, badges, routed };
}
