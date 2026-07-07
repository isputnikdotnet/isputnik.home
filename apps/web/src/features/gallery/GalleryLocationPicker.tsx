import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Click-to-place location picker for the lightbox Info panel: click the map (or
// drag the pin) to choose where a photo was taken. Plain Leaflet via refs like
// GalleryMiniMap, lazy-loaded so Leaflet stays off the initial bundle. Unlike the
// read-only mini map, scroll-wheel zoom stays on — picking a point is a deliberate
// interaction that needs zooming.
export function GalleryLocationPicker({
  value,
  onChange
}: {
  value: { lat: number; lng: number } | null;
  onChange: (next: { lat: number; lng: number }) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  // The map handlers live for the map's lifetime; always call the latest callback.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      // With no starting point, show the world and let the user zoom in.
      center: value ? [value.lat, value.lng] : [25, 10],
      zoom: value ? 14 : 1,
      attributionControl: true
    });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    const icon = L.divIcon({ className: "gallery-mini-marker", html: '<span class="gallery-mini-pin"></span>', iconSize: [18, 18], iconAnchor: [9, 9] });
    const addMarker = (latlng: L.LatLng) => {
      markerRef.current = L.marker(latlng, { icon, draggable: true }).addTo(map);
      markerRef.current.on("dragend", () => {
        const pos = markerRef.current!.getLatLng().wrap();
        onChangeRef.current({ lat: pos.lat, lng: pos.lng });
      });
    };
    if (value) addMarker(L.latLng(value.lat, value.lng));
    map.on("click", (event: L.LeafletMouseEvent) => {
      if (markerRef.current) markerRef.current.setLatLng(event.latlng);
      else addMarker(event.latlng);
      // .wrap() folds a longitude picked on a panned-past-the-antimeridian world
      // copy back into ±180, which the server insists on.
      const point = event.latlng.wrap();
      onChangeRef.current({ lat: point.lat, lng: point.lng });
    });
    mapRef.current = map;
    const sizeTimer = window.setTimeout(() => map.invalidateSize(), 0);
    return () => {
      window.clearTimeout(sizeTimer);
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // Created once per mount; `value` only seeds the initial view/pin.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="gallery-mini-map gallery-location-picker" ref={containerRef} aria-label="Pick a location on the map" />;
}
