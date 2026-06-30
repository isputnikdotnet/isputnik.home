import { useState, useEffect, useCallback } from "react";
import { XCircle } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { formatManagedDate } from "../../../shared/utils";
import type { Job } from "../types";

function jobTypeLabel(type: string) {
  if (type === "SCAN_AUDIOBOOK_LIBRARY" || type === "SCAN_EBOOK_LIBRARY" || type === "SCAN_GALLERY_LIBRARY") return "Scan library";
  return type;
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

function jobResult(job: Job): string | null {
  if (job.status !== "completed" || !job.result) return null;
  const parts = [`${job.result.discoveredBooks ?? 0} books, ${job.result.discoveredFiles ?? 0} files`];
  if (job.result.bookErrors && job.result.bookErrors.length > 0) parts.push(`${job.result.bookErrors.length} skipped`);
  return parts.join(" · ");
}

export function JobsSection() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [expandedError, setExpandedError] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    const payload = await api<{ jobs: Job[] }>("/api/jobs");
    setJobs(payload.jobs);
  }, []);

  useEffect(() => {
    loadJobs().catch((err) => setError(err instanceof Error ? err.message : "Unable to load jobs"));
  }, [loadJobs]);

  useEffect(() => {
    const active = jobs.some((j) => j.status === "pending" || j.status === "running");
    if (!active) return;
    const timer = window.setInterval(() => {
      loadJobs().catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [jobs, loadJobs]);

  const cancelJob = async (jobId: string) => {
    setCancelling(jobId);
    try {
      await api(`/api/jobs/${jobId}/cancel`, { method: "POST", body: "{}" });
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to cancel job");
    } finally {
      setCancelling(null);
    }
  };

  return (
    <>
      <div className="section-head">
        <div>
          <p className="eyebrow">Maintenance</p>
          <h1>Job logs</h1>
        </div>
        <button className="secondary-button" onClick={() => loadJobs().catch(() => undefined)}>
          Refresh
        </button>
      </div>

      {error && <MessageBox tone="error" title="Jobs error">{error}</MessageBox>}

      {jobs.length === 0 && !error ? (
        <p className="management-empty">No jobs recorded yet.</p>
      ) : (
        <div className="datagrid-wrap">
          <table className="datagrid">
            <thead>
              <tr>
                <th>Type</th>
                <th>Library</th>
                <th>Status</th>
                <th className="col-scan">Started</th>
                <th className="col-scan">Duration</th>
                <th>Result / Error</th>
                <th className="col-actions"></th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => {
                const ended = job.completedAt ?? job.failedAt;
                const d = duration(job.createdAt, ended);
                const mins = (job.status === "running") ? runningMinutes(job.createdAt) : null;
                const isStuck = mins !== null && mins >= 10;
                const result = jobResult(job);
                const errors = job.result?.bookErrors ?? [];
                const errorText = job.error ?? null;

                return (
                  <>
                    <tr key={job.id}>
                      <td>{jobTypeLabel(job.type)}</td>
                      <td className="datagrid-muted">{job.libraryName ?? <span className="muted">—</span>}</td>
                      <td>
                        <span className={`status-badge ${job.status}${isStuck ? " stuck" : ""}`}>
                          {isStuck ? `running ${mins}m` : job.status}
                        </span>
                      </td>
                      <td className="col-scan datagrid-muted">{formatManagedDate(job.createdAt)}</td>
                      <td className="col-scan datagrid-muted">{d ?? <span className="muted">—</span>}</td>
                      <td>
                        {result && <span className="datagrid-muted">{result}</span>}
                        {!result && job.status === "running" && job.progress && (
                          <span className="datagrid-muted">{job.progress.booksProcessed} / {job.progress.booksTotal} books</span>
                        )}
                        {!result && errorText && (
                          <button
                            className="job-error-toggle"
                            onClick={() => setExpandedError(expandedError === job.id ? null : job.id)}
                            title={errorText}
                          >
                            {errorText.split("\n")[0].slice(0, 80)}{errorText.length > 80 ? "…" : ""}
                          </button>
                        )}
                        {!result && !errorText && !(job.status === "running" && job.progress) && <span className="muted">—</span>}
                      </td>
                      <td className="col-actions">
                        {(job.status === "pending" || job.status === "running") && (
                          <button
                            className="icon-button danger"
                            title="Cancel job"
                            disabled={cancelling === job.id}
                            onClick={() => cancelJob(job.id)}
                          >
                            <XCircle size={15} />
                          </button>
                        )}
                      </td>
                    </tr>
                    {expandedError === job.id && errorText && (
                      <tr key={`${job.id}-error`}>
                        <td colSpan={7}>
                          <pre className="job-error-detail">{errorText}</pre>
                        </td>
                      </tr>
                    )}
                    {job.status === "completed" && errors.length > 0 && expandedError === job.id && (
                      <tr key={`${job.id}-book-errors`}>
                        <td colSpan={7}>
                          <pre className="job-error-detail">{errors.join("\n")}</pre>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
