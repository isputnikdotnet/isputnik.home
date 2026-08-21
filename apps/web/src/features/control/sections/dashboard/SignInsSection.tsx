import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Ban,
  ChevronRight,
  Filter,
  Fingerprint,
  Globe2,
  KeyRound,
  Laptop,
  LogOut,
  MapPin,
  Monitor,
  ShieldQuestion,
  Smartphone,
  Tablet,
  UsersRound,
  X,
  type LucideIcon
} from "lucide-react";
import { api } from "../../../../api";
import { controlHref } from "../../../../router";
import { Button } from "../../../../shared/Button";
import { ConfirmDialog } from "../../../../shared/ConfirmDialog";
import {
  DateRangePicker,
  formatRangeLabel,
  resolveDateRange,
  type DateRangeValue
} from "../../../../shared/DateRangePicker";
import { KpiCard } from "../../../../shared/KpiCard";
import { MessageBox } from "../../../../shared/MessageBox";
import { Pager } from "../../../../shared/Pager";
import { SortHeader, type SortDirection } from "../../../../shared/SortHeader";
import { countryFlag, formatManagedDate, relativeTime } from "../../../../shared/utils";
import { ControlSectionHead } from "../../ControlSectionHead";
import type { DashboardSignIns, DeviceType, SignInsDeviceRow, SignInsIpRow, SignInsUserRow } from "../../types";
import { DashboardChart, DashboardChartLegend, type DashboardChartSeries } from "./DashboardChart";
import { SignInsFilterModal } from "./SignInsFilterModal";

// Overview › Sign-ins — the analytical drill-down behind the Dashboard's login
// views. One scope at a time (everything, a country, a town, one address, or one
// person), one window, and every panel answered by the same server query so the
// chart, the totals and the tables can never disagree about what they describe.
//
// The scope lives in the URL (?country=, ?ip=, ?user=), which is what makes a
// dive shareable and the back button honest: every arrow on this page and on the
// Locations tables is just a link to this address with a different query string.

export interface SignInsScopeParams {
  country?: string;
  region?: string;
  city?: string;
  ip?: string;
  user?: string;
}

/** The scope encoded in a URL query string, for links from other pages. */
export function signInsHref(scope: SignInsScopeParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(scope)) {
    if (value !== undefined) query.set(key, value);
  }
  const suffix = query.toString();
  return `${controlHref("signins")}${suffix ? `?${suffix}` : ""}`;
}

function scopeFromUrl(): SignInsScopeParams {
  const query = new URLSearchParams(window.location.search);
  const read = (key: keyof SignInsScopeParams) => {
    const value = query.get(key);
    return value === null ? undefined : value;
  };
  // Same precedence as the server: one scope at a time.
  if (read("ip") !== undefined) return { ip: read("ip") };
  if (read("user") !== undefined) return { user: read("user") };
  if (read("country") !== undefined) return { country: read("country"), region: read("region"), city: read("city") };
  return {};
}

const PAGE_SIZE = 10;

function pageOf<T>(rows: T[], page: number): { rows: T[]; page: number; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, totalPages);
  return { rows: rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE), page: current, totalPages };
}

function bucketLabel(iso: string, bucket: "hour" | "day"): string {
  const date = new Date(iso);
  return bucket === "hour"
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// The event vocabulary of this page, in words rather than dotted names.
const EVENT_LABELS: Record<string, string> = {
  "auth.login": "Password sign-in",
  "auth.passkey_login": "Passkey sign-in",
  "auth.mfa_verified": "Two-factor passed",
  "auth.device_link_approved": "Display approved",
  "auth.login_failed": "Wrong password",
  "auth.mfa_failed": "Two-factor failed"
};

const DEVICE_ICONS: Record<DeviceType, LucideIcon> = {
  display: Monitor,
  phone: Smartphone,
  tablet: Tablet,
  computer: Laptop,
  unknown: ShieldQuestion
};

// The order the counter chips render in — displays first because a linked TV is
// the session type that outlives everything else and the one worth glancing for.
const DEVICE_TYPES: { value: DeviceType; singular: string; plural: string }[] = [
  { value: "display", singular: "display", plural: "displays" },
  { value: "phone", singular: "phone", plural: "phones" },
  { value: "tablet", singular: "tablet", plural: "tablets" },
  { value: "computer", singular: "computer", plural: "computers" },
  { value: "unknown", singular: "unknown", plural: "unknown" }
];

function methodsSummary(methods: SignInsUserRow["methods"]): string {
  const parts: string[] = [];
  if (methods.password) parts.push(`${methods.password} password`);
  if (methods.passkey) parts.push(`${methods.passkey} passkey`);
  if (methods.twoFactor) parts.push(`${methods.twoFactor} two-factor`);
  if (methods.deviceLink) parts.push(`${methods.deviceLink} display`);
  return parts.join(" · ") || "—";
}

type IpSort = "connections" | "failed" | "people" | "seen";
type UserSort = "connections" | "failed" | "addresses" | "seen";

export function SignInsSection() {
  const [range, setRange] = useState<DateRangeValue>(() => resolveDateRange("30d"));
  const [scope, setScope] = useState<SignInsScopeParams>(() => scopeFromUrl());
  const [data, setData] = useState<DashboardSignIns | null>(null);
  const [error, setError] = useState("");
  const [ipSort, setIpSort] = useState<IpSort>("connections");
  const [ipDir, setIpDir] = useState<SortDirection>("desc");
  const [ipPage, setIpPage] = useState(1);
  const [userSort, setUserSort] = useState<UserSort>("connections");
  const [userDir, setUserDir] = useState<SortDirection>("desc");
  const [userPage, setUserPage] = useState(1);
  const [devicePage, setDevicePage] = useState(1);
  const [deviceKind, setDeviceKind] = useState<DeviceType | null>(null);
  const [namePage, setNamePage] = useState(1);
  const [eventPage, setEventPage] = useState(1);
  const [filterOpen, setFilterOpen] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<SignInsDeviceRow | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState("");
  // Bumped after a revoke so the whole page refetches — the devices table, but
  // also the counters above it, describe rows that just changed.
  const [reloadNonce, setReloadNonce] = useState(0);

  // A dive is a navigation: the new scope goes into the address bar so the page
  // can be shared and the back button walks back up the dive.
  const dive = useCallback((next: SignInsScopeParams) => {
    window.history.pushState({}, "", signInsHref(next));
    setScope(next);
    setIpPage(1);
    setUserPage(1);
    setDevicePage(1);
    setDeviceKind(null);
    setNamePage(1);
    setEventPage(1);
  }, []);

  // The back button restores the scope the URL now names.
  useEffect(() => {
    const onPop = () => setScope(scopeFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const query = new URLSearchParams({ from: range.from, to: range.to });
    for (const [key, value] of Object.entries(scope)) {
      if (value !== undefined) query.set(key, value);
    }
    setError("");
    api<DashboardSignIns>(`/api/dashboard/signins?${query}`)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load sign-ins"));
  }, [range.from, range.to, scope, reloadNonce]);

  const revokeSession = async () => {
    if (!pendingRevoke) return;
    setRevoking(true);
    setRevokeError("");
    try {
      await api(`/api/sessions/${pendingRevoke.id}`, { method: "DELETE" });
      setPendingRevoke(null);
      setReloadNonce((nonce) => nonce + 1);
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : "Unable to revoke the session");
    } finally {
      setRevoking(false);
    }
  };

  const ips = useMemo(() => {
    const key: Record<IpSort, (row: SignInsIpRow) => number | string> = {
      connections: (row) => row.connections,
      failed: (row) => row.failed,
      people: (row) => row.people,
      seen: (row) => row.lastSeen
    };
    const factor = ipDir === "asc" ? 1 : -1;
    const sorted = [...(data?.ips ?? [])].sort((a, b) => {
      const left = key[ipSort](a);
      const right = key[ipSort](b);
      const cmp = typeof left === "number" ? left - (right as number) : String(left).localeCompare(String(right));
      return cmp * factor || a.ip.localeCompare(b.ip);
    });
    return pageOf(sorted, ipPage);
  }, [data, ipSort, ipDir, ipPage]);

  const users = useMemo(() => {
    const key: Record<UserSort, (row: SignInsUserRow) => number | string> = {
      connections: (row) => row.connections,
      failed: (row) => row.failed,
      addresses: (row) => row.addresses,
      seen: (row) => row.lastSeen
    };
    const factor = userDir === "asc" ? 1 : -1;
    const sorted = [...(data?.users ?? [])].sort((a, b) => {
      const left = key[userSort](a);
      const right = key[userSort](b);
      const cmp = typeof left === "number" ? left - (right as number) : String(left).localeCompare(String(right));
      return cmp * factor || (a.name ?? "").localeCompare(b.name ?? "");
    });
    return pageOf(sorted, userPage);
  }, [data, userSort, userDir, userPage]);

  const deviceCounts = useMemo(() => {
    const counts: Record<DeviceType, number> = { display: 0, phone: 0, tablet: 0, computer: 0, unknown: 0 };
    for (const device of data?.devices ?? []) counts[device.type] += 1;
    return counts;
  }, [data]);
  const devices = useMemo(
    () =>
      pageOf(
        (data?.devices ?? [])
          .filter((device) => !deviceKind || device.type === deviceKind)
          // The admin's own session first — the row they can orient by before
          // deciding which of the others to end. Stable within each half, so
          // the server's newest-first order carries through.
          .sort((a, b) => Number(b.current) - Number(a.current)),
        devicePage
      ),
    [data, deviceKind, devicePage]
  );
  const guessedNames = useMemo(() => pageOf(data?.guessedNames ?? [], namePage), [data, namePage]);
  const events = useMemo(() => pageOf(data?.events ?? [], eventPage), [data, eventPage]);

  const chartSeries: DashboardChartSeries[] = useMemo(
    () => [
      { label: "Successful", data: data?.series.success ?? [], colorVar: "--mint" },
      { label: "Failed", data: data?.series.failed ?? [], colorVar: "--rose" }
    ],
    [data]
  );

  const ipMax = useMemo(() => Math.max(...(data?.ips ?? []).map((row) => row.connections), 1), [data]);
  const scoped = Boolean(scope.country || scope.ip || scope.user);
  const failShare = data && data.totals.attempts > 0 ? Math.round((data.totals.failed / data.totals.attempts) * 100) : 0;

  return (
    <div className="status-stack signins-page">
      <ControlSectionHead
        section="signins"
        icon={<Fingerprint size={30} />}
        description="Every sign-in, from every table that watches the door — dive by country, town, address, or person."
      />

      <section className="status-block">
        {error && <MessageBox tone="error" title="Unable to load sign-ins">{error}</MessageBox>}

        {data && (
          <>
            {/* Where the dive currently stands. The chip clears back to everything;
                the address bar carries the same fact for sharing and back-button. */}
            <div className="signins-scope-row">
              <span className="signins-scope-label">Scope</span>
              {scoped ? (
                <span className="signins-scope-chip">
                  {data.scope.code && (
                    <span className="country-flag" aria-hidden="true">{countryFlag(data.scope.code)}</span>
                  )}
                  {data.scope.label}
                  <Button variant="icon" aria-label="Clear scope" title="Back to all sign-ins" onClick={() => dive({})}>
                    <X size={13} aria-hidden="true" />
                  </Button>
                </span>
              ) : (
                <span className="signins-scope-chip is-everything">Everything</span>
              )}
              {data.truncated && (
                <span className="signins-scope-note">Scope capped at 1,000 addresses — narrow the window.</span>
              )}
              <span className="signins-scope-spacer" />
              <Button variant="secondary" onClick={() => setFilterOpen(true)}>
                <Filter size={15} aria-hidden="true" />
                Filter
              </Button>
            </div>

            <div className="kpi-cards">
              <KpiCard
                icon={KeyRound}
                tone="info"
                label="Attempts"
                value={data.totals.attempts.toLocaleString()}
                context={
                  data.totals.firstSeen
                    ? `First ${formatManagedDate(data.totals.firstSeen)}`
                    : "Nothing in this range"
                }
              />
              <KpiCard
                icon={Fingerprint}
                tone="success"
                label="Successful"
                value={data.totals.success.toLocaleString()}
                context={methodsSummary(data.methods)}
              />
              <KpiCard
                icon={Ban}
                tone={data.totals.failed > 0 ? "danger" : "success"}
                label="Failed"
                value={data.totals.failed.toLocaleString()}
                context={`${failShare}% of attempts`}
              />
              <KpiCard
                icon={UsersRound}
                tone="info"
                label="People"
                value={data.totals.people.toLocaleString()}
                context={`${data.totals.addresses.toLocaleString()} ${data.totals.addresses === 1 ? "address" : "addresses"}`}
              />
            </div>

            <div className="status-range-row">
              <DateRangePicker value={range} onChange={setRange} label="Sign-ins time range" />
              <span className="status-range-label">{formatRangeLabel(range)}</span>
            </div>

            <div className="status-subsection">
              <div className="status-table-title">
                <h3>Over time</h3>
                <span>{data.series.bucket === "hour" ? "By hour" : "By day"}</span>
              </div>
              <DashboardChartLegend series={chartSeries} />
              <DashboardChart
                type="line"
                labels={data.series.buckets.map((iso) => bucketLabel(iso, data.series.bucket))}
                series={chartSeries}
              />
            </div>

            {/* Dashboard › Devices and Members › Sessions, absorbed here: the
                inventory glance (the type counters), the table, and revoke —
                scoped by the dive like everything else. The admin's own session
                is pinned first and keeps no revoke button; sign-out is the way
                to end it, and the DELETE route refuses it regardless. */}
            <div className="status-subsection">
              <div className="status-table-title">
                <h3>Devices still signed in</h3>
                <span>Live right now — not bound to the time range above</span>
              </div>
              {data.devices.length > 0 ? (
                <>
                  {/* Counter and filter in one: each chip counts a kind and
                      narrows the table to it; the active chip clicks back off. */}
                  <div className="device-type-chips" role="group" aria-label="Filter devices by type">
                    {DEVICE_TYPES.filter((entry) => deviceCounts[entry.value] > 0).map((entry) => {
                      const Icon = DEVICE_ICONS[entry.value];
                      const count = deviceCounts[entry.value];
                      const active = deviceKind === entry.value;
                      return (
                        <button
                          key={entry.value}
                          type="button"
                          className={`device-type-chip${active ? " is-active" : ""}`}
                          aria-pressed={active}
                          onClick={() => {
                            setDeviceKind(active ? null : entry.value);
                            setDevicePage(1);
                          }}
                        >
                          <Icon size={15} aria-hidden="true" />
                          <strong>{count}</strong> {count === 1 ? entry.singular : entry.plural}
                        </button>
                      );
                    })}
                  </div>
                  <div className="datagrid-wrap">
                    <table className="datagrid locations-table">
                      <thead>
                        <tr>
                          <th>Device</th>
                          <th>Person</th>
                          <th>IP address</th>
                          <th>Last seen</th>
                          <th>Signed in until</th>
                          <th aria-label="Dive" />
                        </tr>
                      </thead>
                      <tbody>
                        {devices.rows.map((row) => {
                          const Icon = DEVICE_ICONS[row.type];
                          return (
                            <tr key={row.id}>
                              <td>
                                <span className="location-cell">
                                  <Icon size={17} aria-hidden="true" className="signins-device-icon" />
                                  <span className="datagrid-primary">
                                    <span className="admin-name-line">
                                      <strong>{row.name}</strong>
                                      {row.current && <span className="status-badge current">This device</span>}
                                    </span>
                                    {row.name !== row.agent && <small>{row.agent}</small>}
                                  </span>
                                </span>
                              </td>
                              <td>{row.person}</td>
                              <td className="datagrid-muted">{row.ip ?? "—"}</td>
                              <td className="datagrid-muted">{relativeTime(row.lastSeen)}</td>
                              <td className="datagrid-muted">{formatManagedDate(row.expiresAt)}</td>
                              <td className="locations-row-action signins-device-actions">
                                {!row.current && (
                                  <Button
                                    variant="icon"
                                    danger
                                    aria-label={`Revoke this session of ${row.person}`}
                                    title="Revoke session"
                                    onClick={() => {
                                      setRevokeError("");
                                      setPendingRevoke(row);
                                    }}
                                  >
                                    <LogOut size={15} aria-hidden="true" />
                                  </Button>
                                )}
                                {scope.user !== row.personId && (
                                  <Button
                                    variant="icon"
                                    aria-label={`Dive into ${row.person}`}
                                    title="Dive into this person"
                                    onClick={() => dive({ user: row.personId })}
                                  >
                                    <ChevronRight size={16} aria-hidden="true" />
                                  </Button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <Pager page={devices.page} totalPages={devices.totalPages} onChange={setDevicePage} label="Device pages" />
                </>
              ) : (
                <p className="status-empty">Nothing is signed in from this scope right now.</p>
              )}
            </div>

            <div className="status-subsection">
              <div className="status-table-title">
                <h3>Addresses</h3>
                <span>
                  {data.ips.length} {data.ips.length === 1 ? "address" : "addresses"} · blocks and scanner traffic
                  included
                </span>
              </div>
              {data.ips.length > 0 ? (
                <>
                  <div className="datagrid-wrap">
                    <table className="datagrid locations-table">
                      <thead>
                        <tr>
                          <th>Address</th>
                          <SortHeader column="connections" label="Connections" sort={ipSort} dir={ipDir} onChange={(s, d) => { setIpSort(s); setIpDir(d); setIpPage(1); }} initial="desc" />
                          <SortHeader column="failed" label="Failed" sort={ipSort} dir={ipDir} onChange={(s, d) => { setIpSort(s); setIpDir(d); setIpPage(1); }} initial="desc" className="col-num" />
                          <SortHeader column="people" label="People" sort={ipSort} dir={ipDir} onChange={(s, d) => { setIpSort(s); setIpDir(d); setIpPage(1); }} initial="desc" className="col-num" />
                          <th className="col-num">Scanner</th>
                          <th>Status</th>
                          <SortHeader column="seen" label="Last seen" sort={ipSort} dir={ipDir} onChange={(s, d) => { setIpSort(s); setIpDir(d); setIpPage(1); }} initial="desc" />
                          <th aria-label="Dive" />
                        </tr>
                      </thead>
                      <tbody>
                        {ips.rows.map((row) => (
                          <tr key={row.ip}>
                            <td>
                              <span className="location-cell">
                                {row.code && (
                                  <span className="country-flag" aria-hidden="true">{countryFlag(row.code)}</span>
                                )}
                                {row.local && (
                                  <span className="country-flag" aria-hidden="true">🏠</span>
                                )}
                                <span className="datagrid-primary">
                                  <strong>{row.ip}</strong>
                                  <small>{row.location ?? "Not in the location database"}</small>
                                </span>
                              </span>
                            </td>
                            <td>
                              <span className="conn-cell">
                                <span className="conn-count">{row.connections.toLocaleString()}</span>
                                <span className="conn-track" aria-hidden="true">
                                  <span
                                    className="conn-fill"
                                    style={{ width: `${Math.max(4, Math.round((row.connections / ipMax) * 100))}%` }}
                                  />
                                </span>
                              </span>
                            </td>
                            <td className={`col-num${row.failed > 0 ? " login-result-failed" : " datagrid-muted"}`}>
                              {row.failed.toLocaleString()}
                            </td>
                            <td className="col-num datagrid-muted">{row.people.toLocaleString()}</td>
                            <td className={`col-num${row.probes + row.tokens > 0 ? " login-result-failed" : " datagrid-muted"}`}>
                              {row.probes + row.tokens > 0
                                ? `${(row.probes + row.tokens).toLocaleString()} hits`
                                : "—"}
                            </td>
                            <td>
                              {row.blocked ? (
                                <span className={`rate-pill ${row.blocked.lapsed ? "rate-warn" : "rate-bad"}`}>
                                  {row.blocked.lapsed ? "Block lapsed" : row.blocked.auto ? "Blocked" : "Blocked by hand"}
                                </span>
                              ) : (
                                <span className="datagrid-muted">—</span>
                              )}
                            </td>
                            <td className="datagrid-muted">{relativeTime(row.lastSeen)}</td>
                            <td className="locations-row-action">
                              {scope.ip !== row.ip && (
                                <Button
                                  variant="icon"
                                  aria-label={`Dive into ${row.ip}`}
                                  title="Dive into this address"
                                  onClick={() => dive({ ip: row.ip })}
                                >
                                  <ChevronRight size={16} aria-hidden="true" />
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Pager page={ips.page} totalPages={ips.totalPages} onChange={setIpPage} label="Address pages" />
                </>
              ) : (
                <p className="status-empty">No addresses in this scope and range.</p>
              )}
            </div>

            <div className="status-subsection">
              <div className="status-table-title">
                <h3>People</h3>
                <span>Failures carry no name — they gather under “Not signed in”</span>
              </div>
              {data.users.length > 0 ? (
                <>
                  <div className="datagrid-wrap">
                    <table className="datagrid locations-table">
                      <thead>
                        <tr>
                          <th>Person</th>
                          <SortHeader column="connections" label="Sign-ins" sort={userSort} dir={userDir} onChange={(s, d) => { setUserSort(s); setUserDir(d); setUserPage(1); }} initial="desc" className="col-num" />
                          <SortHeader column="failed" label="Failed" sort={userSort} dir={userDir} onChange={(s, d) => { setUserSort(s); setUserDir(d); setUserPage(1); }} initial="desc" className="col-num" />
                          <SortHeader column="addresses" label="Addresses" sort={userSort} dir={userDir} onChange={(s, d) => { setUserSort(s); setUserDir(d); setUserPage(1); }} initial="desc" className="col-num" />
                          <th>Methods</th>
                          <SortHeader column="seen" label="Last seen" sort={userSort} dir={userDir} onChange={(s, d) => { setUserSort(s); setUserDir(d); setUserPage(1); }} initial="desc" />
                          <th aria-label="Dive" />
                        </tr>
                      </thead>
                      <tbody>
                        {users.rows.map((row) => (
                          <tr key={row.userId ?? "anonymous"}>
                            <td>
                              <span className="datagrid-primary">
                                <strong>{row.name ?? "Not signed in"}</strong>
                                <small>{row.email ?? "Failed attempts — no proven person"}</small>
                              </span>
                            </td>
                            <td className="col-num">{row.connections.toLocaleString()}</td>
                            <td className={`col-num${row.failed > 0 ? " login-result-failed" : " datagrid-muted"}`}>
                              {row.failed.toLocaleString()}
                            </td>
                            <td className="col-num datagrid-muted">{row.addresses.toLocaleString()}</td>
                            <td className="datagrid-muted">{methodsSummary(row.methods)}</td>
                            <td className="datagrid-muted">{relativeTime(row.lastSeen)}</td>
                            <td className="locations-row-action">
                              {row.userId && scope.user !== row.userId && (
                                <Button
                                  variant="icon"
                                  aria-label={`Dive into ${row.name ?? "this person"}`}
                                  title="Dive into this person"
                                  onClick={() => dive({ user: row.userId! })}
                                >
                                  <ChevronRight size={16} aria-hidden="true" />
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Pager page={users.page} totalPages={users.totalPages} onChange={setUserPage} label="People pages" />
                </>
              ) : (
                <p className="status-empty">Nobody signed in from this scope in this range.</p>
              )}
            </div>

            {data.guessedNames.length > 0 && (
              <div className="status-subsection">
                <div className="status-table-title">
                  <h3>Names tried</h3>
                  <span>Sign-in names that belong to no account here — a stranger’s guessing list</span>
                </div>
                <div className="datagrid-wrap">
                  <table className="datagrid">
                    <thead>
                      <tr>
                        <th>Name tried</th>
                        <th className="col-num">Attempts</th>
                        <th>Last tried</th>
                      </tr>
                    </thead>
                    <tbody>
                      {guessedNames.rows.map((row) => (
                        <tr key={row.email}>
                          <td className="login-result-failed">{row.email}</td>
                          <td className="col-num">{row.attempts.toLocaleString()}</td>
                          <td className="datagrid-muted">{relativeTime(row.lastSeen)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pager page={guessedNames.page} totalPages={guessedNames.totalPages} onChange={setNamePage} label="Name pages" />
              </div>
            )}

            <div className="status-subsection">
              <div className="status-table-title">
                <h3>Recent activity</h3>
                <span>The newest {data.events.length} events in this scope — the full archive is in Logs</span>
              </div>
              {data.events.length > 0 ? (
                <>
                  <div className="datagrid-wrap">
                    <table className="datagrid">
                      <thead>
                        <tr>
                          <th>What</th>
                          <th>Person</th>
                          <th>IP address</th>
                          <th>When</th>
                        </tr>
                      </thead>
                      <tbody>
                        {events.rows.map((row) => (
                          <tr key={row.id}>
                            <td className={row.failed ? "login-result-failed" : undefined}>
                              {EVENT_LABELS[row.event] ?? row.event}
                            </td>
                            <td>{row.actor ?? <span className="datagrid-muted">—</span>}</td>
                            <td className="datagrid-muted">{row.ip ?? "—"}</td>
                            <td className="datagrid-muted">{formatManagedDate(row.at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Pager page={events.page} totalPages={events.totalPages} onChange={setEventPage} label="Activity pages" />
                </>
              ) : (
                <p className="status-empty">No sign-in activity in this scope and range.</p>
              )}
            </div>

            {(data.scope.kind === "country" || data.scope.kind === "place") && (
              <p className="status-empty">
                <MapPin size={13} aria-hidden="true" /> Scoped from the{" "}
                <a href={`${controlHref("dashboard")}?view=locations`}>Locations map</a> ·{" "}
                <Globe2 size={13} aria-hidden="true" /> Country data © DB-IP.com, licensed CC BY 4.0.
              </p>
            )}
          </>
        )}
      </section>

      {filterOpen && (
        <SignInsFilterModal
          scope={scope}
          onApply={(next) => {
            setFilterOpen(false);
            dive(next);
          }}
          onClose={() => setFilterOpen(false)}
        />
      )}

      {pendingRevoke && (
        <ConfirmDialog
          title={`Revoke session for "${pendingRevoke.person}"?`}
          confirmLabel="Revoke session"
          busyLabel="Revoking…"
          confirmIcon={<LogOut size={15} />}
          danger
          rich
          busy={revoking}
          error={revokeError}
          onConfirm={revokeSession}
          onCancel={() => setPendingRevoke(null)}
        >
          <p>
            This signs {pendingRevoke.person} out on {pendingRevoke.name === pendingRevoke.agent ? "that device" : `“${pendingRevoke.name}”`}.
          </p>
          <p><strong>The account, its password, and its other sessions are not changed.</strong></p>
        </ConfirmDialog>
      )}
    </div>
  );
}
