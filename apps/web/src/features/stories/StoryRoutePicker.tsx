import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MapView } from "../../shared/map";
import type { LatLng, MapShapes, MapViewCommand } from "../../shared/map";
import { ROUTING_ATTRIBUTION, routeShapes } from "./story-route-shapes";
import type { StoryMapPoint } from "./types";

// The editing half of a map block: click the map to add a stop, drag a stop to
// correct it, and watch the route redraw between them. Deliberately unlike
// GalleryLocationPicker, which stays single-pin — because a photo was taken in
// one place and a journey was not.
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

  const options = useMemo(
    () => ({ center: [25, 10] as LatLng, zoom: 1 }),
    []
  );

  const drawn = useMemo(() => (points.length > 1 ? routeShapes(points) : null), [points]);

  // A handful of markers is cheaper to rebuild than to diff, and reordering
  // moves every number anyway.
  const shapes = useMemo<MapShapes>(() => ({
    lines: drawn?.lines ?? [],
    markers: [
      ...(drawn?.badges ?? []),
      ...points.map((point, index) => ({
        id: String(index),
        lat: point.lat,
        lng: point.lng,
        className: "story-map-marker",
        html: `<span class="story-map-pin">${index + 1}</span>`,
        size: [30, 30] as [number, number],
        draggable: true,
        title: point.label ?? String(index + 1)
      }))
    ]
  }), [drawn, points]);

  const attributions = useMemo(() => (drawn?.routed ? [ROUTING_ATTRIBUTION] : []), [drawn]);

  // Framing happens once, on the first render that has any stops: after that
  // the view belongs to the editor, and refitting on every added stop would
  // yank the map out from under them.
  const framedRef = useRef(false);
  const [view, setView] = useState<MapViewCommand | null>(null);

  useEffect(() => {
    if (framedRef.current || points.length === 0) return;
    framedRef.current = true;
    // Deferred: the dialog has only just opened, and fitting while the map
    // still believes its container is 0×0 lands on the whole world.
    setView({
      kind: "fit",
      points: points.map((point) => [point.lat, point.lng] as LatLng),
      pad: 0.25,
      maxZoom: 13,
      defer: true
    });
  }, [points]);

  // A search result: move the view there. The stop itself is appended by the
  // modal, so this only decides where the editor is looking. Issued after the
  // framing effect above, so a search in the same commit wins — and it cancels
  // the deferred fit rather than being snapped away by it.
  useEffect(() => {
    if (!focus) return;
    framedRef.current = true;
    setView({ kind: "center", center: [focus.lat, focus.lng], zoom: focus.zoom ?? 13 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  return (
    <MapView
      options={options}
      shapes={shapes}
      view={view}
      attributions={attributions}
      onMapClick={onAdd}
      onMarkerDragEnd={(id, point) => onMove(Number(id), point)}
      className="gallery-mini-map story-route-picker"
      ariaLabel={t("stories:map.pickerAria")}
    />
  );
}
