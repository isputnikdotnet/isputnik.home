import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { MapView } from "../../shared/map";
import type { MapShapes, MapViewCommand } from "../../shared/map";

// A small, fixed location map for the lightbox Info panel — one marker at the photo's
// GPS point. Scroll-wheel zoom is off so scrolling the Info panel never gets hijacked
// by the map.
export function GalleryMiniMap({
  lat,
  lng,
  title,
  zoom = 14,
  className
}: {
  lat: number;
  lng: number;
  title: string;
  /** Closer for a photo's exact spot, wider for a story's "somewhere around here". */
  zoom?: number;
  /** Extra class for a caller with its own sizing (a story map block is tall). */
  className?: string;
}) {
  const { t } = useTranslation(["common", "gallery"]);

  const options = useMemo(
    () => ({
      center: [lat, lng] as [number, number],
      zoom,
      scrollWheelZoom: false
    }),
    // Read once, when the map is built; later moves go through `view` below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const shapes = useMemo<MapShapes>(
    () => ({
      markers: [{
        id: "here",
        lat,
        lng,
        className: "gallery-mini-marker",
        html: '<span class="gallery-mini-pin"></span>',
        size: [18, 18],
        title
      }]
    }),
    [lat, lng, title]
  );

  // Navigating to another photo while the panel is open recenters in place, at
  // whatever zoom the reader had chosen (no zoom given = keep the current one).
  const view = useMemo<MapViewCommand>(() => ({ kind: "center", center: [lat, lng] }), [lat, lng]);

  return (
    <MapView
      options={options}
      shapes={shapes}
      view={view}
      className={["gallery-mini-map", className].filter(Boolean).join(" ")}
      ariaLabel={t("gallery:miniMap.aria", { title })}
    />
  );
}
