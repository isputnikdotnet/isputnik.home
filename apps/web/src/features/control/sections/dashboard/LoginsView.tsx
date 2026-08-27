import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Activity, CheckCircle2, ShieldBan, XCircle } from "lucide-react";
import { api } from "../../../../api";
import { MessageBox } from "../../../../shared/MessageBox";
import { Pager } from "../../../../shared/Pager";
import { type SortDirection } from "../../../../shared/SortHeader";
import { KpiCard, percentChange } from "../../../../shared/KpiCard";
import {
  DateRangePicker,
  formatRangeLabel,
  formatRangeSpan,
  resolveDateRange,
  type DateRangeValue
} from "../../../../shared/DateRangePicker";

import type { DashboardLogins, IpReputationEntry } from "../../types";
import { LOGIN_EVENTS } from "./activityEvents";
import { usePageSize } from "../../../../shared/PageSizeMenu";
import { useRecentActivity, type ActivitySort } from "./useRecentActivity";
import { LoginsTable } from "./LoginsTable";
import { DashboardChart, DashboardChartLegend } from "./DashboardChart";



// Hourly buckets read as clock times, daily ones as dates — the server already
// decided which it sent, so the axis just follows.
function bucketLabel(iso: string, bucket: "hour" | "day"): string {
  const date = new Date(iso);
  return bucket === "hour"
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function LoginsView() {
  const { t } = useTranslation(["common", "controlDash"]);
  const [range, setRange] = useState<DateRangeValue>(() => resolveDateRange("24h"));
  const [page, setPage] = useState(1);
  const [pageSize, choosePageSize] = usePageSize("isputnik.logins.pageSize");
  const [sort, setSort] = useState<ActivitySort>("time");
  const [dir, setDir] = useState<SortDirection>("desc");
  const [logins, setLogins] = useState<DashboardLogins | null>(null);
  const [error, setError] = useState("");

  // Every surface on this page — chart, cards, table — reads the one range, so
  // changing it can never leave the table describing a different window.
  const { logs, total, totalPages, error: logsError } = useRecentActivity(LOGIN_EVENTS, Number(pageSize), {
    from: range.from,
    to: range.to,
    page,
    sort,
    dir
  });
  const reputation = useIpReputation(logs.map((entry) => entry.ipAddress));

  useEffect(() => {
    setPage(1);
  }, [range.from, range.to, sort, dir, pageSize]);

  useEffect(() => {
    const query = new URLSearchParams({ from: range.from, to: range.to });
    setError("");
    api<DashboardLogins>(`/api/dashboard/logins?${query}`)
      .then(setLogins)
      .catch((err) => setError(err instanceof Error ? err.message : t("controlDash:logins.loadFailed")));
  }, [range.from, range.to]);

  const chartSeries = logins
    ? [
        { label: t("controlDash:logins.successful"), data: logins.series.success, colorVar: "--mint" },
        { label: t("controlDash:logins.failed"), data: logins.series.failed, colorVar: "--rose" }
      ]
    : [];
  const shareOfAttempts = (n: number) =>
    logins && logins.totals.attempts > 0
      ? t("controlDash:logins.shareOfAttempts", { share: ((n / logins.totals.attempts) * 100).toFixed(1) })
      : t("controlDash:logins.noAttempts");
  const versus = t("controlDash:activity.vsPrevious", { span: formatRangeSpan(range) });
  const sortBy = (nextSort: ActivitySort, nextDir: SortDirection) => {
    setSort(nextSort);
    setDir(nextDir);
  };


  return (
    <div className="status-stack">
      <section className="status-block">
        {error && <MessageBox tone="error" title={t("controlDash:logins.loadFailed")}>{error}</MessageBox>}

        {logins && (
          <div className="kpi-cards">
            <KpiCard
              icon={Activity}
              tone="info"
              label={t("controlDash:logins.totalAttempts")}
              value={logins.totals.attempts.toLocaleString()}
              change={percentChange(logins.totals.attempts, logins.previous.attempts)}
              context={versus}
            />
            <KpiCard
              icon={CheckCircle2}
              tone="success"
              label={t("controlDash:logins.successful")}
              value={logins.totals.success.toLocaleString()}
              change={percentChange(logins.totals.success, logins.previous.success)}
              goodWhen="up"
              context={shareOfAttempts(logins.totals.success)}
            />
            <KpiCard
              icon={XCircle}
              tone="danger"
              label={t("controlDash:logins.failed")}
              value={logins.totals.failed.toLocaleString()}
              change={percentChange(logins.totals.failed, logins.previous.failed)}
              goodWhen="down"
              context={shareOfAttempts(logins.totals.failed)}
            />
            <KpiCard
              icon={ShieldBan}
              tone="warning"
              label={t("controlDash:logins.ipsBlocked")}
              value={logins.totals.blockedIps.toLocaleString()}
              change={percentChange(logins.totals.blockedIps, logins.previous.blockedIps)}
              goodWhen="down"
              context={versus}
            />
          </div>
        )}

        <div className="status-range-row">
          <DateRangePicker value={range} onChange={setRange} label={t("controlDash:logins.rangeLabel")} />
          <span className="status-range-label">{formatRangeLabel(range)}</span>
        </div>

        {logins && (
          <div className="status-subsection">
            <div className="status-table-title">
              <h3>{t("controlDash:logins.title")}</h3>
              <span>{t("controlDash:logins.peopleSignedIn", { count: logins.totals.people })}</span>
            </div>
            <DashboardChartLegend series={chartSeries} />
            <DashboardChart
              type="line"
              labels={logins.buckets.map((iso) => bucketLabel(iso, logins.bucket))}
              series={chartSeries}
            />
          </div>
        )}

        <div className="status-subsection">
          {logsError && <MessageBox tone="error" title={t("controlDash:logins.historyFailed")}>{logsError}</MessageBox>}
          {reputation.error && <MessageBox tone="error" title={t("controlDash:logins.checkFailed")}>{reputation.error}</MessageBox>}
          {logs.length > 0 ? (
            <>
              <LoginsTable
                logs={logs}
                total={total}
                pageSize={pageSize}
                onPageSize={choosePageSize}
                sort={sort}
                dir={dir}
                onSort={sortBy}
                reputation={reputation.byIp}
                reputationConfigured={reputation.configured}
                checkingIp={reputation.checking}
                onCheck={reputation.check}
              />
              <Pager page={page} totalPages={totalPages} onChange={setPage} label={t("controlDash:pagers.login")} />
            </>
          ) : (
            <p className="status-empty">{t("controlDash:logins.noActivity")}</p>
          )}
        </div>
      </section>
    </div>
  );
}

// Reputation is enrichment, never a reason to phone home: the table reads what
// earlier AbuseIPDB lookups already cached, and an address nobody has asked about
// shows a Check button rather than being sent anywhere on its own.
function useIpReputation(addresses: (string | null)[]) {
  const { t } = useTranslation(["common", "controlDash"]);
  const [byIp, setByIp] = useState<Record<string, IpReputationEntry>>({});
  const [configured, setConfigured] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [error, setError] = useState("");
  const key = addresses.filter(Boolean).join(",");

  useEffect(() => {
    const ips = [...new Set(key.split(",").filter(Boolean))];
    const query = new URLSearchParams();
    ips.forEach((ip) => query.append("ip", ip));
    api<{ configured: boolean; reputation: IpReputationEntry[] }>(`/api/security/ip-reputation?${query}`)
      .then((payload) => {
        setConfigured(payload.configured);
        setByIp((current) => {
          const next = { ...current };
          payload.reputation.forEach((row) => {
            next[row.ip] = row;
          });
          return next;
        });
      })
      .catch(() => setConfigured(false));
  }, [key]);

  const check = useCallback(async (ip: string) => {
    setChecking(ip);
    setError("");
    try {
      const payload = await api<{ reputation: IpReputationEntry }>(
        `/api/security/ip-reputation/${encodeURIComponent(ip)}/check`,
        { method: "POST" }
      );
      setByIp((current) => ({ ...current, [ip]: payload.reputation }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlDash:logins.lookupFailed"));
    } finally {
      setChecking(null);
    }
  }, []);

  return { byIp, configured, checking, error, check };
}
