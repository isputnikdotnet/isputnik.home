import { Fragment, useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AlertTriangle, CalendarClock, CheckCircle2, ChevronRight, ListTodo, Loader2, XCircle } from "lucide-react";
import { api } from "../../../../api";
import { controlHref, navigate } from "../../../../router";
import { Button } from "../../../../shared/Button";
import { KpiCard } from "../../../../shared/KpiCard";
import { MessageBox } from "../../../../shared/MessageBox";
import { Pager } from "../../../../shared/Pager";
import { ProgressRing } from "../../../../shared/ProgressRing";
import { SelectMenu } from "../../../../shared/SelectMenu";
import { formatManagedDate, formatEta, relativeTime } from "../../../../shared/utils";
import type { Job } from "../../types";

// Overview › Dashboard › Tasks — scans and other background work. It opens on
// the glance (running, queued, failed this week, last finished), keeps the
// in-flight tables that live-poll and cancel, and turns the finished history
// from an unfiltered dump into one that answers "which scans failed, and on
// which library". A pointer row says when the next scheduled run is due, since
// the schedule that creates most of these lives two groups away.

const PAGE_SIZE = 10;

type T = TFunction<readonly ["common", "controlDash"], undefined>;

function taskTypeLabel(type: string, t: T) {
  switch (type) {
    case "SCAN_AUDIOBOOK_LIBRARY": return t("controlDash:tasks.typeAudiobookScan");
    case "SCAN_EBOOK_LIBRARY": return t("controlDash:tasks.typeEbookScan");
    case "SCAN_GALLERY_LIBRARY": return t("controlDash:tasks.typeGalleryScan");
    case "SCAN_GALLERY_FACES": return t("controlDash:tasks.typeFaceScan");
    case "gallery-slideshow-render": return t("controlDash:tasks.typeSlideshow");
    case "TRANSCODE_GALLERY_VIDEO": return t("controlDash:tasks.typeTranscode");
    case "SCAN_GALLERY_DUPLICATES": return t("controlDash:tasks.typeDuplicateScan");
    default: return type;
  }
}

// "Face scan · batch 2/5" for jobs that are part of a pre-queued batch group.
function taskLabel(task: Job, t: T) {
  const base = taskTypeLabel(task.type, t);
  return task.batch ? `${base} · ${t("controlDash:tasks.batch", { index: task.batch.index, total: task.batch.total })}` : base;
}

function duration(start: string, end: string | null) {
  if (!end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function runningMinutes(start: string) {
  return Math.floor((Date.now() - new Date(start).getTime()) / 60000);
}

// "no progress for 42 minutes — this task may be stuck". The server decides WHEN a
// silence counts (per job type); this only says how long it has been.
function stalledText(seconds: number, t: T): string {
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60
    ? t("controlDash:tasks.stalledHours", { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
    : t("controlDash:tasks.stalledNote", { count: minutes });
}

// "3 of 12 books · 25% · about 2 min left" — mirrors the wording the
// face-recognition window used before this moved here.
function progressText(progress: NonNullable<Job["progress"]>, t: T): string {
  const parts = [t("controlDash:tasks.ofUnit", { processed: progress.processed.toLocaleString(), total: progress.total.toLocaleString(), unit: progress.unit })];
  if (progress.total > 0) parts.push(`${Math.round((progress.processed / progress.total) * 100)}%`);
  if (progress.etaSeconds != null) parts.push(formatEta(progress.etaSeconds));
  return parts.join(" · ");
}

interface TasksPayload {
  jobs: Job[];
  page: number;
  total: number;
  totalPages: number;
  // Library and face scans run one at a time server-wide. `holder` is the job with
  // the lock, `waiting` how many are queued behind it.
  queue: { holder: Job | null; waiting: number };
  facets: { types: string[]; libraries: { id: string; name: string }[] };
  summary: { running: number; queued: number; failedWeek: number; lastFinished: Job | null };
}

interface ScheduledSummary {
  key: string;
  label: string;
  enabled: boolean;
  nextRunAt: string | null;
}

export function TasksView() {
  const { t } = useTranslation(["common", "controlDash"]);
  const STATUS_OPTIONS = [
    { value: "", label: t("controlDash:tasks.outcomeAll") },
    { value: "failed", label: t("controlDash:tasks.outcomeFailed") },
    { value: "completed", label: t("controlDash:tasks.outcomeFinished") }
  ];
  const [data, setData] = useState<TasksPayload | null>(null);
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [expandedError, setExpandedError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [library, setLibrary] = useState("");
  const [nextScheduled, setNextScheduled] = useState<ScheduledSummary | null | undefined>(undefined);

  const loadTasks = useCallback(async () => {
    const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (status) query.set("status", status);
    if (type) query.set("type", type);
    if (library) query.set("library", library);
    const payload = await api<TasksPayload>(`/api/jobs?${query}`);
    setData(payload);
    setPage(payload.page);
  }, [page, status, type, library]);

  useEffect(() => {
    loadTasks().catch((err) => setError(err instanceof Error ? err.message : t("controlDash:tasks.loadFailed")));
  }, [loadTasks]);

  // The soonest enabled schedule, so this tab can say what is coming as well as
  // what has been. undefined = still asking; null = nothing is scheduled.
  useEffect(() => {
    api<{ jobs: ScheduledSummary[] }>("/api/scheduled-jobs")
      .then((payload) => {
        const soonest = payload.jobs
          .filter((job) => job.enabled && job.nextRunAt)
          .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))[0];
        setNextScheduled(soonest ?? null);
      })
      .catch(() => setNextScheduled(null));
  }, []);

  const tasks = data?.jobs ?? [];
  useEffect(() => {
    const active = tasks.some((t) => t.status === "pending" || t.status === "running");
    if (!active) return;
    const timer = window.setInterval(() => {
      loadTasks().catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [tasks, loadTasks]);

  const cancelTask = async (taskId: string) => {
    setCancelling(taskId);
    try {
      await api(`/api/jobs/${taskId}/cancel`, { method: "POST", body: "{}" });
      await loadTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlDash:tasks.cancelFailed"));
    } finally {
      setCancelling(null);
    }
  };

  const running = tasks.filter((t) => t.status === "running");
  const queued = tasks.filter((t) => t.status === "pending");
  const finished = tasks.filter((t) => t.status === "completed" || t.status === "failed");
  const filtered = Boolean(status || type || library);

  const typeOptions = [
    { value: "", label: t("controlDash:tasks.everyKind") },
    ...(data?.facets.types ?? []).map((value) => ({ value, label: taskTypeLabel(value, t) }))
  ];
  const libraryOptions = [
    { value: "", label: t("controlDash:tasks.everyLibrary") },
    ...(data?.facets.libraries ?? []).map((entry) => ({ value: entry.id, label: entry.name }))
  ];

  return (
    <div className="status-stack compact-tables">
      <section className="status-block">
        {error && <MessageBox tone="error" title={t("controlDash:tasks.errorTitle")}>{error}</MessageBox>}

        {data && (
          <div className="kpi-cards">
            <KpiCard
              icon={Loader2}
              tone={data.summary.running > 0 ? "success" : "info"}
              label={t("controlDash:tasks.running")}
              value={String(data.summary.running)}
              context={
                running[0]
                  ? `${taskLabel(running[0], t)}${running[0].libraryName ? ` · ${running[0].libraryName}` : ""}`
                  : t("controlDash:tasks.nothingRunning")
              }
            />
            <KpiCard
              icon={ListTodo}
              tone="info"
              label={t("controlDash:tasks.queued")}
              value={String(data.summary.queued)}
              context={queued[0] ? t("controlDash:tasks.nextUp", { label: taskLabel(queued[0], t) }) : t("controlDash:tasks.queueEmpty")}
            />
            <KpiCard
              icon={AlertTriangle}
              tone={data.summary.failedWeek > 0 ? "danger" : "success"}
              label={t("controlDash:tasks.failed")}
              value={String(data.summary.failedWeek)}
              context={t("controlDash:tasks.lastSevenDays")}
            />
            <KpiCard
              icon={CheckCircle2}
              tone="info"
              label={t("controlDash:tasks.lastFinished")}
              value={data.summary.lastFinished?.completedAt ? relativeTime(data.summary.lastFinished.completedAt) : "—"}
              context={
                data.summary.lastFinished
                  ? `${taskLabel(data.summary.lastFinished, t)}${data.summary.lastFinished.libraryName ? ` · ${data.summary.lastFinished.libraryName}` : ""}`
                  : t("controlDash:tasks.noneFinished")
              }
            />
          </div>
        )}

        {/* The schedule that makes most of these lives under Maintenance; this
            row is the one line of it that belongs here — what comes next. */}
        {nextScheduled !== undefined && (
          <div className="datagrid-wrap">
            <table className="datagrid locations-table">
              <tbody>
                <tr className="system-pointer-row" onClick={() => navigate(controlHref("scheduledJobs"))}>
                  <td>
                    <span className="location-cell">
                      <CalendarClock size={17} aria-hidden="true" className="signins-device-icon" />
                      <span className="datagrid-primary">
                        <strong>{nextScheduled ? t("controlDash:tasks.nextScheduled", { label: nextScheduled.label }) : t("controlDash:tasks.nothingScheduled")}</strong>
                        <small>
                          {nextScheduled
                            ? `${relativeTime(nextScheduled.nextRunAt!)} · ${formatManagedDate(nextScheduled.nextRunAt!)}`
                            : t("controlDash:tasks.scheduleHint")}
                        </small>
                      </span>
                    </span>
                  </td>
                  <td className="locations-row-action">
                    <Button
                      variant="icon"
                      aria-label={t("controlDash:tasks.openScheduled")}
                      title={t("controlDash:tasks.openScheduled")}
                      onClick={(event) => {
                        event.stopPropagation();
                        navigate(controlHref("scheduledJobs"));
                      }}
                    >
                      <ChevronRight size={16} aria-hidden="true" />
                    </Button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {/* Library and face scans are serialised server-wide, so a queue that isn't
            moving is usually correct — but it reads as a dead worker unless the page
            says what everything is waiting on, and says so louder when the holder
            has stopped reporting progress. */}
        {data && data.queue.holder && data.queue.waiting > 0 && (
          <MessageBox
            tone={data.queue.holder.stalledSeconds != null ? "warning" : "info"}
            title={t("controlDash:tasks.queueHeldTitle", { count: data.queue.waiting })}
          >
            {t(
              data.queue.holder.stalledSeconds != null ? "controlDash:tasks.queueHeldStuckBody" : "controlDash:tasks.queueHeldBody",
              {
                label: `${taskLabel(data.queue.holder, t)}${data.queue.holder.libraryName ? ` · ${data.queue.holder.libraryName}` : ""}`
              }
            )}
          </MessageBox>
        )}

        {running.length > 0 && (
          <div className="status-subsection">
            <div className="status-table-title">
              <h3>{t("controlDash:tasks.running")}</h3>
              <span>{t("controlDash:tasks.runningCount", { count: running.length })}</span>
            </div>
            <div className="datagrid-wrap task-active-grid">
              <table className="datagrid">
                <thead>
                  <tr>
                    <th>{t("controlDash:table.task")}</th>
                    <th>{t("controlDash:table.library")}</th>
                    <th>{t("controlDash:table.progress")}</th>
                    <th className="col-scan">{t("controlDash:table.started")}</th>
                    <th className="col-actions" aria-label={t("controlDash:table.actions")} />
                  </tr>
                </thead>
                <tbody>
                  {running.map((task) => {
                    const percent = task.progress && task.progress.total > 0 ? task.progress.processed / task.progress.total : null;
                    const mins = runningMinutes(task.createdAt);
                    const stalled = task.stalledSeconds;
                    return (
                      <tr key={task.id} className={stalled != null ? "task-stalled" : undefined}>
                        <td>
                          <span className="task-name">
                            {stalled != null
                              ? <AlertTriangle size={18} aria-hidden="true" className="task-stalled-icon" />
                              : <ProgressRing progress={percent ?? 0} indeterminate={percent === null} size={22} strokeWidth={3} />}
                            {taskLabel(task, t)}
                          </span>
                        </td>
                        <td className="datagrid-muted">{task.libraryName ?? <span className="muted">—</span>}</td>
                        <td className="datagrid-muted">
                          {task.progress ? progressText(task.progress, t) : t("controlDash:tasks.working")}
                          {/* The stall note replaces "running 40m": both say the task is
                              old, only one says the work has stopped moving. It sits on
                              its own line — appended inline it is long enough to widen
                              the table past its container and squeeze the first column. */}
                          {stalled != null
                            ? <span className="task-stalled-note">{stalledText(stalled, t)}</span>
                            : mins >= 10 && <span className="task-long-running"> · {t("controlDash:tasks.runningFor", { minutes: mins })}</span>}
                        </td>
                        <td className="col-scan datagrid-muted">{formatManagedDate(task.createdAt)}</td>
                        <td className="col-actions">
                          <Button
                            variant="icon"
                            danger
                            title={t("controlDash:tasks.cancelTask")}
                            aria-label={t("controlDash:tasks.cancelNamed", { label: taskLabel(task, t) })}
                            disabled={cancelling === task.id}
                            onClick={() => cancelTask(task.id)}
                          >
                            <XCircle size={15} aria-hidden="true" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {queued.length > 0 && (
          <div className="status-subsection">
            <div className="status-table-title">
              <h3>{t("controlDash:tasks.queued")}</h3>
              <span>{t("controlDash:tasks.queuedCount", { count: queued.length })}</span>
            </div>
            <div className="datagrid-wrap task-queued-grid">
              <table className="datagrid">
                <thead>
                  <tr>
                    <th className="task-queue-pos">#</th>
                    <th>{t("controlDash:table.task")}</th>
                    <th>{t("controlDash:table.library")}</th>
                    <th className="col-scan">{t("controlDash:tasks.queued")}</th>
                    <th className="col-actions" aria-label={t("controlDash:table.actions")} />
                  </tr>
                </thead>
                <tbody>
                  {queued.map((task, index) => (
                    <tr key={task.id}>
                      <td className="task-queue-pos datagrid-muted">{index + 1}</td>
                      <td>{taskLabel(task, t)}</td>
                      <td className="datagrid-muted">{task.libraryName ?? <span className="muted">—</span>}</td>
                      <td className="col-scan datagrid-muted">{formatManagedDate(task.createdAt)}</td>
                      <td className="col-actions">
                        <Button
                          variant="icon"
                          danger
                          title={t("controlDash:tasks.cancelTask")}
                          aria-label={t("controlDash:tasks.cancelNamed", { label: taskLabel(task, t) })}
                          disabled={cancelling === task.id}
                          onClick={() => cancelTask(task.id)}
                        >
                          <XCircle size={15} aria-hidden="true" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="status-subsection">
          <div className="status-table-title">
            <h3>{t("controlDash:tasks.history")}</h3>
            <span>{filtered ? t("controlDash:tasks.historyCountMatch", { count: data?.total ?? 0 }) : t("controlDash:tasks.historyCount", { count: data?.total ?? 0 })}</span>
          </div>

          {/* Three narrowings that AND together. Each is a menu rather than a
              facet panel because the lists are short and the choice is usually
              one thing: failed, this kind, this library. */}
          <div className="task-filter-row">
            <SelectMenu
              value={status}
              options={STATUS_OPTIONS}
              label={t("controlDash:tasks.outcome")}
              onChange={(value) => { setStatus(value); setPage(1); }}
            />
            <SelectMenu
              value={type}
              options={typeOptions}
              label={t("controlDash:tasks.kindOfTask")}
              onChange={(value) => { setType(value); setPage(1); }}
            />
            <SelectMenu
              value={library}
              options={libraryOptions}
              label={t("controlDash:tasks.library")}
              onChange={(value) => { setLibrary(value); setPage(1); }}
            />
            {filtered && (
              <Button variant="text" onClick={() => { setStatus(""); setType(""); setLibrary(""); setPage(1); }}>
                {t("controlDash:tasks.clearFilters")}
              </Button>
            )}
          </div>

          {data && finished.length === 0 && !error ? (
            <p className="status-empty">{filtered ? t("controlDash:tasks.noMatches") : t("controlDash:tasks.noneYet")}</p>
          ) : (
            <>
              <div className="datagrid-wrap">
                <table className="datagrid">
                  <thead>
                    <tr>
                      <th>{t("controlDash:table.task")}</th>
                      <th>{t("controlDash:table.library")}</th>
                      <th>{t("controlDash:table.status")}</th>
                      <th className="col-scan">{t("controlDash:table.started")}</th>
                      <th className="col-scan">{t("controlDash:table.duration")}</th>
                      <th>{t("controlDash:table.resultError")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {finished.map((task) => {
                      const ended = task.completedAt ?? task.failedAt;
                      // Measure from when the job actually started running, not when it
                      // was queued; fall back to createdAt for jobs that never ran (or
                      // predate the started_at column).
                      const startedAt = task.startedAt ?? task.createdAt;
                      const d = duration(startedAt, ended);
                      const errorText = task.error ?? null;

                      return (
                        <Fragment key={task.id}>
                          <tr>
                            <td>{taskLabel(task, t)}</td>
                            <td className="datagrid-muted">{task.libraryName ?? <span className="muted">—</span>}</td>
                            <td>
                              <span className={`status-badge ${task.status}`}>
                                {task.status === "completed"
                                  ? t("controlDash:tasks.statusCompleted")
                                  : task.status === "failed"
                                    ? t("controlDash:tasks.statusFailed")
                                    : task.status}
                              </span>
                            </td>
                            <td className="col-scan datagrid-muted">{formatManagedDate(startedAt)}</td>
                            <td className="col-scan datagrid-muted">{d ?? <span className="muted">—</span>}</td>
                            <td className="task-result-cell">
                              {task.summary && (
                                task.bookErrors.length > 0 ? (
                                  <button
                                    type="button"
                                    className="job-error-toggle task-result-text"
                                    onClick={() => setExpandedError(expandedError === task.id ? null : task.id)}
                                    title={t("controlDash:tasks.showSkipped")}
                                  >
                                    {task.summary}
                                  </button>
                                ) : (
                                  <span className="task-result-text datagrid-muted">{task.summary}</span>
                                )
                              )}
                              {!task.summary && errorText && (
                                <button
                                  type="button"
                                  className="job-error-toggle task-result-text"
                                  onClick={() => setExpandedError(expandedError === task.id ? null : task.id)}
                                  title={errorText}
                                >
                                  {errorText.split("\n")[0].slice(0, 80)}{errorText.length > 80 ? "…" : ""}
                                </button>
                              )}
                              {!task.summary && !errorText && <span className="muted">—</span>}
                            </td>
                          </tr>
                          {expandedError === task.id && errorText && (
                            <tr>
                              <td colSpan={6}>
                                <pre className="job-error-detail">{errorText}</pre>
                              </td>
                            </tr>
                          )}
                          {expandedError === task.id && !errorText && task.bookErrors.length > 0 && (
                            <tr>
                              <td colSpan={6}>
                                <pre className="job-error-detail">{task.bookErrors.join("\n")}</pre>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {data && (
                <Pager page={data.page} totalPages={data.totalPages} onChange={setPage} label={t("controlDash:pagers.task")} />
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
