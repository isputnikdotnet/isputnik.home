import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation(["common", "controlDash"]);
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
      .catch((err) => setError(err instanceof Error ? err.message : t("controlDash:locations.loadFailed")));
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
    place.city ?? place.region ?? t("controlDash:locations.unnamedPlace");

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
          <MessageBox tone="info" title={t("controlDash:locations.noDatabaseTitle")}>
            <p>{t("controlDash:locations.noDatabaseBody")}</p>
            <div className="modal-actions">
              <Button variant="primary" onClick={() => setDatabaseOpen(true)}>{t("controlDash:locations.setUpDatabase")}</Button>
            </div>
          </MessageBox>
        )}

        {error && <MessageBox tone="error" title={t("controlDash:locations.loadFailed")}>{error}</MessageBox>}

        {data && (
          <>
            <div className="kpi-cards">
              <KpiCard
                icon={Globe2}
                tone="info"
                label={t("controlDash:locations.countries")}
                value={String(data.countries.length)}
                context={t("controlDash:locations.placedContext", { placed: placed.toLocaleString(), total: data.total.toLocaleString() })}
              />
              <KpiCard
                icon={House}
                tone="success"
                label={data.home?.label || t("controlDash:locations.homeNetwork")}
                value={data.local.connections.toLocaleString()}
                context={t("controlDash:locations.addressesInside", { count: data.local.addresses })}
              />
              <KpiCard
                icon={MapPin}
                tone="warning"
                label={t("controlDash:locations.fromOutside")}
                value={(data.total - data.local.connections).toLocaleString()}
                context={t("controlDash:locations.fromInternet")}
              />
              <KpiCard
                icon={ShieldQuestion}
                tone="danger"
                label={t("controlDash:locations.unplaced")}
                value={data.unknown.connections.toLocaleString()}
                context={data.geoip.available ? t("controlDash:locations.notInDatabase") : t("controlDash:locations.noDatabaseYet")}
              />
            </div>

            <div className="status-range-row">
              <DateRangePicker value={range} onChange={setRange} label={t("controlDash:locations.rangeLabel")} />
              <span className="status-range-label">{formatRangeLabel(range)}</span>
            </div>

            <div className="status-subsection">
              <div className="status-table-title">
                <h3>{t("controlDash:locations.whereFrom")}</h3>
                {data.geoip.updatedAt && (
                  <span>
                    {t("controlDash:locations.databaseDate", { date: formatManagedDate(data.geoip.updatedAt) })}
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
                {t("controlDash:locations.caption", {
                  signIns: t("controlDash:locations.signIns", { count: data.total }),
                  placed: placed.toLocaleString(),
                  local: data.local.connections.toLocaleString()
                })}
                {data.unknown.connections > 0
                  ? t("controlDash:locations.captionUnplaced", { count: data.unknown.connections })
                  : ""}
              </p>

              <div className="locations-map-actions">
                <Button variant="secondary" onClick={() => setDatabaseOpen(true)}>
                  <Database size={15} aria-hidden="true" />
                  {t("controlDash:locations.databaseButton")}
                </Button>
                <Button variant="secondary" onClick={() => setHomeOpen(true)}>
                  <House size={15} aria-hidden="true" />
                  {data.home ? t("controlDash:locations.moveHome") : t("controlDash:locations.setHome")}
                </Button>
              </div>

              {data.countries.length > 0 ? (
                <>
                  <div className="status-table-title">
                    <h3>{t("controlDash:locations.countries")}</h3>
                    <span>{t("controlDash:locations.countriesInRange", { count: data.countries.length })}</span>
                  </div>
                  <div className="datagrid-wrap">
                    <table className="datagrid locations-table">
                      <thead>
                        <tr>
                          <SortHeader column="name" label={t("controlDash:table.country")} sort={countrySort} dir={countryDir} onChange={sortCountries} />
                          <SortHeader column="connections" label={t("controlDash:table.connections")} sort={countrySort} dir={countryDir} onChange={sortCountries} initial="desc" />
                          <SortHeader column="failed" label={t("controlDash:table.failed")} sort={countrySort} dir={countryDir} onChange={sortCountries} initial="desc" className="col-num" />
                          <SortHeader column="addresses" label={t("controlDash:table.addresses")} sort={countrySort} dir={countryDir} onChange={sortCountries} initial="desc" className="col-num" />
                          <SortHeader column="rate" label={t("controlDash:table.failRate")} sort={countrySort} dir={countryDir} onChange={sortCountries} initial="desc" className="col-num" />
                          <th aria-label={t("controlDash:table.details")} />
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
                                aria-label={t("controlDash:locations.signInDetailsFor", { name: countryLabel(entry) })}
                                title={t("controlDash:locations.signInDetails")}
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
                              title={data.home?.label || t("controlDash:locations.homeNetwork")}
                              sub={t("controlDash:locations.homeRowNote")}
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
                  <Pager page={countries.page} totalPages={countries.totalPages} onChange={setCountryPage} label={t("controlDash:pagers.country")} />
                </>
              ) : (
                <p className="status-empty">
                  {data.local.connections > 0
                    ? t("controlDash:locations.allInside")
                    : t("controlDash:locations.noSignIns")}
                </p>
              )}

              {data.places.length > 0 && (
                <div className="status-subsection">
                  <div className="status-table-title">
                    <h3>{t("controlDash:locations.townsTitle")}</h3>
                    <span>{t("controlDash:locations.placesInRange", { count: data.places.length })}</span>
                  </div>
                  <div className="datagrid-wrap">
                    <table className="datagrid locations-table">
                      <thead>
                        <tr>
                          <SortHeader column="name" label={t("controlDash:table.place")} sort={placeSort} dir={placeDir} onChange={sortPlaces} />
                          <SortHeader column="connections" label={t("controlDash:table.connections")} sort={placeSort} dir={placeDir} onChange={sortPlaces} initial="desc" />
                          <SortHeader column="failed" label={t("controlDash:table.failed")} sort={placeSort} dir={placeDir} onChange={sortPlaces} initial="desc" className="col-num" />
                          <SortHeader column="addresses" label={t("controlDash:table.addresses")} sort={placeSort} dir={placeDir} onChange={sortPlaces} initial="desc" className="col-num" />
                          <SortHeader column="rate" label={t("controlDash:table.failRate")} sort={placeSort} dir={placeDir} onChange={sortPlaces} initial="desc" className="col-num" />
                          <th aria-label={t("controlDash:table.details")} />
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
                                aria-label={t("controlDash:locations.signInDetailsFor", { name: placeLabel(place) })}
                                title={t("controlDash:locations.signInDetails")}
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
                  <Pager page={places.page} totalPages={places.totalPages} onChange={setPlacePage} label={t("controlDash:pagers.place")} />
                </div>
              )}

              {/* CC BY 4.0 requires this line wherever the data is shown. */}
              <p className="status-empty">{t("controlDash:locations.attribution")}</p>
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
