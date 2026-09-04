import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { routeLegs } from "./story-route";
import { ROUTING_ATTRIBUTION, drawRouteLegs } from "./story-route-layer";
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
// all. Plain Leaflet via a ref (the GalleryMiniMap pattern — no clustering; a
// story has a handful of chapters, not a photo archive). Clicking a pin opens
// that chapter's page.
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
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      center: [20, 0],
      zoom: 2,
      scrollWheelZoom: false,
      attributionControl: true
    });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap"
    }).addTo(map);
    mapRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);
    const sizeTimer = window.setTimeout(() => map.invalidateSize(), 0);
    return () => {
      window.clearTimeout(sizeTimer);
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  // Rebuild the pins whenever the set changes, and frame them.
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    if (pins.length === 0) return;
    // Under the pins, so a marker is never half-hidden by its own line.
    if (route && pins.length > 1) {
      const routed = drawRouteLegs(layer, stops ?? pins.map((pin) => ({
        lat: pin.lat, lng: pin.lng, label: pin.title, mode: null, geometry: null
      })));
      if (routed) map.attributionControl.addAttribution(ROUTING_ATTRIBUTION);
    }
    for (const pin of pins) {
      const icon = L.divIcon({
        className: "story-map-marker",
        html: `<span class="story-map-pin">${escapeHtml(pin.label)}</span>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });
      L.marker([pin.lat, pin.lng], { icon, title: pin.title })
        .on("click", () => onOpenRef.current(pin.id))
        .addTo(layer);
    }
    // Frame the LINES, not just the pins: a road that loops north of both ends
    // — or a flight's arc — belongs inside the picture it is drawn in.
    const bounds = L.latLngBounds(pins.map((pin) => [pin.lat, pin.lng] as [number, number]));
    if (route && stops) for (const leg of routeLegs(stops)) for (const point of leg.coords) bounds.extend(point);
    map.fitBounds(bounds.pad(0.25), { maxZoom: 12 });
  }, [pins, route, stops]);

  return <div className="story-home-map" ref={containerRef} />;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string
  ));
}
