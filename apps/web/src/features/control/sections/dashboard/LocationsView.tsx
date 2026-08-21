import { useEffect, useState } from "react";
import { Database, Globe2, House, MapPin, ShieldQuestion } from "lucide-react";
import { api } from "../../../../api";
import { Button } from "../../../../shared/Button";
import { KpiCard } from "../../../../shared/KpiCard";
import { MessageBox } from "../../../../shared/MessageBox";
import {
  DateRangePicker,
  formatRangeLabel,
  resolveDateRange,
  type DateRangeValue
} from "../../../../shared/DateRangePicker";
import { countryName, formatBytes, formatManagedDate } from "../../../../shared/utils";
import type { DashboardLocations, HomeLocation } from "../../types";
import { GeoipDatabaseModal } from "./GeoipDatabaseModal";
import { HomeLocationModal } from "./HomeLocationModal";
import { WorldMap } from "./WorldMap";

// Overview › Dashboard › Locations. Where the sign-ins in a window came from,
// resolved on the server against a local database — nothing about an address is
// sent anywhere to draw this. The two things that can be changed here — which
// database is in use, and where home is — sit as buttons under the map, each
// opening its own dialog, rather than as forms the page has to carry.

export function LocationsView() {
  const [range, setRange] = useState<DateRangeValue>(() => resolveDateRange("30d"));
  const [data, setData] = useState<DashboardLocations | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [databaseOpen, setDatabaseOpen] = useState(false);
  const [homeOpen, setHomeOpen] = useState(false);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to]);

  const placed = data ? data.countries.reduce((sum, entry) => sum + entry.connections, 0) : 0;

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

              <WorldMap
                countries={data.countries}
                places={data.places}
                home={data.home ? { ...data.home, connections: data.local.connections } : null}
                selected={selected}
                onSelect={setSelected}
              />

              {/* What the shading actually counts, said plainly: a map that can
                  only place some of the sign-ins should say how many. */}
              <p className="world-map-caption">
                {data.total.toLocaleString()} sign-in{data.total === 1 ? "" : "s"} in this range ·{" "}
                {placed.toLocaleString()} placed on the map · {data.local.connections.toLocaleString()} from your own
                network{data.unknown.connections > 0 ? ` · ${data.unknown.connections.toLocaleString()} unplaced` : ""}
              </p>

              <div className="world-map-actions">
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
                <div className="datagrid-wrap">
                  <table className="datagrid">
                    <thead>
                      <tr>
                        <th>Country</th>
                        <th className="col-num">Connections</th>
                        <th className="col-num">Failed</th>
                        <th className="col-num">Addresses</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.countries.map((entry) => (
                        <tr
                          key={entry.code}
                          className={selected === entry.code ? "is-expanded" : undefined}
                          onClick={() => setSelected(selected === entry.code ? null : entry.code)}
                        >
                          <td>
                            <span className="datagrid-primary">
                              <strong>{entry.name ?? countryName(entry.code) ?? entry.code}</strong>
                              <small>{entry.code}</small>
                            </span>
                          </td>
                          <td className="col-num">{entry.connections.toLocaleString()}</td>
                          <td className={`col-num${entry.failed > 0 ? " login-result-failed" : " datagrid-muted"}`}>
                            {entry.failed.toLocaleString()}
                          </td>
                          <td className="col-num datagrid-muted">{entry.addresses.toLocaleString()}</td>
                        </tr>
                      ))}
                      <tr className="datagrid-muted">
                        <td>
                          <span className="datagrid-primary">
                            <strong>{data.home?.label || "Home network"}</strong>
                            <small>Addresses inside the house — never looked up</small>
                          </span>
                        </td>
                        <td className="col-num">{data.local.connections.toLocaleString()}</td>
                        <td className="col-num">{data.local.failed.toLocaleString()}</td>
                        <td className="col-num">{data.local.addresses.toLocaleString()}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
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
                    <span>From your own city database</span>
                  </div>
                  <div className="datagrid-wrap">
                    <table className="datagrid">
                      <thead>
                        <tr>
                          <th>Place</th>
                          <th className="col-num">Connections</th>
                          <th className="col-num">Failed</th>
                          <th className="col-num">Addresses</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.places.map((place) => (
                          <tr key={`${place.code}-${place.region ?? ""}-${place.city ?? ""}`}>
                            <td>
                              <span className="datagrid-primary">
                                <strong>{place.city ?? place.region ?? "Unnamed place"}</strong>
                                <small>
                                  {[place.region, place.country ?? countryName(place.code) ?? place.code]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </small>
                              </span>
                            </td>
                            <td className="col-num">{place.connections.toLocaleString()}</td>
                            <td className={`col-num${place.failed > 0 ? " login-result-failed" : " datagrid-muted"}`}>
                              {place.failed.toLocaleString()}
                            </td>
                            <td className="col-num datagrid-muted">{place.addresses.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
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
