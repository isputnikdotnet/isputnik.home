import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import L from "leaflet";
import "leaflet.markercluster";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import type { GalleryMapPoint } from "./types";
import { OSM_TILE_OPTIONS, OSM_TILE_URL } from "../../shared/mapTiles";

// Map view over geotagged assets. Plain Leaflet (no react-leaflet) driven through a
// ref + effects, so there's no extra wrapper library to version-couple. Markers are
// thumbnail pins clustered with leaflet.markercluster; clicking one opens the asset
// in the lightbox. Base tiles come from OpenStreetMap (the one external resource the
// CSP allows — see imgSrc in the server).
export function GalleryMap({ points, onOpen }: { points: GalleryMapPoint[]; onOpen: (id: string) => void }) {
  const { t } = useTranslation(["common", "gallery"]);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const clusterRef = useRef<L.MarkerClusterGroup | null>(null);
  // onOpen is read inside marker handlers; a ref keeps them current without
  // rebuilding the map on every render.
  const onOpenRef = useRef(onOpen);
  // The tile credit is read once, when the layer is added. Same trick as onOpen:
  // the ref hands the current wording to the create-once effect without making the
  // map depend on `t` — which would tear the map down, and the viewport with it,
  // every time the interface language changed. Nothing is lost by that: the
  // language is chosen on another page, so this map is rebuilt on the way back.
  const attributionRef = useRef(t("gallery:map.osmAttributionContributors"));

  // Both refs are refreshed after every commit rather than while rendering — the
  // only readers are a marker click and the create-once effect below, and effects
  // run in the order they are written, so this one has already landed by then.
  useEffect(() => {
    onOpenRef.current = onOpen;
    attributionRef.current = t("gallery:map.osmAttributionContributors");
  });

  // Create the map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { worldCopyJump: true }).setView([20, 0], 2);
    L.tileLayer(OSM_TILE_URL, {
      ...OSM_TILE_OPTIONS,
      attribution: attributionRef.current
    }).addTo(map);
    const cluster = L.markerClusterGroup({ maxClusterRadius: 50 });
    map.addLayer(cluster);
    mapRef.current = map;
    clusterRef.current = cluster;
    // The container is sized by CSS, but settle any layout race so tiles fill it.
    const sizeTimer = window.setTimeout(() => map.invalidateSize(), 0);
    return () => {
      window.clearTimeout(sizeTimer);
      map.remove();
      mapRef.current = null;
      clusterRef.current = null;
    };
  }, []);

  // Rebuild markers whenever the point set changes, and frame them.
  useEffect(() => {
    const map = mapRef.current;
    const cluster = clusterRef.current;
    if (!map || !cluster) return;
    cluster.clearLayers();
    if (points.length === 0) return;

    const latlngs: L.LatLngExpression[] = [];
    for (const point of points) {
      const icon = L.divIcon({
        className: "gallery-map-marker",
        html: `<span class="gallery-map-pin${point.kind === "video" ? " is-video" : ""}">${
          point.coverUrl ? `<img src="${point.coverUrl}" alt="" loading="lazy">` : ""
        }</span>`,
        iconSize: [42, 42],
        iconAnchor: [21, 21]
      });
      // `title` is set on the element by Leaflet via the DOM (escaped), so a filename
      // with quotes can't break out — unlike the thumbnail HTML, which only ever
      // carries a server-generated cover path.
      const marker = L.marker([point.lat, point.lng], { icon, title: point.title });
      marker.on("click", () => onOpenRef.current(point.id));
      cluster.addLayer(marker);
      latlngs.push([point.lat, point.lng]);
    }
    map.fitBounds(L.latLngBounds(latlngs).pad(0.2), { maxZoom: 16 });
  }, [points]);

  return <div className="gallery-map" ref={containerRef} />;
}
