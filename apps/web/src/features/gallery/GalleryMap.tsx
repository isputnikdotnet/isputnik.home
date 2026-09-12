import { useMemo } from "react";
import { MapView } from "../../shared/map";
import type { MapShapes, MapViewCommand } from "../../shared/map";
import type { GalleryMapPoint } from "./types";

// Map view over geotagged assets. Markers are thumbnail pins, clustered, and
// clicking one opens the asset in the lightbox.
export function GalleryMap({ points, onOpen }: { points: GalleryMapPoint[]; onOpen: (id: string) => void }) {
  const options = useMemo(
    () => ({
      center: [20, 0] as [number, number],
      zoom: 2,
      worldCopyJump: true,
      cluster: true,
      clusterRadius: 50
    }),
    []
  );

  const shapes = useMemo<MapShapes>(
    () => ({
      markers: points.map((point) => ({
        id: point.id,
        lat: point.lat,
        lng: point.lng,
        className: "gallery-map-marker",
        // Only ever a server-generated cover path — nothing user-typed reaches
        // this markup. The filename goes through `title`, which is set on the
        // element through the DOM and so cannot break out.
        html: `<span class="gallery-map-pin${point.kind === "video" ? " is-video" : ""}">${
          point.coverUrl ? `<img src="${point.coverUrl}" alt="" loading="lazy">` : ""
        }</span>`,
        size: [42, 42] as [number, number],
        title: point.title
      }))
    }),
    [points]
  );

  // Reframe on every result set — the points ARE what the reader asked for.
  const view = useMemo<MapViewCommand | null>(
    () => (points.length === 0 ? null : {
      kind: "fit",
      points: points.map((point) => [point.lat, point.lng] as [number, number]),
      pad: 0.2,
      maxZoom: 16
    }),
    [points]
  );

  return <MapView options={options} shapes={shapes} view={view} onMarkerClick={onOpen} className="gallery-map" />;
}
