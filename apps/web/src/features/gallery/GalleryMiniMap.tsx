import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// A small, fixed location map for the lightbox Info panel — one marker at the photo's
// GPS point. Plain Leaflet via a ref (like GalleryMap), lazy-loaded so Leaflet stays
// off the initial bundle. Scroll-wheel zoom is off so scrolling the Info panel never
// gets hijacked by the map. A divIcon dot avoids Leaflet's bundler-broken default
// marker images.
export function GalleryMiniMap({ lat, lng, title }: { lat: number; lng: number; title: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);

  // Create the map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      center: [lat, lng],
      zoom: 14,
      scrollWheelZoom: false,
      attributionControl: true
    });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    const icon = L.divIcon({ className: "gallery-mini-marker", html: '<span class="gallery-mini-pin"></span>', iconSize: [18, 18], iconAnchor: [9, 9] });
    markerRef.current = L.marker([lat, lng], { icon, title }).addTo(map);
    mapRef.current = map;
    const sizeTimer = window.setTimeout(() => map.invalidateSize(), 0);
    return () => {
      window.clearTimeout(sizeTimer);
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // Created once; recentering on navigation is handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Navigating to another photo while the panel is open recenters in place (no remount).
  useEffect(() => {
    if (!mapRef.current || !markerRef.current) return;
    mapRef.current.setView([lat, lng], mapRef.current.getZoom());
    markerRef.current.setLatLng([lat, lng]);
  }, [lat, lng]);

  return <div className="gallery-mini-map" ref={containerRef} aria-label={`Map showing where ${title} was taken`} />;
}
