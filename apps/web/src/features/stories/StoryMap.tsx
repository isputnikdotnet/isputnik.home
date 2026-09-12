import { useMemo } from "react";
import { MapView } from "../../shared/map";
import type { LatLng, MapShapes, MapViewCommand } from "../../shared/map";
import { routeLegs } from "./story-route";
import { ROUTING_ATTRIBUTION, routeShapes } from "./story-route-shapes";
import type { StoryMapPoint } from "./types";

export interface StoryMapPin {
  id: string;
  lat: number;
  lng: number;
  /** "Day 3" — drawn inside the pin, so the map reads as the story's route. */
  label: string;
  title: string;
}

// The Story Home map: one numbered pin per placed chapter, framed to fit them
// all. No clustering — a story has a handful of chapters, not a photo archive.
// Clicking a pin opens that chapter's page.
//
// `route` joins the pins in order with a line: the same component then serves a
// map block's route, where the pins ARE the itinerary. The segments are straight
// — a story map says which places, in which order, not which roads.
export function StoryMap({
  pins,
  onOpen,
  route = false,
  stops
}: {
  pins: StoryMapPin[];
  onOpen: (id: string) => void;
  route?: boolean;
  /** The stops behind the pins, when there are lines to draw between them:
   *  roads where the route was followed, a great-circle arc for a flight, a
   *  drawn line otherwise. Without them `route` still joins the pins straight. */
  stops?: StoryMapPoint[];
}) {
  const options = useMemo(
    () => ({ center: [20, 0] as LatLng, zoom: 2, scrollWheelZoom: false }),
    []
  );

  const drawn = useMemo(() => {
    if (!route || pins.length < 2) return null;
    return routeShapes(stops ?? pins.map((pin) => ({
      lat: pin.lat, lng: pin.lng, label: pin.title, mode: null, geometry: null
    })));
  }, [route, pins, stops]);

  const shapes = useMemo<MapShapes>(() => ({
    lines: drawn?.lines ?? [],
    markers: [
      ...(drawn?.badges ?? []),
      ...pins.map((pin) => ({
        id: pin.id,
        lat: pin.lat,
        lng: pin.lng,
        className: "story-map-marker",
        html: `<span class="story-map-pin">${escapeHtml(pin.label)}</span>`,
        size: [30, 30] as [number, number],
        title: pin.title
      }))
    ]
  }), [drawn, pins]);

  const attributions = useMemo(() => (drawn?.routed ? [ROUTING_ATTRIBUTION] : []), [drawn]);

  // Frame the LINES, not just the pins: a road that loops north of both ends —
  // or a flight's arc — belongs inside the picture it is drawn in.
  const view = useMemo<MapViewCommand | null>(() => {
    if (pins.length === 0) return null;
    const points: LatLng[] = pins.map((pin) => [pin.lat, pin.lng]);
    if (route && stops) for (const leg of routeLegs(stops)) points.push(...leg.coords);
    return { kind: "fit", points, pad: 0.25, maxZoom: 12 };
  }, [pins, route, stops]);

  return (
    <MapView
      options={options}
      shapes={shapes}
      view={view}
      attributions={attributions}
      onMarkerClick={onOpen}
      className="story-home-map"
    />
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string
  ));
}
