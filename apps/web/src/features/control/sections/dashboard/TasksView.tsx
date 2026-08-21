import { Fragment, useState, useEffect, useCallback } from "react";
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

function taskTypeLabel(type: string) {
  switch (type) {
    case "SCAN_AUDIOBOOK_LIBRARY": return "Audiobook scan";
    case "SCAN_EBOOK_LIBRARY": return "Ebook scan";
    case "SCAN_GALLERY_LIBRARY": return "Photo & video scan";
    case "SCAN_GALLERY_FACES": return "Face scan";
    case "gallery-slideshow-render": return "Slideshow movie";
    case "TRANSCODE_GALLERY_VIDEO": return "Video conversion";
    case "SCAN_GALLERY_DUPLICATES": return "Duplicate photo scan";
    default: return type;
  }
}

// "Face scan · batch 2/5" for jobs that are part of a pre-queued batch group.
function taskLabel(task: Job) {
  const base = taskTypeLabel(task.type);
  return task.batch ? `${base} · batch ${task.batch.index}/${task.batch.total}` : base;
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

// "3 of 12 books · 25% · about 2 min left" — mirrors the wording the
// face-recognition window used before this moved here.
function progressText(progress: NonNullable<Job["progress"]>): string {
  const parts = [`${progress.processed.toLocaleString()} of ${progress.total.toLocaleString()} ${progress.unit}`];
  if (progress.total > 0) parts.push(`${Math.round((progress.processed / progress.total) * 100)}%`);
  if (progress.etaSeconds != null) parts.push(formatEta(progress.etaSeconds));
  return parts.join(" · ");
}

interface TasksPayload {
  jobs: Job[];
  page: number;
  total: number;
  totalPages: number;
  facets: { types: string[]; libraries: { id: string; name: string }[] };
  summary: { running: number; queued: number; failedWeek: number; lastFinished: Job | null };
}

interface ScheduledSummary {
  key: string;
  label: string;
  enabled: boolean;
  nextRunAt: string | null;
}

const STATUS_OPTIONS = [
  { value: "", label: "Finished and failed" },
  { value: "failed", label: "Failed only" },
  { value: "completed", label: "Finished only" }
];

export function TasksView() {
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
    loadTasks().catch((err) => setError(err instanceof Error ? err.message : "Unable to load tasks"));
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
      setError(err instanceof Error ? err.message : "Unable to cancel task");
    } finally {
      setCancelling(null);
    }
  };

  const running = tasks.filter((t) => t.status === "running");
  const queued = tasks.filter((t) => t.status === "pending");
  const finished = tasks.filter((t) => t.status === "completed" || t.status === "failed");
  const filtered = Boolean(status || type || library);

  const typeOptions = [
    { value: "", label: "Every kind" },
    ...(data?.facets.types ?? []).map((value) => ({ value, label: taskTypeLabel(value) }))
  ];
  const libraryOptions = [
    { value: "", label: "Every library" },
    ...(data?.facets.libraries ?? []).map((entry) => ({ value: entry.id, label: entry.name }))
  ];

  return (
    <div className="status-stack compact-tables">
      <section className="status-block">
        {error && <MessageBox tone="error" title="Tasks error">{error}</MessageBox>}

        {data && (
          <div className="kpi-cards">
            <KpiCard
              icon={Loader2}
              tone={data.summary.running > 0 ? "success" : "info"}
              label="Running"
              value={String(data.summary.running)}
              context={
                running[0]
                  ? `${taskLabel(running[0])}${running[0].libraryName ? ` · ${running[0].libraryName}` : ""}`
                  : "Nothing is running"
              }
            />
            <KpiCard
              icon={ListTodo}
              tone="info"
              label="Queued"
              value={String(data.summary.queued)}
              context={queued[0] ? `Next up: ${taskLabel(queued[0])}` : "The queue is empty"}
            />
            <KpiCard
              icon={AlertTriangle}
              tone={data.summary.failedWeek > 0 ? "danger" : "success"}
              label="Failed"
              value={String(data.summary.failedWeek)}
              context="In the last 7 days"
            />
            <KpiCard
              icon={CheckCircle2}
              tone="info"
              label="Last finished"
              value={data.summary.lastFinished?.completedAt ? relativeTime(data.summary.lastFinished.completedAt) : "—"}
              context={
                data.summary.lastFinished
                  ? `${taskLabel(data.summary.lastFinished)}${data.summary.lastFinished.libraryName ? ` · ${data.summary.lastFinished.libraryName}` : ""}`
                  : "No task has finished yet"
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
                        <strong>{nextScheduled ? `Next scheduled: ${nextScheduled.label}` : "Nothing is scheduled"}</strong>
                        <small>
                          {nextScheduled
                            ? `${relativeTime(nextScheduled.nextRunAt!)} · ${formatManagedDate(nextScheduled.nextRunAt!)}`
                            : "Set up nightly scans and backups under Maintenance › Scheduled jobs"}
                        </small>
                      </span>
                    </span>
                  </td>
                  <td className="locations-row-action">
                    <Button
                      variant="icon"
                      aria-label="Open Scheduled jobs"
                      title="Open Scheduled jobs"
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

        {running.length > 0 && (
          <div className="status-subsection">
            <div className="status-table-title">
              <h3>Running</h3>
              <span>{running.length} {running.length === 1 ? "task" : "tasks"} · refreshes every few seconds</span>
            </div>
            <div className="datagrid-wrap task-active-grid">
              <table className="datagrid">
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Library</th>
                    <th>Progress</th>
                    <th className="col-scan">Started</th>
                    <th className="col-actions" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {running.map((task) => {
                    const percent = task.progress && task.progress.total > 0 ? task.progress.processed / task.progress.total : null;
                    const mins = runningMinutes(task.createdAt);
                    return (
                      <tr key={task.id}>
                        <td>
                          <span className="task-name">
                            <ProgressRing progress={percent ?? 0} indeterminate={percent === null} size={22} strokeWidth={3} />
                            {taskLabel(task)}
                          </span>
                        </td>
                        <td className="datagrid-muted">{task.libraryName ?? <span className="muted">—</span>}</td>
                        <td className="datagrid-muted">
                          {task.progress ? progressText(task.progress) : "Working…"}
                          {mins >= 10 && <span className="task-long-running"> · running {mins}m</span>}
                        </td>
                        <td className="col-scan datagrid-muted">{formatManagedDate(task.createdAt)}</td>
                        <td className="col-actions">
                          <Button
                            variant="icon"
                            danger
                            title="Cancel task"
                            aria-label={`Cancel ${taskLabel(task)}`}
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
              <h3>Queued</h3>
              <span>{queued.length} waiting · in the order they will run</span>
            </div>
            <div className="datagrid-wrap task-queued-grid">
              <table className="datagrid">
                <thead>
                  <tr>
                    <th className="task-queue-pos">#</th>
                    <th>Task</th>
                    <th>Library</th>
                    <th className="col-scan">Queued</th>
                    <th className="col-actions" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {queued.map((task, index) => (
                    <tr key={task.id}>
                      <td className="task-queue-pos datagrid-muted">{index + 1}</td>
                      <td>{taskLabel(task)}</td>
                      <td className="datagrid-muted">{task.libraryName ?? <span className="muted">—</span>}</td>
                      <td className="col-scan datagrid-muted">{formatManagedDate(task.createdAt)}</td>
                      <td className="col-actions">
                        <Button
                          variant="icon"
                          danger
                          title="Cancel task"
                          aria-label={`Cancel ${taskLabel(task)}`}
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
            <h3>History</h3>
            <span>
              {(data?.total ?? 0).toLocaleString()} {data?.total === 1 ? "task" : "tasks"}
              {filtered ? " match" : ""}
            </span>
          </div>

          {/* Three narrowings that AND together. Each is a menu rather than a
              facet panel because the lists are short and the choice is usually
              one thing: failed, this kind, this library. */}
          <div className="task-filter-row">
            <SelectMenu
              value={status}
              options={STATUS_OPTIONS}
              label="Outcome"
              onChange={(value) => { setStatus(value); setPage(1); }}
            />
            <SelectMenu
              value={type}
              options={typeOptions}
              label="Kind of task"
              onChange={(value) => { setType(value); setPage(1); }}
            />
            <SelectMenu
              value={library}
              options={libraryOptions}
              label="Library"
              onChange={(value) => { setLibrary(value); setPage(1); }}
            />
            {filtered && (
              <Button variant="text" onClick={() => { setStatus(""); setType(""); setLibrary(""); setPage(1); }}>
                Clear filters
              </Button>
            )}
          </div>

          {data && finished.length === 0 && !error ? (
            <p className="status-empty">{filtered ? "No finished tasks match these filters." : "No finished tasks yet."}</p>
          ) : (
            <>
              <div className="datagrid-wrap">
                <table className="datagrid">
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th>Library</th>
                      <th>Status</th>
                      <th className="col-scan">Started</th>
                      <th className="col-scan">Duration</th>
                      <th>Result / Error</th>
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
                            <td>{taskLabel(task)}</td>
                            <td className="datagrid-muted">{task.libraryName ?? <span className="muted">—</span>}</td>
                            <td>
                              <span className={`status-badge ${task.status}`}>{task.status}</span>
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
                                    title="Show skipped items"
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
                <Pager page={data.page} totalPages={data.totalPages} onChange={setPage} label="Task pages" />
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
