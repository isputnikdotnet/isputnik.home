import { useState, useEffect, useCallback } from "react";
import { XCircle } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { ProgressRing } from "../../../shared/ProgressRing";
import { formatManagedDate, formatEta } from "../../../shared/utils";
import type { Job } from "../types";

const PAGE_SIZE = 25;

function taskTypeLabel(type: string) {
  switch (type) {
    case "SCAN_AUDIOBOOK_LIBRARY": return "Audiobook scan";
    case "SCAN_EBOOK_LIBRARY": return "Ebook scan";
    case "SCAN_GALLERY_LIBRARY": return "Photo & video scan";
    case "SCAN_GALLERY_FACES": return "Face scan";
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

export function TasksSection() {
  const [tasks, setTasks] = useState<Job[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [expandedError, setExpandedError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  const loadTasks = useCallback(async () => {
    const payload = await api<{ jobs: Job[]; page: number; total: number; totalPages: number }>(
      `/api/jobs?page=${page}&pageSize=${PAGE_SIZE}`
    );
    setTasks(payload.jobs);
    setPage(payload.page);
    setTotal(payload.total);
    setTotalPages(payload.totalPages);
    setLoaded(true);
  }, [page]);

  useEffect(() => {
    loadTasks().catch((err) => setError(err instanceof Error ? err.message : "Unable to load tasks"));
  }, [loadTasks]);

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

  return (
    <>
      <div className="section-head">
        <div>
          <p className="eyebrow">Maintenance</p>
          <h1>Tasks</h1>
        </div>
        <button className="secondary-button" onClick={() => loadTasks().catch(() => undefined)}>
          Refresh
        </button>
      </div>

      {error && <MessageBox tone="error" title="Tasks error">{error}</MessageBox>}

      {loaded && running.length === 0 && queued.length === 0 && (
        <p className="task-idle-note muted">Nothing is running or waiting right now.</p>
      )}

      {running.length > 0 && (
        <>
          <h2 className="task-group-title">Running <span className="task-group-count">{running.length}</span></h2>
          <div className="datagrid-wrap task-active-grid">
            <table className="datagrid">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Library</th>
                  <th>Progress</th>
                  <th className="col-scan">Started</th>
                  <th className="col-actions"></th>
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
                        <button
                          className="icon-button danger"
                          title="Cancel task"
                          disabled={cancelling === task.id}
                          onClick={() => cancelTask(task.id)}
                        >
                          <XCircle size={15} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {queued.length > 0 && (
        <>
          <h2 className="task-group-title">Queued <span className="task-group-count">{queued.length}</span></h2>
          <div className="datagrid-wrap task-queued-grid">
            <table className="datagrid">
              <thead>
                <tr>
                  <th className="task-queue-pos">#</th>
                  <th>Task</th>
                  <th>Library</th>
                  <th className="col-scan">Queued</th>
                  <th className="col-actions"></th>
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
                      <button
                        className="icon-button danger"
                        title="Cancel task"
                        disabled={cancelling === task.id}
                        onClick={() => cancelTask(task.id)}
                      >
                        <XCircle size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2 className="task-group-title">History <span className="task-group-count">{total}</span></h2>
      {finished.length === 0 && !error ? (
        <p className="management-empty">No finished tasks yet.</p>
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
                    <>
                      <tr key={task.id}>
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
                        <tr key={`${task.id}-error`}>
                          <td colSpan={6}>
                            <pre className="job-error-detail">{errorText}</pre>
                          </td>
                        </tr>
                      )}
                      {expandedError === task.id && !errorText && task.bookErrors.length > 0 && (
                        <tr key={`${task.id}-book-errors`}>
                          <td colSpan={6}>
                            <pre className="job-error-detail">{task.bookErrors.join("\n")}</pre>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="log-pager">
              <span>{(page - 1) * PAGE_SIZE + 1}-{Math.min(page * PAGE_SIZE, total)} of {total}</span>
              <div>
                <button className="secondary-button pager-button" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </button>
                <span>Page {page} of {totalPages}</span>
                <button className="secondary-button pager-button" disabled={page === totalPages} onClick={() => setPage((p) => p + 1)}>
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
