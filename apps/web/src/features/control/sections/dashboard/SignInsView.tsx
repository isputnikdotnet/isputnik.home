import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
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
import { controlHref, pushPath } from "../../../../router";
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
import { PageSizeMenu, usePageSize, type PageSize } from "../../../../shared/PageSizeMenu";
import { SortHeader, type SortDirection } from "../../../../shared/SortHeader";
import { TabStrip } from "../../../../shared/TabStrip";
import { countryFlag, formatManagedDate, relativeTime } from "../../../../shared/utils";
import type { DashboardSignIns, DeviceType, LogEvent, SignInsDeviceRow, SignInsIpRow, SignInsUserRow } from "../../types";
import { DashboardChart, DashboardChartLegend, type DashboardChartSeries } from "./DashboardChart";
import { LoginsTable } from "./LoginsTable";
import { SignInsFilterModal } from "./SignInsFilterModal";
import { useIpReputation } from "./useIpReputation";
import type { ActivitySort } from "./useRecentActivity";

// Dashboard › Sign-ins — the view the page opens on, and the drill-down behind
// every arrow on the Locations tables. One scope at a time (everything, a
// country, a town, one address, or one person), one window, and every panel
// answered by the same server query so the chart, the totals and the tables can
// never disagree about what they describe.
//
// It absorbed the Logins view, which drew the same success-versus-failed chart
// over the same events with a second date range to keep in step by hand, and
// could not say where a sign-in came from or end the session it opened. Its one
// irreplaceable panel — the attempt-by-attempt table with AbuseIPDB reputation —
// is at the bottom of this page, narrowed by the dive like everything else.
//
// The scope lives in the URL (?view=signins&country=/&ip=/&user=), which is what
// makes a dive shareable and the back button honest: every arrow here and on the
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
  // view= first, so the address reads as the Dashboard tab it is before the
  // dive that narrows it.
  const suffix = query.toString();
  return `${controlHref("dashboard")}?view=signins${suffix ? `&${suffix}` : ""}`;
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

// The page's own tables are short and fixed; only the sign-ins table at the
// bottom lets the reader choose, because it is the one they scroll.
const PAGE_SIZE = 10;

function pageOf<T>(rows: T[], page: number, size = PAGE_SIZE): { rows: T[]; page: number; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(page, totalPages);
  return { rows: rows.slice((current - 1) * size, current * size), page: current, totalPages };
}

function bucketLabel(iso: string, bucket: "hour" | "day"): string {
  const date = new Date(iso);
  return bucket === "hour"
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const DEVICE_ICONS: Record<DeviceType, LucideIcon> = {
  display: Monitor,
  phone: Smartphone,
  tablet: Tablet,
  computer: Laptop,
  unknown: ShieldQuestion
};

// The order the counter chips render in — displays first because a linked TV is
// the session type that outlives everything else and the one worth glancing for.
//
// Two words per kind, not one. `key` is the chip's, which always follows a
// number ("2 displays") and so must decline with it; `axis` is the chart
// legend's, which stands alone and must not. English hides the difference,
// Russian does not: t(deviceDisplay, { count: 2 }) is "дисплея", which reads as
// a fragment of a phrase the moment the number in front of it is gone.
const DEVICE_TYPE_ORDER: {
  value: DeviceType;
  key: "deviceDisplay" | "devicePhone" | "deviceTablet" | "deviceComputer" | "deviceUnknown";
  axis: "axisDisplay" | "axisPhone" | "axisTablet" | "axisComputer" | "axisUnknown";
}[] = [
  { value: "display", key: "deviceDisplay", axis: "axisDisplay" },
  { value: "phone", key: "devicePhone", axis: "axisPhone" },
  { value: "tablet", key: "deviceTablet", axis: "axisTablet" },
  { value: "computer", key: "deviceComputer", axis: "axisComputer" },
  { value: "unknown", key: "deviceUnknown", axis: "axisUnknown" }
];

// One token per kind, so a bar's colour means the same thing as the chip's
// icon beside it. Five kinds, five chart tokens — see styles/tokens.css.
const DEVICE_TYPE_COLORS: Record<DeviceType, string> = {
  display: "--mint",
  phone: "--blue",
  tablet: "--gold",
  computer: "--amber",
  unknown: "--rose"
};

function methodsSummary(methods: SignInsUserRow["methods"], t: TFunction<readonly ["common", "controlDash"], undefined>): string {
  const parts: string[] = [];
  if (methods.password) parts.push(t("controlDash:signIns.methodPasswordN", { count: methods.password }));
  if (methods.passkey) parts.push(t("controlDash:signIns.methodPasskeyN", { count: methods.passkey }));
  if (methods.twoFactor) parts.push(t("controlDash:signIns.methodTwoFactorN", { count: methods.twoFactor }));
  if (methods.deviceLink) parts.push(t("controlDash:signIns.methodDisplayN", { count: methods.deviceLink }));
  return parts.join(" · ") || "—";
}

// The two halves of "who is at the door": what is signed in right now, and
// what happened over the window. They were stacked, which meant scrolling past
// a long session list to reach the attempts — so they share one card, each with
// the graph of its own shape above its table.
type DoorPanel = "devices" | "signins";

type IpSort = "connections" | "failed" | "people" | "seen";
type UserSort = "connections" | "failed" | "addresses" | "seen";

export function SignInsView() {
  const { t } = useTranslation(["common", "controlDash"]);
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
  const [panel, setPanel] = useState<DoorPanel>("devices");
  const [devicePage, setDevicePage] = useState(1);
  const [deviceKind, setDeviceKind] = useState<DeviceType | null>(null);
  const [namePage, setNamePage] = useState(1);
  const [eventPage, setEventPage] = useState(1);
  const [eventSort, setEventSort] = useState<ActivitySort>("time");
  const [eventDir, setEventDir] = useState<SortDirection>("desc");
  const [eventPageSize, chooseEventPageSize] = usePageSize("isputnik.logins.pageSize");
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
    pushPath(signInsHref(next));
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
      .catch((err) => setError(err instanceof Error ? err.message : t("controlDash:signIns.loadFailed")));
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
      setRevokeError(err instanceof Error ? err.message : t("controlDash:signIns.revokeFailed"));
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
  // Live sessions per person, split by what they are signed in on. The chips
  // below already total each kind across the household; this says who is
  // holding them, which a table of fifty rows only answers by scrolling. It
  // follows the chip filter, so the panel never shows two different sets.
  const deviceChart = useMemo(() => {
    const rows = (data?.devices ?? []).filter((device) => !deviceKind || device.type === deviceKind);
    const byPerson = new Map<string, Record<DeviceType, number>>();
    for (const device of rows) {
      const counts =
        byPerson.get(device.person) ?? { display: 0, phone: 0, tablet: 0, computer: 0, unknown: 0 };
      counts[device.type] += 1;
      byPerson.set(device.person, counts);
    }
    const total = (counts: Record<DeviceType, number>) =>
      DEVICE_TYPE_ORDER.reduce((sum, entry) => sum + counts[entry.value], 0);
    // Busiest first, and capped: this is a glance at who is accumulating
    // sessions, not a second copy of the table.
    const people = [...byPerson.entries()].sort((a, b) => total(b[1]) - total(a[1])).slice(0, 10);
    return {
      labels: people.map(([person]) => person),
      series: DEVICE_TYPE_ORDER.filter((entry) => people.some(([, counts]) => counts[entry.value] > 0)).map(
        (entry) => ({
          label: t(`controlDash:signIns.${entry.axis}`),
          data: people.map(([, counts]) => counts[entry.value]),
          colorVar: DEVICE_TYPE_COLORS[entry.value]
        })
      )
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, deviceKind]);

  const guessedNames = useMemo(() => pageOf(data?.guessedNames ?? [], namePage), [data, namePage]);
  // Sorted and paged here rather than by the server: the scope's tail is already
  // in hand, so a column click costs nothing and can't disagree with the totals.
  const events = useMemo(() => {
    const key: Record<ActivitySort, (row: LogEvent) => string> = {
      time: (row) => row.createdAt,
      user: (row) => row.actorName ?? "",
      event: (row) => row.event,
      ip: (row) => row.ipAddress ?? ""
    };
    const factor = eventDir === "asc" ? 1 : -1;
    const sorted = [...(data?.events ?? [])].sort(
      (a, b) =>
        key[eventSort](a).localeCompare(key[eventSort](b)) * factor ||
        b.createdAt.localeCompare(a.createdAt)
    );
    return pageOf(sorted, eventPage, Number(eventPageSize));
  }, [data, eventSort, eventDir, eventPage, eventPageSize]);
  // Only the addresses on screen are ever looked up.
  const reputation = useIpReputation(events.rows.map((row) => row.ipAddress));

  const chartSeries: DashboardChartSeries[] = useMemo(
    () => [
      { label: t("controlDash:signIns.successful"), data: data?.series.success ?? [], colorVar: "--mint" },
      { label: t("controlDash:signIns.failed"), data: data?.series.failed ?? [], colorVar: "--rose" },
      // Nobody signed in for these, but someone did come in — a line of its own
      // so a burst of link visits is neither hidden nor mistaken for sign-ins.
      { label: t("controlDash:signIns.guestVisits"), data: data?.series.guests ?? [], colorVar: "--gold" }
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data]
  );

  const ipMax = useMemo(() => Math.max(...(data?.ips ?? []).map((row) => row.connections), 1), [data]);
  const scoped = Boolean(scope.country || scope.ip || scope.user);
  const failShare = data && data.totals.attempts > 0 ? Math.round((data.totals.failed / data.totals.attempts) * 100) : 0;
  // What the Logins view spent a whole card on. A block is what failures lead
  // to, so it reads under them rather than beside them — and unlike that card
  // this one narrows with the dive.
  const blockedContext = [
    t("controlDash:signIns.shareOfAttempts", { share: failShare }),
    data && data.totals.blockedIps > 0
      ? t("controlDash:signIns.blockedAddresses", { count: data.totals.blockedIps })
      : null
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="status-stack compact-tables">
      <section className="status-block">
        {error && <MessageBox tone="error" title={t("controlDash:signIns.loadFailed")}>{error}</MessageBox>}

        {data && (
          <>
            {/* Where the dive currently stands. The chip clears back to everything;
                the address bar carries the same fact for sharing and back-button. */}
            <div className="signins-scope-row">
              <span className="signins-scope-label">{t("controlDash:signIns.scope")}</span>
              {scoped ? (
                <span className="signins-scope-chip">
                  {data.scope.code && (
                    <span className="country-flag" aria-hidden="true">{countryFlag(data.scope.code)}</span>
                  )}
                  {data.scope.label}
                  <Button variant="icon" aria-label={t("controlDash:signIns.clearScope")} title={t("controlDash:signIns.backToAll")} onClick={() => dive({})}>
                    <X size={13} aria-hidden="true" />
                  </Button>
                </span>
              ) : (
                <span className="signins-scope-chip is-everything">{t("controlDash:signIns.everything")}</span>
              )}
              {data.truncated && (
                <span className="signins-scope-note">{t("controlDash:signIns.scopeCapped")}</span>
              )}
              <span className="signins-scope-spacer" />
              <Button variant="secondary" onClick={() => setFilterOpen(true)}>
                <Filter size={15} aria-hidden="true" />
                {t("common:filters.button")}
              </Button>
            </div>

            <div className="kpi-cards">
              <KpiCard
                icon={KeyRound}
                tone="info"
                label={t("controlDash:signIns.attempts")}
                value={data.totals.attempts.toLocaleString()}
                context={
                  data.totals.firstSeen
                    ? t("controlDash:signIns.firstSeen", { date: formatManagedDate(data.totals.firstSeen) })
                    : t("controlDash:signIns.nothingInRange")
                }
              />
              <KpiCard
                icon={Fingerprint}
                tone="success"
                label={t("controlDash:signIns.successful")}
                value={data.totals.success.toLocaleString()}
                context={methodsSummary(data.methods, t)}
              />
              <KpiCard
                icon={Ban}
                tone={data.totals.failed > 0 ? "danger" : "success"}
                label={t("controlDash:signIns.failed")}
                value={data.totals.failed.toLocaleString()}
                context={blockedContext}
              />
              <KpiCard
                icon={UsersRound}
                tone="info"
                label={t("controlDash:signIns.people")}
                value={data.totals.people.toLocaleString()}
                context={[
                  t("controlDash:signIns.addresses", { count: data.totals.addresses }),
                  data.totals.guests > 0 ? t("controlDash:signIns.guestVisitsN", { count: data.totals.guests }) : null
                ]
                  .filter(Boolean)
                  .join(" · ")}
              />
            </div>

            <div className="status-range-row">
              <DateRangePicker value={range} onChange={setRange} label={t("controlDash:signIns.rangeLabel")} />
              <span className="status-range-label">{formatRangeLabel(range)}</span>
            </div>

            {/* The door, in two panels. Devices is Dashboard › Devices and
                Members › Sessions absorbed — the type counters, the table, and
                revoke; Sign-ins is the Logins view's attempt-by-attempt table
                with its chart. Both are scoped by the dive like everything
                else, and the admin's own session is pinned first and keeps no
                revoke button — sign-out is the way to end it, and the DELETE
                route refuses it regardless. */}
            <div className="status-subsection">
              <div className="status-table-title">
                <TabStrip
                  items={[
                    { key: "devices", label: t("controlDash:signIns.devicesTitle"), icon: Laptop, count: data.devices.length },
                    { key: "signins", label: t("controlDash:loginsTable.title"), icon: KeyRound, count: data.totals.attempts }
                  ]}
                  active={panel}
                  onChange={setPanel}
                  ariaLabel={t("controlDash:signIns.panelsAria")}
                />
                {panel === "devices" ? (
                  <span>{t("controlDash:signIns.devicesNote")}</span>
                ) : (
                  <span className="login-table-tools">
                    {data.events.length < data.totals.attempts && (
                      <span className="login-table-note">
                        {t("controlDash:signIns.newestOnly", { count: data.events.length })}
                      </span>
                    )}
                    <PageSizeMenu
                      value={eventPageSize}
                      onChange={(size: PageSize) => {
                        chooseEventPageSize(size);
                        setEventPage(1);
                      }}
                    />
                  </span>
                )}
              </div>

              {panel === "devices" ? (
                data.devices.length > 0 ? (
                  <>
                    {deviceChart.series.length > 0 && (
                      <>
                        <DashboardChartLegend series={deviceChart.series} />
                        <DashboardChart type="bar" labels={deviceChart.labels} series={deviceChart.series} stacked height={180} />
                      </>
                    )}
                    {/* Counter and filter in one: each chip counts a kind and
                        narrows the table to it; the active chip clicks back off. */}
                    <div className="device-type-chips" role="group" aria-label={t("controlDash:signIns.deviceChipsAria")}>
                      {DEVICE_TYPE_ORDER.filter((entry) => deviceCounts[entry.value] > 0).map((entry) => {
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
                            <strong>{count}</strong> {t(`controlDash:signIns.${entry.key}`, { count })}
                          </button>
                        );
                      })}
                    </div>
                    <div className="datagrid-wrap">
                      <table className="datagrid locations-table">
                        <thead>
                          <tr>
                            <th>{t("controlDash:table.device")}</th>
                            <th>{t("controlDash:table.person")}</th>
                            <th>{t("controlDash:table.ipAddress")}</th>
                            <th>{t("controlDash:table.lastSeen")}</th>
                            <th>{t("controlDash:table.signedInUntil")}</th>
                            <th aria-label={t("controlDash:table.dive")} />
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
                                        {row.current && <span className="status-badge current">{t("controlDash:signIns.thisDevice")}</span>}
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
                                      aria-label={t("controlDash:signIns.revokeSessionOf", { name: row.person })}
                                      title={t("controlDash:signIns.revokeSession")}
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
                                      aria-label={t("controlDash:signIns.diveInto", { name: row.person })}
                                      title={t("controlDash:signIns.diveIntoPerson")}
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
                    <Pager page={devices.page} totalPages={devices.totalPages} onChange={setDevicePage} label={t("controlDash:pagers.device")} />
                  </>
                ) : (
                  <p className="status-empty">{t("controlDash:signIns.noDevices")}</p>
                )
              ) : (
                <>
                  {reputation.error && (
                    <MessageBox tone="error" title={t("controlDash:signIns.checkFailed")}>{reputation.error}</MessageBox>
                  )}
                  <DashboardChartLegend series={chartSeries} />
                  <DashboardChart
                    type="line"
                    labels={data.series.buckets.map((iso) => bucketLabel(iso, data.series.bucket))}
                    series={chartSeries}
                  />
                  {data.events.length > 0 ? (
                    <>
                      <LoginsTable
                        logs={events.rows}
                        sort={eventSort}
                        dir={eventDir}
                        onSort={(nextSort, nextDir) => {
                          setEventSort(nextSort);
                          setEventDir(nextDir);
                          setEventPage(1);
                        }}
                        reputation={reputation.byIp}
                        reputationConfigured={reputation.configured}
                        checkingIp={reputation.checking}
                        onCheck={reputation.check}
                      />
                      <Pager page={events.page} totalPages={events.totalPages} onChange={setEventPage} label={t("controlDash:pagers.signIn")} />
                    </>
                  ) : (
                    <p className="status-empty">{t("controlDash:signIns.noRecent")}</p>
                  )}
                </>
              )}
            </div>

            <div className="status-subsection">
              <div className="status-table-title">
                <h3>{t("controlDash:signIns.addressesTitle")}</h3>
                <span>{t("controlDash:signIns.addressesNote", { count: data.ips.length })}</span>
              </div>
              {data.ips.length > 0 ? (
                <>
                  <div className="datagrid-wrap">
                    <table className="datagrid locations-table">
                      <thead>
                        <tr>
                          <th>{t("controlDash:table.address")}</th>
                          <SortHeader column="connections" label={t("controlDash:table.connections")} sort={ipSort} dir={ipDir} onChange={(s, d) => { setIpSort(s); setIpDir(d); setIpPage(1); }} initial="desc" />
                          <SortHeader column="failed" label={t("controlDash:table.failed")} sort={ipSort} dir={ipDir} onChange={(s, d) => { setIpSort(s); setIpDir(d); setIpPage(1); }} initial="desc" className="col-num" />
                          <SortHeader column="people" label={t("controlDash:table.people")} sort={ipSort} dir={ipDir} onChange={(s, d) => { setIpSort(s); setIpDir(d); setIpPage(1); }} initial="desc" className="col-num" />
                          <th className="col-num">{t("controlDash:table.scanner")}</th>
                          <th>{t("controlDash:table.status")}</th>
                          <SortHeader column="seen" label={t("controlDash:table.lastSeen")} sort={ipSort} dir={ipDir} onChange={(s, d) => { setIpSort(s); setIpDir(d); setIpPage(1); }} initial="desc" />
                          <th aria-label={t("controlDash:table.dive")} />
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
                                  <small>{row.location ?? t("controlDash:signIns.notInDatabase")}</small>
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
                                ? t("controlDash:signIns.hits", { count: row.probes + row.tokens })
                                : "—"}
                            </td>
                            <td>
                              {row.blocked ? (
                                <span className={`rate-pill ${row.blocked.lapsed ? "rate-warn" : "rate-bad"}`}>
                                  {row.blocked.lapsed
                                    ? t("controlDash:signIns.blockLapsed")
                                    : row.blocked.auto
                                      ? t("controlDash:signIns.blocked")
                                      : t("controlDash:signIns.blockedByHand")}
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
                                  aria-label={t("controlDash:signIns.diveInto", { name: row.ip })}
                                  title={t("controlDash:signIns.diveIntoAddress")}
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
                  <Pager page={ips.page} totalPages={ips.totalPages} onChange={setIpPage} label={t("controlDash:pagers.address")} />
                </>
              ) : (
                <p className="status-empty">{t("controlDash:signIns.noAddresses")}</p>
              )}
            </div>

            <div className="status-subsection">
              <div className="status-table-title">
                <h3>{t("controlDash:signIns.peopleTitle")}</h3>
                <span>{t("controlDash:signIns.peopleNote")}</span>
              </div>
              {data.users.length > 0 ? (
                <>
                  <div className="datagrid-wrap">
                    <table className="datagrid locations-table">
                      <thead>
                        <tr>
                          <th>{t("controlDash:table.person")}</th>
                          <SortHeader column="connections" label={t("controlDash:table.signIns")} sort={userSort} dir={userDir} onChange={(s, d) => { setUserSort(s); setUserDir(d); setUserPage(1); }} initial="desc" className="col-num" />
                          <SortHeader column="failed" label={t("controlDash:table.failed")} sort={userSort} dir={userDir} onChange={(s, d) => { setUserSort(s); setUserDir(d); setUserPage(1); }} initial="desc" className="col-num" />
                          <SortHeader column="addresses" label={t("controlDash:table.addresses")} sort={userSort} dir={userDir} onChange={(s, d) => { setUserSort(s); setUserDir(d); setUserPage(1); }} initial="desc" className="col-num" />
                          <th>{t("controlDash:table.methods")}</th>
                          <SortHeader column="seen" label={t("controlDash:table.lastSeen")} sort={userSort} dir={userDir} onChange={(s, d) => { setUserSort(s); setUserDir(d); setUserPage(1); }} initial="desc" />
                          <th aria-label={t("controlDash:table.dive")} />
                        </tr>
                      </thead>
                      <tbody>
                        {users.rows.map((row) => (
                          <tr key={row.userId ?? (row.guest ? "guest" : "anonymous")}>
                            <td>
                              <span className="datagrid-primary">
                                <strong>
                                  {row.name ?? (row.guest ? t("controlDash:signIns.guestVisitors") : t("controlDash:signIns.notSignedIn"))}
                                </strong>
                                <small>
                                  {row.email ?? (row.guest ? t("controlDash:signIns.guestVisitorsNote") : t("controlDash:signIns.failedNoPerson"))}
                                </small>
                              </span>
                            </td>
                            <td className="col-num">{row.connections.toLocaleString()}</td>
                            <td className={`col-num${row.failed > 0 ? " login-result-failed" : " datagrid-muted"}`}>
                              {row.failed.toLocaleString()}
                            </td>
                            <td className="col-num datagrid-muted">{row.addresses.toLocaleString()}</td>
                            <td className="datagrid-muted">{row.guest ? t("controlDash:signIns.methodShareLinkN", { count: row.guests }) : methodsSummary(row.methods, t)}</td>
                            <td className="datagrid-muted">{relativeTime(row.lastSeen)}</td>
                            <td className="locations-row-action">
                              {row.userId && scope.user !== row.userId && (
                                <Button
                                  variant="icon"
                                  aria-label={t("controlDash:signIns.diveInto", { name: row.name ?? t("controlDash:signIns.thisPerson") })}
                                  title={t("controlDash:signIns.diveIntoPerson")}
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
                  <Pager page={users.page} totalPages={users.totalPages} onChange={setUserPage} label={t("controlDash:pagers.people")} />
                </>
              ) : (
                <p className="status-empty">{t("controlDash:signIns.nobodySignedIn")}</p>
              )}
            </div>

            {data.guessedNames.length > 0 && (
              <div className="status-subsection">
                <div className="status-table-title">
                  <h3>{t("controlDash:signIns.namesTriedTitle")}</h3>
                  <span>{t("controlDash:signIns.namesTriedNote")}</span>
                </div>
                <div className="datagrid-wrap">
                  <table className="datagrid">
                    <thead>
                      <tr>
                        <th>{t("controlDash:table.nameTried")}</th>
                        <th className="col-num">{t("controlDash:table.attempts")}</th>
                        <th>{t("controlDash:table.lastTried")}</th>
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
                <Pager page={guessedNames.page} totalPages={guessedNames.totalPages} onChange={setNamePage} label={t("controlDash:pagers.name")} />
              </div>
            )}

            {(data.scope.kind === "country" || data.scope.kind === "place") && (
              <p className="status-empty">
                <MapPin size={13} aria-hidden="true" /> {t("controlDash:signIns.scopedFrom")}{" "}
                <a href={`${controlHref("dashboard")}?view=locations`}>{t("controlDash:signIns.locationsMap")}</a> ·{" "}
                <Globe2 size={13} aria-hidden="true" /> {t("controlDash:locations.attribution")}
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
          title={t("controlDash:signIns.revokeTitle", { name: pendingRevoke.person })}
          confirmLabel={t("controlDash:signIns.revokeSession")}
          busyLabel={t("controlDash:signIns.revoking")}
          confirmIcon={<LogOut size={15} />}
          danger
          rich
          busy={revoking}
          error={revokeError}
          onConfirm={revokeSession}
          onCancel={() => setPendingRevoke(null)}
        >
          <p>
            {pendingRevoke.name === pendingRevoke.agent
              ? t("controlDash:signIns.revokeBodyDevice", { person: pendingRevoke.person })
              : t("controlDash:signIns.revokeBodyNamed", { person: pendingRevoke.person, name: pendingRevoke.name })}
          </p>
          <p><strong>{t("controlDash:signIns.revokeNote")}</strong></p>
        </ConfirmDialog>
      )}
    </div>
  );
}
