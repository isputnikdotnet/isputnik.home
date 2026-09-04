import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { StoryMapPoint } from "./types";

// The editing half of a map block: click the map to add a stop, drag a stop to
// correct it, and watch the route redraw between them. Plain Leaflet via refs,
// the same pattern as GalleryLocationPicker — which stays deliberately
// single-pin, because a photo was taken in one place and a journey was not.
export function StoryRoutePicker({
  points,
  onAdd,
  onMove,
  focus
}: {
  points: StoryMapPoint[];
  /** A click on the map appends a stop at the end of the route. */
  onAdd: (point: { lat: number; lng: number }) => void;
  /** A stop dragged to a better spot keeps its place in the order. */
  onMove: (index: number, point: { lat: number; lng: number }) => void;
  /** Recentre from outside (a place-search result). The nonce is what triggers
   *  it, so picking the same place twice still moves the view back. */
  focus?: { lat: number; lng: number; zoom?: number; nonce: number } | null;
}) {
  const { t } = useTranslation(["gallery", "stories"]);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  // The map's handlers live for the map's lifetime; always call the latest ones.
  const onAddRef = useRef(onAdd);
  onAddRef.current = onAdd;
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  // Whether the view has been framed on the stops it opened with. Done once, on
  // the first render that has any: after that the view belongs to the editor,
  // and refitting on every added stop would yank the map out from under them.
  // Cleared with the map, so React's development double-mount reframes the map
  // it actually kept rather than the one it threw away.
  const framedRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      center: [25, 10],
      zoom: 1,
      attributionControl: true
    });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: t("gallery:map.osmAttribution")
    }).addTo(map);
    map.on("click", (event: L.LeafletMouseEvent) => {
      // .wrap() folds a longitude picked on a panned-past-the-antimeridian world
      // copy back into ±180, which the server insists on.
      const point = event.latlng.wrap();
      onAddRef.current({ lat: point.lat, lng: point.lng });
    });
    mapRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);
    const sizeTimer = window.setTimeout(() => map.invalidateSize(), 0);
    return () => {
      window.clearTimeout(sizeTimer);
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      framedRef.current = false;
    };
    // Created once per mount; the stops are drawn by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redraw the whole route whenever the stops change — a handful of markers is
  // cheaper to rebuild than to diff, and reordering moves every number anyway.
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    if (points.length === 0) return;
    if (points.length > 1) {
      L.polyline(points.map((point) => [point.lat, point.lng] as [number, number]), {
        className: "story-map-route",
        weight: 3,
        dashArray: "6 6",
        interactive: false
      }).addTo(layer);
    }
    points.forEach((point, index) => {
      const icon = L.divIcon({
        className: "story-map-marker",
        html: `<span class="story-map-pin">${index + 1}</span>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });
      const marker = L.marker([point.lat, point.lng], {
        icon,
        draggable: true,
        title: point.label ?? String(index + 1)
      }).addTo(layer);
      marker.on("dragend", () => {
        const moved = marker.getLatLng().wrap();
        onMoveRef.current(index, { lat: moved.lat, lng: moved.lng });
      });
    });
    if (framedRef.current) return;
    // Framing waits a tick: the dialog has only just opened, and fitting while
    // Leaflet still believes its container is 0×0 lands on the whole world.
    const bounds = L.latLngBounds(points.map((point) => [point.lat, point.lng] as [number, number]));
    const fitTimer = window.setTimeout(() => {
      // A place search in the same tick already chose the view; framing over it
      // would snap the map away from what the author just looked up.
      if (framedRef.current) return;
      framedRef.current = true;
      map.invalidateSize();
      map.fitBounds(bounds.pad(0.25), { maxZoom: 13 });
    }, 0);
    return () => window.clearTimeout(fitTimer);
  }, [points]);

  // A search result: move the view there. The stop itself is appended by the
  // modal, so this only decides where the editor is looking.
  useEffect(() => {
    if (!focus || !mapRef.current) return;
    framedRef.current = true;
    mapRef.current.setView(L.latLng(focus.lat, focus.lng), focus.zoom ?? 13);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  return (
    <div
      className="gallery-mini-map story-route-picker"
      ref={containerRef}
      aria-label={t("stories:map.pickerAria")}
    />
  );
}
