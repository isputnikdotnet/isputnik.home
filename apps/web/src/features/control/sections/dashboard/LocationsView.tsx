import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { ChevronRight, Database, Globe2, House, MapPin, ShieldQuestion } from "lucide-react";
import { api } from "../../../../api";
import { navigate } from "../../../../router";
import { Button } from "../../../../shared/Button";
import { signInsHref } from "./SignInsSection";
import { KpiCard } from "../../../../shared/KpiCard";
import { MessageBox } from "../../../../shared/MessageBox";
import {
  DateRangePicker,
  formatRangeLabel,
  resolveDateRange,
  type DateRangeValue
} from "../../../../shared/DateRangePicker";
import { Pager } from "../../../../shared/Pager";
import { SortHeader, type SortDirection } from "../../../../shared/SortHeader";
import { countryFlag, countryName, formatBytes, formatManagedDate } from "../../../../shared/utils";
import type { DashboardLocations, HomeLocation } from "../../types";
import { GeoipDatabaseModal } from "./GeoipDatabaseModal";
import { HomeLocationModal } from "./HomeLocationModal";
import { polyfillCountryFlagEmojis } from "country-flag-emoji-polyfill";
import flagFontUrl from "country-flag-emoji-polyfill/dist/TwemojiCountryFlags.woff2?url";

// Windows draws two letters where every other platform draws a flag — its system
// fonts simply have no flag glyphs. This injects a small font of nothing but
// flags, and only on browsers that need it; the font ships with the app (fontSrc
// 'self'), so no request leaves the house for it.
polyfillCountryFlagEmojis("Twemoji Country Flags", flagFontUrl);

// Overview › Dashboard › Locations. Where the sign-ins in a window came from,
// resolved on the server against a local database — no address is ever sent out
// to look one up. The two things that can be changed here — which database is in
// use, and where home is — sit as buttons under the map, each opening its own
// dialog, rather than as forms the page has to carry.

// Lazy like the gallery's map and the home picker, so Leaflet and the tile CSS
// stay off the bundle until someone opens this tab.
const LocationsMap = lazy(() => import("./LocationsMap").then((m) => ({ default: m.LocationsMap })));

// Ten rows a page: the tables sit under a map that is already most of a screen,
// and the point of a long tail of one-connection countries is reachable through
// the pager, not by scrolling past it.
const PAGE_SIZE = 10;

type LocationSort = "name" | "connections" | "failed" | "addresses" | "rate";

// One comparator for both tables: names alphabetically, numbers with a name
// tiebreak so equal counts keep a stable, readable order either direction.
function bySort<T extends { connections: number; failed: number; addresses: number }>(
  sort: LocationSort,
  dir: SortDirection,
  nameOf: (row: T) => string
) {
  const factor = dir === "asc" ? 1 : -1;
  const metric = (row: T) => (sort === "rate" ? failRate(row) : row[sort as Exclude<LocationSort, "name" | "rate">]);
  return (a: T, b: T) => {
    if (sort === "name") return nameOf(a).localeCompare(nameOf(b)) * factor;
    return (metric(a) - metric(b)) * factor || nameOf(a).localeCompare(nameOf(b));
  };
}

function failRate(row: { connections: number; failed: number }): number {
  return row.connections > 0 ? row.failed / row.connections : 0;
}

// "0%" and "100%" plain, one decimal for everything in between — the pill is a
// glance, not a report.
function formatRate(rate: number): string {
  const percent = rate * 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

// Green only for a clean record; any failure at all is worth an amber glance,
// and a fifth of attempts failing is the address-under-attack shape.
function rateTone(rate: number): string {
  if (rate === 0) return "rate-good";
  return rate < 0.2 ? "rate-warn" : "rate-bad";
}

/** Flag beside the stacked name and detail line — the leading cell of both tables. */
function LocationCell({ flag, title, sub }: { flag: string; title: string; sub: string }) {
  return (
    <span className="location-cell">
      <span className="country-flag" aria-hidden="true">{flag}</span>
      <span className="datagrid-primary">
        <strong>{title}</strong>
        <small>{sub}</small>
      </span>
    </span>
  );
}

/** The connection count with its share of the table's biggest row drawn beside it. */
function ConnectionsCell({ connections, max }: { connections: number; max: number }) {
  return (
    <span className="conn-cell">
      <span className="conn-count">{connections.toLocaleString()}</span>
      <span className="conn-track" aria-hidden="true">
        <span className="conn-fill" style={{ width: `${Math.max(4, Math.round((connections / Math.max(1, max)) * 100))}%` }} />
      </span>
    </span>
  );
}

function pageOf<T>(rows: T[], page: number): { rows: T[]; page: number; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, totalPages);
  return { rows: rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE), page: current, totalPages };
}

export function LocationsView() {
  const [range, setRange] = useState<DateRangeValue>(() => resolveDateRange("30d"));
  const [data, setData] = useState<DashboardLocations | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [databaseOpen, setDatabaseOpen] = useState(false);
  const [homeOpen, setHomeOpen] = useState(false);
  const [countrySort, setCountrySort] = useState<LocationSort>("connections");
  const [countryDir, setCountryDir] = useState<SortDirection>("desc");
  const [countryPage, setCountryPage] = useState(1);
  const [placeSort, setPlaceSort] = useState<LocationSort>("connections");
  const [placeDir, setPlaceDir] = useState<SortDirection>("desc");
  const [placePage, setPlacePage] = useState(1);

  const load = (from: string, to: string) => {
    const query = new URLSearchParams({ from, to });
    setError("");
    return api<DashboardLocations>(`/api/dashboard/locations?${query}`)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load locations"));
  };

  useEffect(() => {
    load(range.from, range.to);
    setSelected(null);
    setCountryPage(1);
    setPlacePage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to]);

  const countryLabel = (entry: DashboardLocations["countries"][number]) =>
    entry.name ?? countryName(entry.code) ?? entry.code;
  const placeLabel = (place: DashboardLocations["places"][number]) =>
    place.city ?? place.region ?? "Unnamed place";

  const countries = useMemo(
    () => pageOf([...(data?.countries ?? [])].sort(bySort(countrySort, countryDir, countryLabel)), countryPage),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, countrySort, countryDir, countryPage]
  );
  const places = useMemo(
    () => pageOf([...(data?.places ?? [])].sort(bySort(placeSort, placeDir, placeLabel)), placePage),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, placeSort, placeDir, placePage]
  );

  // The bars draw each row's share of the table's biggest, so the scale belongs
  // to the whole dataset, not the visible page. Home joins the country scale —
  // its row sits in that table.
  const countryMax = useMemo(
    () => Math.max(data?.local.connections ?? 0, ...(data?.countries ?? []).map((entry) => entry.connections), 1),
    [data]
  );
  const placeMax = useMemo(() => Math.max(...(data?.places ?? []).map((place) => place.connections), 1), [data]);

  const sortCountries = (sort: LocationSort, dir: SortDirection) => {
    setCountrySort(sort);
    setCountryDir(dir);
    setCountryPage(1);
  };
  const sortPlaces = (sort: LocationSort, dir: SortDirection) => {
    setPlaceSort(sort);
    setPlaceDir(dir);
    setPlacePage(1);
  };

  const placed = data ? data.countries.reduce((sum, entry) => sum + entry.connections, 0) : 0;
  // The map redraws and re-frames itself whenever this changes, so it has to be
  // the same object between renders — built inline it would rebuild every layer
  // on each click in the table below, snapping the view back with it.
  const home = useMemo(
    () => (data?.home ? { ...data.home, connections: data.local.connections } : null),
    [data?.home, data?.local.connections]
  );

  return (
    <div className="status-stack">
      <section className="status-block">
        {data && !data.geoip.available && (
          <MessageBox tone="info" title="No location database yet">
            <p>
              Countries come from a database kept with your data and read on this server — no address is ever sent out
              to look one up. Fetch the free one (about 9 MB) to start placing connections on the map.
            </p>
            <div className="modal-actions">
              <Button variant="primary" onClick={() => setDatabaseOpen(true)}>Set up the database</Button>
            </div>
          </MessageBox>
        )}

        {error && <MessageBox tone="error" title="Unable to load locations">{error}</MessageBox>}

        {data && (
          <>
            <div className="kpi-cards">
              <KpiCard
                icon={Globe2}
                tone="info"
                label="Countries"
                value={String(data.countries.length)}
                context={`${placed.toLocaleString()} of ${data.total.toLocaleString()} sign-ins placed`}
              />
              <KpiCard
                icon={House}
                tone="success"
                label={data.home?.label || "Home network"}
                value={data.local.connections.toLocaleString()}
                context={`${data.local.addresses} ${data.local.addresses === 1 ? "address" : "addresses"} inside the house`}
              />
              <KpiCard
                icon={MapPin}
                tone="warning"
                label="From outside"
                value={(data.total - data.local.connections).toLocaleString()}
                context="Sign-ins from the internet"
              />
              <KpiCard
                icon={ShieldQuestion}
                tone="danger"
                label="Unplaced"
                value={data.unknown.connections.toLocaleString()}
                context={data.geoip.available ? "Address not in the database" : "No database yet"}
              />
            </div>

            <div className="status-range-row">
              <DateRangePicker value={range} onChange={setRange} label="Locations time range" />
              <span className="status-range-label">{formatRangeLabel(range)}</span>
            </div>

            <div className="status-subsection">
              <div className="status-table-title">
                <h3>Where connections came from</h3>
                {data.geoip.updatedAt && (
                  <span>
                    Database {formatManagedDate(data.geoip.updatedAt)}
                    {data.geoip.sizeBytes ? ` · ${formatBytes(data.geoip.sizeBytes)}` : ""}
                  </span>
                )}
              </div>

              <Suspense fallback={<div className="locations-map locations-map--loading" />}>
                <LocationsMap
                  countries={data.countries}
                  places={data.places}
                  home={home}
                  selected={selected}
                  onSelect={setSelected}
                />
              </Suspense>

              {/* What the bubbles actually count, said plainly: a map that can
                  only place some of the sign-ins should say how many. */}
              <p className="locations-map-caption">
                {data.total.toLocaleString()} sign-in{data.total === 1 ? "" : "s"} in this range ·{" "}
                {placed.toLocaleString()} placed on the map · {data.local.connections.toLocaleString()} from your own
                network{data.unknown.connections > 0 ? ` · ${data.unknown.connections.toLocaleString()} unplaced` : ""}
              </p>

              <div className="locations-map-actions">
                <Button variant="secondary" onClick={() => setDatabaseOpen(true)}>
                  <Database size={15} aria-hidden="true" />
                  Location database
                </Button>
                <Button variant="secondary" onClick={() => setHomeOpen(true)}>
                  <House size={15} aria-hidden="true" />
                  {data.home ? "Move home" : "Set home location"}
                </Button>
              </div>

              {data.countries.length > 0 ? (
                <>
                  <div className="status-table-title">
                    <h3>Countries</h3>
                    <span>
                      {data.countries.length} {data.countries.length === 1 ? "country" : "countries"} in this range
                    </span>
                  </div>
                  <div className="datagrid-wrap">
                    <table className="datagrid locations-table">
                      <thead>
                        <tr>
                          <SortHeader column="name" label="Country" sort={countrySort} dir={countryDir} onChange={sortCountries} />
                          <SortHeader column="connections" label="Connections" sort={countrySort} dir={countryDir} onChange={sortCountries} initial="desc" />
                          <SortHeader column="failed" label="Failed" sort={countrySort} dir={countryDir} onChange={sortCountries} initial="desc" className="col-num" />
                          <SortHeader column="addresses" label="Addresses" sort={countrySort} dir={countryDir} onChange={sortCountries} initial="desc" className="col-num" />
                          <SortHeader column="rate" label="Fail rate" sort={countrySort} dir={countryDir} onChange={sortCountries} initial="desc" className="col-num" />
                          <th aria-label="Details" />
                        </tr>
                      </thead>
                      <tbody>
                        {countries.rows.map((entry) => (
                          <tr
                            key={entry.code}
                            className={selected === entry.code ? "is-expanded" : undefined}
                            onClick={() => setSelected(selected === entry.code ? null : entry.code)}
                          >
                            <td>
                              <LocationCell flag={countryFlag(entry.code)} title={countryLabel(entry)} sub={entry.code} />
                            </td>
                            <td>
                              <ConnectionsCell connections={entry.connections} max={countryMax} />
                            </td>
                            <td className={`col-num${entry.failed > 0 ? " login-result-failed" : " datagrid-muted"}`}>
                              {entry.failed.toLocaleString()}
                            </td>
                            <td className="col-num datagrid-muted">{entry.addresses.toLocaleString()}</td>
                            <td className="col-num">
                              <span className={`rate-pill ${rateTone(failRate(entry))}`}>{formatRate(failRate(entry))}</span>
                            </td>
                            <td className="locations-row-action">
                              <Button
                                variant="icon"
                                aria-label={`Sign-in details for ${countryLabel(entry)}`}
                                title="Sign-in details"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  navigate(signInsHref({ country: entry.code }));
                                }}
                              >
                                <ChevronRight size={16} aria-hidden="true" />
                              </Button>
                            </td>
                          </tr>
                        ))}
                        {/* The house itself — a reference row, not part of the
                            dataset, so it stays under every page and outside the
                            sort rather than shuffling in among the countries. */}
                        <tr className="datagrid-muted">
                          <td>
                            <LocationCell
                              flag="🏠"
                              title={data.home?.label || "Home network"}
                              sub="Addresses inside the house — never looked up"
                            />
                          </td>
                          <td>
                            <ConnectionsCell connections={data.local.connections} max={countryMax} />
                          </td>
                          <td className={`col-num${data.local.failed > 0 ? " login-result-failed" : ""}`}>
                            {data.local.failed.toLocaleString()}
                          </td>
                          <td className="col-num">{data.local.addresses.toLocaleString()}</td>
                          <td className="col-num">
                            <span className={`rate-pill ${rateTone(failRate(data.local))}`}>
                              {formatRate(failRate(data.local))}
                            </span>
                          </td>
                          <td className="locations-row-action" />
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <Pager page={countries.page} totalPages={countries.totalPages} onChange={setCountryPage} label="Country pages" />
                </>
              ) : (
                <p className="status-empty">
                  {data.local.connections > 0
                    ? "Every sign-in in this range came from inside the house."
                    : "No sign-ins in this range."}
                </p>
              )}

              {data.places.length > 0 && (
                <div className="status-subsection">
                  <div className="status-table-title">
                    <h3>Towns and cities</h3>
                    <span>
                      {data.places.length} {data.places.length === 1 ? "place" : "places"} · from your own city database
                    </span>
                  </div>
                  <div className="datagrid-wrap">
                    <table className="datagrid locations-table">
                      <thead>
                        <tr>
                          <SortHeader column="name" label="Place" sort={placeSort} dir={placeDir} onChange={sortPlaces} />
                          <SortHeader column="connections" label="Connections" sort={placeSort} dir={placeDir} onChange={sortPlaces} initial="desc" />
                          <SortHeader column="failed" label="Failed" sort={placeSort} dir={placeDir} onChange={sortPlaces} initial="desc" className="col-num" />
                          <SortHeader column="addresses" label="Addresses" sort={placeSort} dir={placeDir} onChange={sortPlaces} initial="desc" className="col-num" />
                          <SortHeader column="rate" label="Fail rate" sort={placeSort} dir={placeDir} onChange={sortPlaces} initial="desc" className="col-num" />
                          <th aria-label="Details" />
                        </tr>
                      </thead>
                      <tbody>
                        {places.rows.map((place) => (
                          <tr
                            key={`${place.code}-${place.region ?? ""}-${place.city ?? ""}`}
                            className={selected === place.code ? "is-expanded" : undefined}
                            onClick={() => setSelected(selected === place.code ? null : place.code)}
                          >
                            <td>
                              <LocationCell
                                flag={countryFlag(place.code)}
                                title={placeLabel(place)}
                                sub={[place.region, place.country ?? countryName(place.code) ?? place.code]
                                  .filter(Boolean)
                                  .join(" · ")}
                              />
                            </td>
                            <td>
                              <ConnectionsCell connections={place.connections} max={placeMax} />
                            </td>
                            <td className={`col-num${place.failed > 0 ? " login-result-failed" : " datagrid-muted"}`}>
                              {place.failed.toLocaleString()}
                            </td>
                            <td className="col-num datagrid-muted">{place.addresses.toLocaleString()}</td>
                            <td className="col-num">
                              <span className={`rate-pill ${rateTone(failRate(place))}`}>{formatRate(failRate(place))}</span>
                            </td>
                            <td className="locations-row-action">
                              <Button
                                variant="icon"
                                aria-label={`Sign-in details for ${placeLabel(place)}`}
                                title="Sign-in details"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  // Empty strings are deliberate: the server reads
                                  // "region=" as "the rows whose region is unknown",
                                  // which is exactly what this row groups by.
                                  navigate(
                                    signInsHref({ country: place.code, region: place.region ?? "", city: place.city ?? "" })
                                  );
                                }}
                              >
                                <ChevronRight size={16} aria-hidden="true" />
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Pager page={places.page} totalPages={places.totalPages} onChange={setPlacePage} label="Place pages" />
                </div>
              )}

              {/* CC BY 4.0 requires this line wherever the data is shown. */}
              <p className="status-empty">Country data © DB-IP.com, licensed CC BY 4.0.</p>
            </div>
          </>
        )}
      </section>

      {databaseOpen && data && (
        <GeoipDatabaseModal
          geoip={data.geoip}
          onClose={() => setDatabaseOpen(false)}
          onChanged={() => load(range.from, range.to)}
        />
      )}

      {homeOpen && (
        <HomeLocationModal
          home={data?.home ?? null}
          onClose={() => setHomeOpen(false)}
          onSaved={(home: HomeLocation | null) => {
            setHomeOpen(false);
            setData((current) => (current ? { ...current, home } : current));
          }}
        />
      )}
    </div>
  );
}
