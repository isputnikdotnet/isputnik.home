import { useEffect, useState } from "react";
import { BookOpen, Download, HardDrive, Headphones, Trash2, Upload } from "lucide-react";
import { api } from "../../../../api";
import {
  DateRangePicker,
  formatRangeLabel,
  formatRangeSpan,
  resolveDateRange,
  type DateRangeValue
} from "../../../../shared/DateRangePicker";
import { KpiCard, percentChange } from "../../../../shared/KpiCard";
import { MessageBox } from "../../../../shared/MessageBox";
import { Pager } from "../../../../shared/Pager";
import { formatBytes, formatManagedDate } from "../../../../shared/utils";
import type { DashboardActivity, DashboardInProgressEntry, SystemStatus } from "../../types";
import { CONTENT_EVENTS } from "./activityEvents";
import { DashboardChart, DashboardChartLegend } from "./DashboardChart";
import { useRecentActivity } from "./useRecentActivity";

// Overview › Dashboard › Activity — what the household has been doing with the
// library. This was three views (Activity, Content activity, Reading and
// playback) that each answered a slice of the same question; one page now
// answers it top to bottom: the numbers, the two charts, the recent events, and
// what is open right now.
//
// One date range drives the cards, both charts and the events table, the same
// way Logins works — so changing it can never leave one panel describing a
// different window from the others. The in-progress table stands apart: it is a
// snapshot of positions, not a history, and says so.

// Same event-category/action split LogsSection uses for its Event column, so a
// row here reads identically whether you're looking at this page or Logs.
function EventCell({ event }: { event: string }) {
  const [category, ...rest] = event.split(".");
  const action = rest.join(" ").replace(/_/g, " ");
  return (
    <span className="log-event-cell">
      <span className={`event-category cat-${category}`}>{category}</span>
      <span className="event-action">{action}</span>
    </span>
  );
}

const PAGE_SIZE = 10;

function pageOf<T>(rows: T[], page: number): { rows: T[]; page: number; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, totalPages);
  return { rows: rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE), page: current, totalPages };
}

// Hourly buckets read as clock times, daily ones as dates — the server already
// decided which it sent, so the axis just follows.
function bucketLabel(iso: string, bucket: "hour" | "day"): string {
  const date = new Date(iso);
  return bucket === "hour"
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ActivityView({ status }: { status: SystemStatus }) {
  const storageBytes = status.libraryStats.totalSizeBytes + status.ebookStats.totalSizeBytes + status.galleryStats.totalSizeBytes;
  const [range, setRange] = useState<DateRangeValue>(() => resolveDateRange("7d"));
  const [activity, setActivity] = useState<DashboardActivity | null>(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [progressPage, setProgressPage] = useState(1);
  const [inProgress, setInProgress] = useState<DashboardInProgressEntry[]>([]);
  const [inProgressError, setInProgressError] = useState("");

  const recent = useRecentActivity(CONTENT_EVENTS, PAGE_SIZE, { from: range.from, to: range.to, page });

  useEffect(() => {
    setPage(1);
  }, [range.from, range.to]);

  useEffect(() => {
    const query = new URLSearchParams({ from: range.from, to: range.to });
    setError("");
    api<DashboardActivity>(`/api/dashboard/activity?${query}`)
      .then(setActivity)
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load activity"));
  }, [range.from, range.to]);

  useEffect(() => {
    api<{ inProgress: DashboardInProgressEntry[] }>("/api/dashboard/in-progress")
      .then((payload) => setInProgress(payload.inProgress))
      .catch((err) => setInProgressError(err instanceof Error ? err.message : "Unable to load what's in progress"));
  }, []);

  const contentSeries = activity
    ? [
        { label: "Uploads", data: activity.series.uploads, colorVar: "--blue" },
        { label: "Downloads", data: activity.series.downloads, colorVar: "--gold" },
        { label: "Deletes", data: activity.series.deletes, colorVar: "--rose" }
      ]
    : [];
  // The other half of the story, which used to go uncharted: not what was put
  // in or taken out, but what was actually opened.
  const engagementSeries = activity
    ? [
        { label: "Played", data: activity.series.played, colorVar: "--mint" },
        { label: "Read", data: activity.series.read, colorVar: "--blue" },
        { label: "Viewed", data: activity.series.viewed, colorVar: "--gold" }
      ]
    : [];
  const versus = `vs previous ${formatRangeSpan(range)}`;
  const opened = activity ? activity.totals.played + activity.totals.read + activity.totals.viewed : 0;
  const progress = pageOf(inProgress, progressPage);

  return (
    <div className="status-stack">
      <section className="status-block">
        {error && <MessageBox tone="error" title="Unable to load activity">{error}</MessageBox>}

        {activity && (
          <div className="kpi-cards">
            <KpiCard
              icon={Upload}
              tone="info"
              label="Uploads"
              value={activity.totals.uploads.toLocaleString()}
              change={percentChange(activity.totals.uploads, activity.previous.uploads)}
              goodWhen="up"
              context={versus}
            />
            <KpiCard
              icon={Download}
              tone="success"
              label="Downloads"
              value={activity.totals.downloads.toLocaleString()}
              change={percentChange(activity.totals.downloads, activity.previous.downloads)}
              goodWhen="up"
              context={versus}
            />
            <KpiCard
              icon={Trash2}
              tone={activity.totals.deletes > 0 ? "danger" : "info"}
              label="Deletes"
              value={activity.totals.deletes.toLocaleString()}
              change={percentChange(activity.totals.deletes, activity.previous.deletes)}
              context={versus}
            />
            <KpiCard
              icon={HardDrive}
              tone="warning"
              label="Storage used"
              value={formatBytes(storageBytes)}
              context={`${formatBytes(status.libraryStats.totalSizeBytes)} audio · ${formatBytes(status.ebookStats.totalSizeBytes)} books · ${formatBytes(status.galleryStats.totalSizeBytes)} photos`}
            />
          </div>
        )}

        <div className="status-range-row">
          <DateRangePicker value={range} onChange={setRange} label="Activity time range" />
          <span className="status-range-label">{formatRangeLabel(range)}</span>
        </div>

        {activity && (
          <div className="activity-charts">
            <div className="status-subsection">
              <div className="status-table-title">
                <h3>Content activity</h3>
                <span>{activity.bucket === "hour" ? "By hour" : "By day"}</span>
              </div>
              <DashboardChartLegend series={contentSeries} />
              <DashboardChart
                type="bar"
                labels={activity.buckets.map((iso) => bucketLabel(iso, activity.bucket))}
                series={contentSeries}
                stacked
              />
            </div>
            <div className="status-subsection">
              <div className="status-table-title">
                <h3>Reading, listening and viewing</h3>
                <span>{opened.toLocaleString()} {opened === 1 ? "item" : "items"} opened</span>
              </div>
              <DashboardChartLegend series={engagementSeries} />
              <DashboardChart
                type="bar"
                labels={activity.buckets.map((iso) => bucketLabel(iso, activity.bucket))}
                series={engagementSeries}
                stacked
              />
            </div>
          </div>
        )}

        <div className="status-subsection">
          <div className="status-table-title">
            <h3>Content activity in this range</h3>
            <span>
              {recent.total.toLocaleString()} {recent.total === 1 ? "event" : "events"} · uploads, downloads, deletes,
              and what was opened — the full archive is in Logs
            </span>
          </div>
          {recent.error && <p className="status-empty">{recent.error}</p>}
          {recent.logs.length > 0 ? (
            <>
              <div className="datagrid-wrap">
                <table className="datagrid">
                  <thead>
                    <tr>
                      <th>Event</th>
                      <th>User</th>
                      <th>Detail</th>
                      <th>IP address</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.logs.map((entry) => (
                      <tr key={entry.id}>
                        <td><EventCell event={entry.event} /></td>
                        <td className="datagrid-muted">{entry.actorName ?? "System"}</td>
                        <td>{entry.detail}</td>
                        <td className="datagrid-muted">{entry.ipAddress ?? "—"}</td>
                        <td className="datagrid-muted">{formatManagedDate(entry.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager page={page} totalPages={recent.totalPages} onChange={setPage} label="Activity pages" />
            </>
          ) : (
            !recent.error && <p className="status-empty">No uploads, downloads, deletes or opens in this range.</p>
          )}
        </div>

        <div className="status-subsection">
          <div className="status-table-title">
            <h3>Currently in progress</h3>
            {/* A position, not a history: reading and listening progress is
                overwritten in place, so this is where everyone is right now —
                whatever the range above says. */}
            <span>Where each person is right now — a snapshot, not bound to the range above</span>
          </div>
          {inProgressError && <p className="status-empty">{inProgressError}</p>}
          {inProgress.length > 0 ? (
            <>
              <div className="datagrid-wrap">
                <table className="datagrid">
                  <thead>
                    <tr>
                      <th>User</th>
                      <th>Item</th>
                      <th>Type</th>
                      <th className="col-num">Progress</th>
                      <th>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {progress.rows.map((entry, index) => (
                      <tr key={`${entry.kind}-${entry.title}-${index}`}>
                        <td>{entry.userName}</td>
                        <td>{entry.title}</td>
                        <td className="datagrid-muted">
                          <span className="log-event-cell">
                            {entry.kind === "audiobook" ? <Headphones size={14} aria-hidden="true" /> : <BookOpen size={14} aria-hidden="true" />}
                            {entry.kind === "audiobook" ? "Audiobook" : "Ebook"}
                          </span>
                        </td>
                        <td className="col-num datagrid-muted">
                          {entry.percentComplete != null ? `${Math.round(entry.percentComplete * 100)}%` : "—"}
                        </td>
                        <td className="datagrid-muted">{formatManagedDate(entry.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager page={progress.page} totalPages={progress.totalPages} onChange={setProgressPage} label="In-progress pages" />
            </>
          ) : (
            !inProgressError && <p className="status-empty">Nobody has an audiobook or ebook in progress right now.</p>
          )}
        </div>
      </section>
    </div>
  );
}
