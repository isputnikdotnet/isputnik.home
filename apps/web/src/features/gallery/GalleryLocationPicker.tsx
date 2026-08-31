import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Click-to-place location picker for the lightbox Info panel: click the map (or
// drag the pin) to choose where a photo was taken. Plain Leaflet via refs like
// GalleryMiniMap, lazy-loaded so Leaflet stays off the initial bundle. Unlike the
// read-only mini map, scroll-wheel zoom stays on — picking a point is a deliberate
// interaction that needs zooming.
export function GalleryLocationPicker({
  value,
  onChange,
  focus
}: {
  value: { lat: number; lng: number } | null;
  onChange: (next: { lat: number; lng: number }) => void;
  /** Recentre + drop the pin from outside the map (a place-search result). The
   *  nonce is what triggers it, so picking the same place twice still moves the
   *  view back, and a click on the map never re-fires this. */
  focus?: { lat: number; lng: number; zoom?: number; nonce: number } | null;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const placeRef = useRef<((latlng: L.LatLng) => void) | null>(null);
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
      attribution: t("gallery:map.osmAttribution")
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
    // Shared by map clicks and the search box, which reaches it through the ref
    // below (the map is built once, so `focus` can't close over this directly).
    placeRef.current = (latlng: L.LatLng) => {
      if (markerRef.current) markerRef.current.setLatLng(latlng);
      else addMarker(latlng);
    };
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

  // A search result: move the view there and put the pin on it. Keyed on the
  // nonce alone so re-renders (busy flags, hint text) don't yank the map back.
  useEffect(() => {
    if (!focus || !mapRef.current) return;
    const latlng = L.latLng(focus.lat, focus.lng);
    mapRef.current.setView(latlng, focus.zoom ?? 13);
    placeRef.current?.(latlng);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  return <div className="gallery-mini-map gallery-location-picker" ref={containerRef} aria-label={t("gallery:locationPicker.aria")} />;
}
