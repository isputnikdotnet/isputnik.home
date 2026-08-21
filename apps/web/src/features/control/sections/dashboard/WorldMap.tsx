import World from "@svg-maps/world";
import { projectToMap } from "./mapProjection";

// A choropleth of the world, drawn from a bundled SVG path set (@svg-maps/world,
// CC BY 4.0) rather than map tiles: the app's CSP allows no external hosts, and a
// tile server would also tell someone else which countries this house is looking
// at. Country shading only — the database behind it is country-granular, so a
// pin dropped on a town would be an invention.

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

// Area, not radius, carries the count: a dot with ten times the connections
// should look ten times as big, and squaring the radius would make it a hundred.
function dotRadius(connections: number, max: number): number {
  const share = Math.sqrt(connections / Math.max(1, max));
  return 2.2 + share * 6;
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

export function WorldMap({
  countries,
  places = [],
  home = null,
  selected,
  onSelect
}: {
  countries: MapCountry[];
  places?: MapPlace[];
  /** The household's own location, when it has set one. */
  home?: { latitude: number; longitude: number; label: string; connections: number } | null;
  selected: string | null;
  onSelect: (code: string | null) => void;
}) {
  const byCode = new Map(countries.map((entry) => [entry.code.toLowerCase(), entry]));
  const max = countries.reduce((top, entry) => Math.max(top, entry.connections), 0);
  // A city database gives coordinates; without one this is empty and the map is
  // shading alone. Biggest first so a small dot inside a big one stays clickable.
  const dots = places
    .map((place) => {
      const point =
        place.latitude !== null && place.longitude !== null ? projectToMap(place.latitude, place.longitude) : null;
      return point ? { place, point } : null;
    })
    .filter((entry): entry is { place: MapPlace; point: { x: number; y: number } } => entry !== null)
    .sort((a, b) => b.place.connections - a.place.connections);
  const dotMax = dots.reduce((top, entry) => Math.max(top, entry.place.connections), 0);
  const homePoint = home ? projectToMap(home.latitude, home.longitude) : null;
  const homeLabel = home
    ? `${home.label || "Home"}: ${home.connections} ${home.connections === 1 ? "connection" : "connections"} from your own network`
    : "";

  return (
    <div className="world-map">
      <svg viewBox={World.viewBox} role="img" aria-label="Connections by country" preserveAspectRatio="xMidYMid meet">
        {World.locations.map((location) => {
          const hit = byCode.get(location.id);
          const step = hit ? stepFor(hit.connections, max) : 0;
          const isSelected = Boolean(hit) && selected === hit!.code;
          const label = hit
            ? `${hit.name ?? location.name}: ${hit.connections} ${hit.connections === 1 ? "connection" : "connections"}`
            : location.name;
          return (
            <path
              key={location.id}
              data-code={location.id}
              d={location.path}
              className={`world-map-country step-${step}${isSelected ? " is-selected" : ""}`}
              // Only a country with connections is worth clicking; the rest are
              // scenery, and making them focusable would put 250 empty stops in
              // the tab order.
              tabIndex={hit ? 0 : undefined}
              role={hit ? "button" : undefined}
              aria-label={hit ? label : undefined}
              onClick={hit ? () => onSelect(isSelected ? null : hit.code) : undefined}
              onKeyDown={
                hit
                  ? (event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(isSelected ? null : hit.code);
                      }
                    }
                  : undefined
              }
            >
              <title>{label}</title>
            </path>
          );
        })}

        {homePoint && (
          <g className="world-map-home" role="img" aria-label={homeLabel}>
            <circle cx={homePoint.x} cy={homePoint.y} r={7} />
            <circle cx={homePoint.x} cy={homePoint.y} r={2.6} className="world-map-home-core" />
            <title>{homeLabel}</title>
          </g>
        )}

        {dots.map(({ place, point }) => {
          const where = [place.city, place.region, place.country ?? place.code].filter(Boolean).join(", ");
          const label = `${where}: ${place.connections} ${place.connections === 1 ? "connection" : "connections"}`;
          return (
            <circle
              key={`${place.code}-${place.region ?? ""}-${place.city ?? ""}`}
              className={`world-map-dot${selected === place.code ? " is-selected" : ""}`}
              cx={point.x}
              cy={point.y}
              r={dotRadius(place.connections, dotMax)}
              onClick={() => onSelect(selected === place.code ? null : place.code)}
            >
              <title>{label}</title>
            </circle>
          );
        })}
      </svg>

      <div className="world-map-scale" aria-hidden="true">
        {home && <span className="world-map-scale-home">Home</span>}
        {dots.length > 0 && <span className="world-map-scale-dot">Towns</span>}
        <span>Fewer</span>
        {[1, 2, 3, 4].map((step) => (
          <span key={step} className={`world-map-swatch step-${step}`} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}
