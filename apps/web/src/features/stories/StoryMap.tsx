import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

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
  route = false
}: {
  pins: StoryMapPin[];
  onOpen: (id: string) => void;
  route?: boolean;
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
      L.polyline(pins.map((pin) => [pin.lat, pin.lng] as [number, number]), {
        className: "story-map-route",
        weight: 3,
        dashArray: "6 6",
        interactive: false
      }).addTo(layer);
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
    const bounds = L.latLngBounds(pins.map((pin) => [pin.lat, pin.lng] as [number, number]));
    map.fitBounds(bounds.pad(0.25), { maxZoom: 12 });
  }, [pins, route]);

  return <div className="story-home-map" ref={containerRef} />;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string
  ));
}
