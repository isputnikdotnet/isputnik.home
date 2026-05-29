import { useState, useEffect, useCallback } from "react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { formatManagedDate } from "../../../shared/utils";
import type { Job } from "../types";

function jobTypeLabel(type: string) {
  if (type === "SCAN_AUDIOBOOK_LIBRARY") return "Scan library";
  return type;
}

function duration(start: string, end: string | null) {
  if (!end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

export function JobsSection() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState("");

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

  return (
    <>
      <div className="section-head">
        <div>
          <p className="eyebrow">Application</p>
          <h1>Jobs</h1>
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
                <th className="col-num">Attempts</th>
                <th className="col-scan">Started</th>
                <th className="col-scan">Duration</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => {
                const ended = job.completedAt ?? job.failedAt;
                const d = duration(job.createdAt, ended);
                return (
                  <tr key={job.id}>
                    <td>{jobTypeLabel(job.type)}</td>
                    <td className="datagrid-muted">{job.libraryName ?? <span className="muted">—</span>}</td>
                    <td>
                      <span className={`status-badge ${job.status}`}>{job.status}</span>
                    </td>
                    <td className="col-num datagrid-muted">{job.attempts}</td>
                    <td className="col-scan datagrid-muted">{formatManagedDate(job.createdAt)}</td>
                    <td className="col-scan datagrid-muted">{d ?? <span className="muted">—</span>}</td>
                    <td>
                      {job.error
                        ? <span className="job-error" title={job.error}>{job.error.slice(0, 80)}{job.error.length > 80 ? "…" : ""}</span>
                        : <span className="muted">—</span>
                      }
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
