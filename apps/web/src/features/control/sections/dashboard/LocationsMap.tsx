import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { countryCentroid } from "./countryCentroids";
import { MapView } from "../../../../shared/map";
import type { LatLng, MapShapes, MapViewCommand } from "../../../../shared/map";

// Overview › Dashboard › Locations — where the sign-ins came from, on a real map.
//
// The addresses themselves are resolved locally, against the database kept with
// your data. The base map is another matter until map caching is on: the tiles a
// page asks for outline the region it is framing, so with caching off the provider
// can see roughly where this household signs in from. With it on, every tile comes
// through this server (docs/map-approach-proposal.md).

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

/** A stable empty default. `places = []` would hand `towns` a new array on every
 *  render, which cascades into `bubbles` and then into the framing effect below
 *  — and since that effect sets state, the re-render it causes would rebuild the
 *  array again, for ever. The old map got away with it by calling fitBounds
 *  imperatively; this one must not. */
const NO_PLACES: MapPlace[] = [];

export function LocationsMap({
  countries,
  places = NO_PLACES,
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
  const { t } = useTranslation(["common", "controlDash"]);
  // Memoised because the shapes below depend on it: rebuilt every render, it
  // would redraw every shape on the map on every render.
  const plural = useCallback((count: number) => t("controlDash:map.connections", { count }), [t]);

  const options = useMemo(
    () => ({
      center: [25, 10] as LatLng,
      zoom: 2,
      minZoom: 1,
      worldCopyJump: true
    }),
    []
  );

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
      return [{ code: entry.code, centre, connections, label: inTowns > 0 ? t("controlDash:map.elsewhere", { name }) : name }];
    });
  }, [countries, towns, t]);

  const shapes = useMemo<MapShapes>(() => {
    const countryMax = bubbles.reduce((top, entry) => Math.max(top, entry.connections), 0);
    const townMax = towns.reduce((top, place) => Math.max(top, place.connections), 0);
    return {
      circles: [
        ...bubbles.map((entry) => ({
          id: entry.code,
          lat: entry.centre[0],
          lng: entry.centre[1],
          radius: bubbleRadius(entry.connections, countryMax, 6, 16),
          className: `locations-map-country step-${stepFor(entry.connections, countryMax)}`,
          tooltip: `${entry.label}: ${plural(entry.connections)}`,
          selected: entry.code === selected
        })),
        ...towns.map((place, index) => {
          const where = [place.city, place.region, place.country ?? place.code].filter(Boolean).join(", ");
          return {
            // Towns share their country's code — that is what a click selects —
            // so the id carries the row as well, to stay unique.
            id: `${place.code}#${index}`,
            lat: place.latitude!,
            lng: place.longitude!,
            radius: bubbleRadius(place.connections, townMax, 4, 12),
            className: "locations-map-town",
            tooltip: `${where}: ${plural(place.connections)}`,
            selected: place.code === selected
          };
        })
      ],
      markers: home
        ? [{
            id: "home",
            lat: home.latitude,
            lng: home.longitude,
            // A ring rather than a filled pin, so it reads as a marker the
            // household placed rather than a measurement the database made.
            className: "locations-map-home",
            html: '<span class="locations-map-home-ring"></span>',
            size: [22, 22] as [number, number],
            title: home.label || t("controlDash:map.home"),
            tooltip: t("controlDash:map.homeTooltip", {
              label: home.label || t("controlDash:map.home"),
              connections: plural(home.connections)
            })
          }]
        : []
    };
  }, [bubbles, towns, home, selected, plural, t]);

  const [view, setView] = useState<MapViewCommand | null>(null);

  // Frame the data, without animating: there is no view the reader has seen to
  // animate away from, and Leaflet's animated zoom waits on a CSS transition
  // that a hidden or non-compositing tab never fires — which would leave the
  // map sitting on its opening view. One point alone has no extent, so give it
  // a sensible zoom rather than letting the fit pick the maximum.
  useEffect(() => {
    const points: LatLng[] = [
      ...bubbles.map((entry) => entry.centre),
      ...towns.map((place) => [place.latitude!, place.longitude!] as LatLng),
      ...(home ? [[home.latitude, home.longitude] as LatLng] : [])
    ];
    setView({
      kind: "fit",
      points,
      pad: 0.25,
      maxZoom: 10,
      animate: false,
      single: { zoom: 5 },
      empty: { center: [25, 10], zoom: 2 }
    });
  }, [bubbles, towns, home]);

  // The selection is shared with the table below: whichever one is clicked, the
  // map highlights that country and moves to it. Issued after the framing effect
  // so a selection made in the same commit wins.
  useEffect(() => {
    if (!selected) return;
    const points: LatLng[] = [
      ...bubbles.filter((entry) => entry.code === selected).map((entry) => entry.centre),
      ...towns.filter((place) => place.code === selected).map((place) => [place.latitude!, place.longitude!] as LatLng)
    ];
    if (points.length === 0) return;
    setView({ kind: "fly", points, minZoom: 5, maxZoom: 9, duration: 0.6 });
  }, [selected, bubbles, towns]);

  return (
    <div className="locations-map">
      <MapView
        options={options}
        shapes={shapes}
        view={view}
        onCircleClick={(id) => {
          const code = id.split("#")[0];
          onSelect(selected === code ? null : code);
        }}
        className="locations-map-canvas"
        ariaLabel={t("controlDash:map.canvasAria")}
      />
      {/* Only what is on the map: with a city database every country usually
          resolves to towns, and a key for country bubbles that were never drawn
          sends the reader looking for shapes that aren't there. */}
      <div className="locations-map-scale" aria-hidden="true">
        {home && <span className="locations-map-scale-home">{t("controlDash:map.home")}</span>}
        {towns.length > 0 && <span className="locations-map-scale-town">{t("controlDash:map.towns")}</span>}
        {bubbles.length > 0 && (
          <>
            <span className="locations-map-scale-country">{t("controlDash:map.countries")}</span>
            <span>{t("controlDash:map.fewer")}</span>
            {[1, 2, 3, 4].map((step) => (
              <span key={step} className={`locations-map-swatch step-${step}`} />
            ))}
            <span>{t("controlDash:map.more")}</span>
          </>
        )}
      </div>
    </div>
  );
}
