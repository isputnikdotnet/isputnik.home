import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { countryCentroid } from "./countryCentroids";

// Overview › Dashboard › Locations — where the sign-ins came from, on a real map.
//
// This replaced a bundled-SVG choropleth. The trade it makes is deliberate: the
// tiles come from OpenStreetMap, so drawing this map does make requests to a host
// outside the house — the same ones the gallery map and the home-location picker
// already make, and the only external host the CSP allows. Nothing about a sign-in
// is in those requests: a tile URL is a zoom level and a square of the world, and
// the addresses themselves are still resolved locally against the database kept
// with your data.
//
// Plain Leaflet driven through refs and effects, matching GalleryMap — no
// react-leaflet wrapper to version-couple.

export interface MapCountry {
  code: string;
  name: string | null;
  connections: number;
}

/** A place with coordinates — only ever present when a city database is in use. */
export interface MapPlace {
  code: string;
  city: string | null;
  region: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  connections: number;
}

export interface MapHome {
  latitude: number;
  longitude: number;
  label: string;
  connections: number;
}

// Area, not radius, carries the count: a bubble with ten times the connections
// should look ten times as big, and scaling the radius would make it a hundred.
function bubbleRadius(connections: number, max: number, base: number, span: number): number {
  return base + Math.sqrt(connections / Math.max(1, max)) * span;
}

// Five steps rather than a continuous ramp: on a family server one country holds
// almost every connection, and a linear scale would render every other country
// indistinguishable from empty.
function stepFor(connections: number, max: number): number {
  if (connections <= 0) return 0;
  const share = connections / Math.max(1, max);
  if (share > 0.6) return 4;
  if (share > 0.3) return 3;
  if (share > 0.1) return 2;
  return 1;
}

function plural(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "connection" : "connections"}`;
}

export function LocationsMap({
  countries,
  places = [],
  home = null,
  selected,
  onSelect
}: {
  countries: MapCountry[];
  places?: MapPlace[];
  /** The household's own location, when it has set one. */
  home?: MapHome | null;
  selected: string | null;
  onSelect: (code: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  // Every drawn shape by the country code it selects, so a click in the table
  // below can highlight and fly to the same thing without redrawing the layer.
  const shapesRef = useRef(new Map<string, L.CircleMarker[]>());
  // Both are read inside Leaflet handlers, which outlive the render that made them.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const towns = useMemo(
    // Biggest first so a small town drawn inside a big one stays clickable.
    () =>
      places
        .filter((place) => place.latitude !== null && place.longitude !== null)
        .sort((a, b) => b.connections - a.connections),
    [places]
  );

  // What a country bubble stands for once its towns are on the map: the sign-ins
  // the database placed in the country but in no town of it. Drawing the country's
  // full total on top of its own towns would count the same connections twice, and
  // dropping the country entirely would lose whatever the towns didn't cover — with
  // a city database that residual is usually nothing, and the bubble goes away.
  const bubbles = useMemo(() => {
    const townTotals = new Map<string, number>();
    for (const town of towns) {
      const code = town.code.toLowerCase();
      townTotals.set(code, (townTotals.get(code) ?? 0) + town.connections);
    }
    return countries.flatMap((entry) => {
      const code = entry.code.toLowerCase();
      const inTowns = townTotals.get(code) ?? 0;
      const connections = entry.connections - inTowns;
      const centre = countryCentroid(entry.code);
      if (connections <= 0 || !centre) return [];
      const name = entry.name ?? entry.code;
      return [{ code: entry.code, centre, connections, label: inTowns > 0 ? `${name}, elsewhere` : name }];
    });
  }, [countries, towns]);

  // Create the map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { worldCopyJump: true, minZoom: 1 }).setView([25, 10], 2);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    const layer = L.layerGroup().addTo(map);
    mapRef.current = map;
    layerRef.current = layer;
    // The container is sized by CSS, but settle any layout race so tiles fill it.
    const sizeTimer = window.setTimeout(() => map.invalidateSize(), 0);
    return () => {
      window.clearTimeout(sizeTimer);
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      shapesRef.current.clear();
    };
  }, []);

  // Redraw whenever the data changes, and frame what was drawn.
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    shapesRef.current.clear();

    const remember = (code: string, shape: L.CircleMarker) => {
      const list = shapesRef.current.get(code);
      if (list) list.push(shape);
      else shapesRef.current.set(code, [shape]);
    };
    const toggle = (code: string) => onSelectRef.current(selectedRef.current === code ? null : code);

    const bounds: L.LatLngExpression[] = [];

    const countryMax = bubbles.reduce((top, entry) => Math.max(top, entry.connections), 0);
    for (const entry of bubbles) {
      // Fill and stroke come from CSS (which beats Leaflet's presentation
      // attributes), so the bubbles follow the theme's accents.
      const shape = L.circleMarker(entry.centre, {
        radius: bubbleRadius(entry.connections, countryMax, 6, 16),
        className: `locations-map-country step-${stepFor(entry.connections, countryMax)}`
      });
      shape.bindTooltip(`${entry.label}: ${plural(entry.connections)}`, { direction: "top" });
      shape.on("click", () => toggle(entry.code));
      layer.addLayer(shape);
      remember(entry.code, shape);
      bounds.push(entry.centre);
    }

    const townMax = towns.reduce((top, place) => Math.max(top, place.connections), 0);
    for (const place of towns) {
      const point: L.LatLngExpression = [place.latitude!, place.longitude!];
      const where = [place.city, place.region, place.country ?? place.code].filter(Boolean).join(", ");
      const shape = L.circleMarker(point, {
        radius: bubbleRadius(place.connections, townMax, 4, 12),
        className: "locations-map-town"
      });
      shape.bindTooltip(`${where}: ${plural(place.connections)}`, { direction: "top" });
      shape.on("click", () => toggle(place.code));
      layer.addLayer(shape);
      remember(place.code, shape);
      bounds.push(point);
    }

    if (home) {
      const point: L.LatLngExpression = [home.latitude, home.longitude];
      // A ring rather than a filled pin, so it reads as a marker the household
      // placed rather than a measurement the database made.
      const icon = L.divIcon({
        className: "locations-map-home",
        html: '<span class="locations-map-home-ring"></span>',
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      });
      const marker = L.marker(point, { icon, title: home.label || "Home" });
      marker.bindTooltip(`${home.label || "Home"}: ${plural(home.connections)} from your own network`, {
        direction: "top"
      });
      layer.addLayer(marker);
      bounds.push(point);
    }

    // Frame the data, without animating: there is no view the reader has seen to
    // animate away from, and Leaflet's animated zoom waits on a CSS transition
    // that a hidden or non-compositing tab never fires — which would leave the
    // map sitting on its opening view. One point alone has no extent, so give it
    // a sensible zoom rather than letting fitBounds pick the maximum.
    if (bounds.length > 1) map.fitBounds(L.latLngBounds(bounds).pad(0.25), { maxZoom: 10, animate: false });
    else if (bounds.length === 1) map.setView(bounds[0], 5, { animate: false });
    else map.setView([25, 10], 2, { animate: false });
  }, [bubbles, towns, home]);

  // The selection is shared with the table below: whichever one is clicked, the
  // map highlights that country and moves to it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const [code, shapes] of shapesRef.current) {
      for (const shape of shapes) shape.getElement()?.classList.toggle("is-selected", code === selected);
    }
    if (!selected) return;
    const points = (shapesRef.current.get(selected) ?? []).map((shape) => shape.getLatLng());
    if (points.length === 1) map.flyTo(points[0], Math.max(map.getZoom(), 5), { duration: 0.6 });
    else if (points.length > 1) map.flyToBounds(L.latLngBounds(points).pad(0.4), { maxZoom: 9, duration: 0.6 });
  }, [selected, bubbles, towns]);

  return (
    <div className="locations-map">
      <div className="locations-map-canvas" ref={containerRef} aria-label="Connections by country" />
      {/* Only what is on the map: with a city database every country usually
          resolves to towns, and a key for country bubbles that were never drawn
          sends the reader looking for shapes that aren't there. */}
      <div className="locations-map-scale" aria-hidden="true">
        {home && <span className="locations-map-scale-home">Home</span>}
        {towns.length > 0 && <span className="locations-map-scale-town">Towns</span>}
        {bubbles.length > 0 && (
          <>
            <span className="locations-map-scale-country">Countries</span>
            <span>Fewer</span>
            {[1, 2, 3, 4].map((step) => (
              <span key={step} className={`locations-map-swatch step-${step}`} />
            ))}
            <span>More</span>
          </>
        )}
      </div>
    </div>
  );
}
