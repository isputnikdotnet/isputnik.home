import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Activity, ArrowRight, HardDrive, ListChecks } from "lucide-react";
import { api } from "../../../../api";
import { controlHref, followRoute } from "../../../../router";
import { Button } from "../../../../shared/Button";
import { SelectMenu } from "../../../../shared/SelectMenu";
import { formatBytes } from "../../../../shared/utils";
import { formatDate, formatNumber, formatTime } from "../../../../shared/dates";
import { activityHref, logsHref, storageHref, tasksHref } from "../../links";
import { APP_LOG_PREFIXES, applicationParam } from "../../applications";
import { appLabel, type AppKey } from "../../nav";
import type { DashboardActivity, Job, SystemStatus } from "../../types";
import { DashboardChart, DashboardChartLegend } from "./DashboardChart";
import { progressText, taskLabel } from "./TasksView";
import { STORAGE_CATEGORIES, driveBreakdown, librarySizes, type StorageCategory } from "./storageBreakdown";
import type { OwnedDisk } from "./useDashboardOverview";

// The Dashboard's lower three sections (control panel v2, phase 4 —
// docs/control-panel-v2-plan.md "Dashboard"). Each summary leads somewhere: a
// drive to what occupies it, a category to its page, a member to their log, a
// running task to its progress, logs and Cancel.

/** One filesystem: every folder mapped from it, in every container (Overview's groupDisks). */
export interface DriveGroup {
  key: string;
  freeBytes: number;
  totalBytes: number;
  folders: OwnedDisk[];
}

const CATEGORY_COLOR: Record<StorageCategory | "other", string> = {
  media: "var(--mint)",
  appData: "var(--blue)",
  thumbnails: "var(--gold)",
  backups: "var(--amber)",
  trash: "var(--rose)",
  other: "color-mix(in srgb, var(--muted) 60%, transparent)"
};

const CATEGORY_HREF: Record<StorageCategory, () => string> = {
  media: () => controlHref("libraries"),
  appData: () => storageHref("app-storage"),
  thumbnails: () => storageHref("system-data"),
  backups: () => controlHref("backup"),
  trash: () => controlHref("recycleBin")
};

function go(href: string) {
  return (event: React.MouseEvent<HTMLAnchorElement>) => followRoute(event, href);
}

// ── Storage ─────────────────────────────────────────────────────────────────

export function StoragePanel({
  drives,
  status,
  describe,
  folderLabel
}: {
  drives: DriveGroup[];
  status: SystemStatus;
  /** "Libraries: Books · backups" for one folder (Overview's describeHoldings). */
  describe: (folder: OwnedDisk) => string;
  /** The folder's container, when it is not home. */
  folderLabel: (folder: OwnedDisk) => string;
}) {
  const { t } = useTranslation(["common", "controlDash"]);
  const [selected, setSelected] = useState(0);
  const sizes = librarySizes(status);
  const drive = drives[Math.min(selected, drives.length - 1)];

  if (drives.length === 0) return <p className="muted">{t("controlDash:overview.disksUnknown")}</p>;

  const breakdownOf = (group: DriveGroup) => driveBreakdown(group.folders, sizes, Math.max(0, group.totalBytes - group.freeBytes));
  const current = breakdownOf(drive);
  const names = (group: DriveGroup) => [...new Set(group.folders.map((folder) => folder.mount))].join(", ");

  return (
    <div className="dash-drives">
      {/* One capacity per filesystem: folders sharing a drive are listed on its bar,
          never drawn as capacities of their own. */}
      <div className="dash-drive-list">
        {drives.map((group, index) => {
          const used = Math.max(0, group.totalBytes - group.freeBytes);
          const share = group.totalBytes > 0 ? group.freeBytes / group.totalBytes : 1;
          const tone = share < 0.1 ? "danger" : share < 0.2 ? "warning" : "success";
          const breakdown = breakdownOf(group);
          const segments = [
            ...STORAGE_CATEGORIES.map((key) => ({ key, bytes: breakdown.categories[key] ?? 0 })),
            { key: "other" as const, bytes: breakdown.other }
          ].filter((segment) => segment.bytes > 0);
          return (
            <Button
              key={group.key}
              variant="bare"
              className={`dash-drive${index === selected ? " is-selected" : ""}`}
              aria-pressed={index === selected}
              onClick={() => setSelected(index)}
            >
              <span className="dash-drive-head">
                <code title={names(group)}>{names(group)}</code>
                <span className={`tone-${tone}`}>
                  {t("controlDash:overview.diskFree", { free: formatBytes(group.freeBytes), total: formatBytes(group.totalBytes) })}
                </span>
              </span>
              <span
                className="dash-drive-bar"
                role="meter"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={group.totalBytes > 0 ? Math.round((used / group.totalBytes) * 100) : 0}
                aria-label={t("controlDash:overview.diskUsedLabel", { mount: names(group), share: group.totalBytes > 0 ? Math.round((used / group.totalBytes) * 100) : 0 })}
              >
                {segments.map((segment) => (
                  <span key={segment.key} style={{ width: `${(segment.bytes / group.totalBytes) * 100}%`, background: CATEGORY_COLOR[segment.key] }} />
                ))}
              </span>
              {tone !== "success" && <span className={`dash-drive-warning tone-${tone}`}>{t("controlDash:dashboard.lowSpace")}</span>}
            </Button>
          );
        })}
      </div>

      <div className="dash-drive-detail">
        <h3>{t("controlDash:dashboard.whatUses", { drive: names(drive) })}</h3>
        <ul className="dash-categories">
          {STORAGE_CATEGORIES.filter((key) => current.categories[key] !== undefined).map((key) => (
            <li key={key}>
              <a href={CATEGORY_HREF[key]()} onClick={go(CATEGORY_HREF[key]())}>
                <i style={{ background: CATEGORY_COLOR[key] }} aria-hidden="true" />
                <span>
                  <strong>{t(`controlDash:dashboard.category.${key}`)}</strong>
                  <small>{t(`controlDash:dashboard.categoryHint.${key}`)}</small>
                </span>
                <b>{formatBytes(current.categories[key] ?? 0)}</b>
              </a>
            </li>
          ))}
          <li>
            <span className="dash-category-static">
              <i style={{ background: CATEGORY_COLOR.other }} aria-hidden="true" />
              <span>
                <strong>{t("controlDash:dashboard.category.other")}</strong>
                <small>{t("controlDash:dashboard.categoryHint.other")}</small>
              </span>
              <b>{formatBytes(current.other)}</b>
            </span>
          </li>
        </ul>
        {current.measuring && <p className="muted">{t("controlDash:dashboard.measuring")}</p>}

        <div className="dash-drive-columns">
          <div>
            <h4>{t("controlDash:dashboard.foldersTitle")}</h4>
            <ul className="dash-drive-folders">
              {drive.folders.map((folder) => (
                <li key={`${folder.owner}:${folder.mount}`}>
                  <code>{folder.mount}</code> <span className="muted">{folderLabel(folder)}</span>
                  <small>{describe(folder)}</small>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4>{t("controlDash:dashboard.growthTitle")}</h4>
            <p className="muted">{t("controlDash:dashboard.growthPending")}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Usage ───────────────────────────────────────────────────────────────────

type Period = "7d" | "30d" | "12m";
const PERIOD_DAYS: Record<Period, number> = { "7d": 7, "30d": 30, "12m": 365 };

type UsageActivity = DashboardActivity & { members?: { id: string; name: string; events: number }[] };

export function UsagePanel() {
  const { t } = useTranslation(["common", "controlDash"]);
  const [period, setPeriod] = useState<Period>("30d");
  const [application, setApplication] = useState<AppKey | "">("");
  const [activity, setActivity] = useState<UsageActivity | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const to = new Date();
    const from = new Date(to.getTime() - PERIOD_DAYS[period] * 86_400_000);
    const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    if (application) (APP_LOG_PREFIXES[application] ?? []).forEach((prefix) => query.append("eventPrefix", prefix));
    setError("");
    api<UsageActivity>(`/api/dashboard/activity?${query}`)
      .then(setActivity)
      .catch((err) => setError(err instanceof Error ? err.message : t("controlDash:activity.loadFailed")));
  }, [period, application, t]);

  const series = activity
    ? [
        { label: t("controlDash:activity.played"), data: activity.series.played, colorVar: "--mint" },
        { label: t("controlDash:activity.read"), data: activity.series.read, colorVar: "--blue" },
        { label: t("controlDash:activity.viewed"), data: activity.series.viewed, colorVar: "--gold" },
        { label: t("controlDash:activity.watched"), data: activity.series.watched, colorVar: "--rose" },
        { label: t("controlDash:activity.matches"), data: activity.series.matches, colorVar: "--success" },
        { label: t("controlDash:activity.uploads"), data: activity.series.uploads, colorVar: "--amber" }
      ]
    : [];
  const labels = activity?.buckets.map((bucket) => (activity.bucket === "hour" ? formatTime(bucket) : formatDate(bucket, "dayMonth"))) ?? [];
  const detailHref = activityHref(application ? { application } : {});

  return (
    <div className="dash-usage">
      <div className="dash-usage-controls">
        <div className="dash-chips" role="group" aria-label={t("controlDash:dashboard.period")}>
          {(Object.keys(PERIOD_DAYS) as Period[]).map((value) => (
            <Button key={value} variant="chip" selected={period === value} aria-pressed={period === value} onClick={() => setPeriod(value)}>
              {t(`controlDash:dashboard.periods.${value}`)}
            </Button>
          ))}
        </div>
        <SelectMenu
          value={application}
          options={[
            { value: "", label: t("controlDash:activity.applicationAll") },
            ...(Object.keys(APP_LOG_PREFIXES) as AppKey[]).map((key) => ({ value: key, label: appLabel(key) }))
          ]}
          label={t("controlDash:activity.application")}
          onChange={(value) => setApplication(applicationParam(value, APP_LOG_PREFIXES))}
        />
        <a className="dash-usage-link" href={detailHref} onClick={go(detailHref)}>
          {t("controlDash:dashboard.usageDetail")}
          <ArrowRight size={14} aria-hidden="true" />
        </a>
      </div>
      {error && <p className="status-empty">{error}</p>}
      {activity && (
        <>
          <DashboardChart type="bar" stacked labels={labels} series={series} height={200} />
          <DashboardChartLegend series={series} />
          <h4>{t("controlDash:dashboard.membersTitle")}</h4>
          {activity.members && activity.members.length > 0 ? (
            <ul className="dash-members">
              {activity.members.map((member) => {
                const href = logsHref({ user: member.id, ...(application ? { application } : {}) });
                return (
                  <li key={member.id}>
                    <a href={href} onClick={go(href)}>
                      <strong>{member.name}</strong>
                      <span className="muted">{t("controlDash:dashboard.memberEvents", { count: member.events, formatted: formatNumber(member.events) })}</span>
                      <ArrowRight size={14} aria-hidden="true" />
                    </a>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted">{t("controlDash:dashboard.noMembers")}</p>
          )}
        </>
      )}
    </div>
  );
}

// ── Current work ────────────────────────────────────────────────────────────

const POLL_MS = 5000;

export function CurrentWorkPanel() {
  const { t } = useTranslation(["common", "controlDash"]);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Every task in flight comes back whatever the page size; the history is not wanted.
    const payload = await api<{ jobs: Job[] }>("/api/jobs?pageSize=1");
    setJobs(payload.jobs.filter((job) => job.status === "running" || job.status === "pending"));
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : t("controlDash:tasks.loadFailed")));
  }, [load, t]);

  // Follow it while something runs; stop asking once nothing does.
  const active = (jobs?.length ?? 0) > 0;
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => { load().catch(() => undefined); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const cancel = async (job: Job) => {
    setCancelling(job.id);
    setError("");
    try {
      await api(`/api/jobs/${job.id}/cancel`, { method: "POST", body: "{}" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlDash:tasks.cancelFailed"));
    } finally {
      setCancelling(null);
    }
  };

  const allHref = tasksHref();
  if (jobs === null) return error ? <p className="status-empty">{error}</p> : null;

  return (
    <div className="dash-work">
      {error && <p className="status-empty">{error}</p>}
      {jobs.length === 0 ? (
        <p className="muted">{t("controlDash:dashboard.nothingRunning")}</p>
      ) : (
        <ul className="dash-work-list">
          {jobs.map((job) => {
            const share = job.progress && job.progress.total > 0 ? Math.round((job.progress.processed / job.progress.total) * 100) : null;
            const href = tasksHref(job.libraryId ? { library: job.libraryId } : {});
            return (
              <li key={job.id}>
                <div className="dash-work-head">
                  <strong>{taskLabel(job, t)}</strong>
                  {job.libraryName && <span className="muted">· {job.libraryName}</span>}
                  <span className="dash-work-state">
                    {job.status === "pending" ? t("controlDash:dashboard.queued") : job.progress ? progressText(job.progress, t) : t("controlDash:dashboard.running")}
                  </span>
                </div>
                <span className="dash-work-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={share ?? undefined} aria-label={taskLabel(job, t)}>
                  <span style={{ width: share === null ? (job.status === "running" ? "100%" : "0%") : `${share}%` }} className={share === null && job.status === "running" ? "is-indeterminate" : undefined} />
                </span>
                <div className="dash-work-actions">
                  <a href={href} onClick={go(href)}>
                    {t("controlDash:dashboard.progressAndLogs")}
                    <ArrowRight size={14} aria-hidden="true" />
                  </a>
                  <Button variant="secondary" compact disabled={cancelling === job.id} onClick={() => void cancel(job)} aria-label={t("controlDash:tasks.cancelNamed", { label: taskLabel(job, t) })}>
                    {cancelling === job.id ? t("controlDash:dashboard.cancelling") : t("controlDash:dashboard.cancel")}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <a className="dash-usage-link" href={allHref} onClick={go(allHref)}>
        {t("controlDash:dashboard.allTasks")}
        <ArrowRight size={14} aria-hidden="true" />
      </a>
    </div>
  );
}

/** A dashboard section's heading row: an icon, the title, and a link onward. */
export function DashSectionHead({ id, icon: Icon, title, link }: { id: string; icon: typeof HardDrive; title: string; link?: { href: string; label: string } }) {
  return (
    <div className="dash-section-head">
      <h2 id={id}><Icon size={18} aria-hidden="true" />{title}</h2>
      {link && <a href={link.href} onClick={go(link.href)}>{link.label}</a>}
    </div>
  );
}

export const DASH_ICONS = { storage: HardDrive, usage: Activity, work: ListChecks };
