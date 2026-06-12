import { useState, useEffect, useCallback, type FormEvent } from "react";
import { FileText } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { formatManagedDate } from "../../../shared/utils";
import type { LogEvent } from "../types";

function LogEventCell({ event }: { event: string }) {
  const [category, ...rest] = event.split(".");
  const action = rest.join(" ").replace(/_/g, " ");
  return (
    <span className="log-event-cell">
      <span className={`event-category cat-${category}`}>{category}</span>
      <span className="event-action">{action}</span>
    </span>
  );
}

export function LogsSection() {
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [error, setError] = useState("");
  const [logSearchInput, setLogSearchInput] = useState("");
  const [logSearch, setLogSearch] = useState("");
  const [logPage, setLogPage] = useState(1);
  const [logPageSize, setLogPageSize] = useState(25);
  const [logTotal, setLogTotal] = useState(0);
  const [logTotalPages, setLogTotalPages] = useState(1);
  const [retentionDays, setRetentionDays] = useState(365);
  const [logCleanupStatus, setLogCleanupStatus] = useState("");
  const [pendingCleanup, setPendingCleanup] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const loadLogs = useCallback(async () => {
    const query = new URLSearchParams({
      page: String(logPage),
      pageSize: String(logPageSize)
    });
    if (logSearch) {
      query.set("q", logSearch);
    }
    const payload = await api<{ logs: LogEvent[]; page: number; pageSize: number; total: number; totalPages: number }>(`/api/logs?${query}`);
    setLogs(payload.logs);
    setLogPage(payload.page);
    setLogTotal(payload.total);
    setLogTotalPages(payload.totalPages);
  }, [logPage, logPageSize, logSearch]);

  useEffect(() => {
    loadLogs().catch((err) => setError(err instanceof Error ? err.message : "Unable to load logs"));
  }, [loadLogs]);

  useEffect(() => {
    if (!pendingCleanup) {
      return;
    }

    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !deleting) {
        setPendingCleanup(false);
      }
    };

    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [pendingCleanup, deleting]);

  const submitLogSearch = (event: FormEvent) => {
    event.preventDefault();
    const query = logSearchInput.trim();
    setLogCleanupStatus("");
    if (query === logSearch && logPage === 1) {
      loadLogs().catch((err) => setError(err instanceof Error ? err.message : "Unable to search logs"));
      return;
    }
    setLogPage(1);
    setLogSearch(query);
  };

  const deleteOldLogs = async () => {
    setDeleting(true);
    setError("");
    setLogCleanupStatus("");
    try {
      const payload = await api<{ deleted: number }>("/api/logs", {
        method: "DELETE",
        body: JSON.stringify({ olderThanDays: retentionDays })
      });
      setPendingCleanup(false);
      setLogCleanupStatus(`${payload.deleted} log ${payload.deleted === 1 ? "entry" : "entries"} deleted.`);
      if (logPage === 1) {
        await loadLogs();
      } else {
        setLogPage(1);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete old logs");
      setPendingCleanup(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <div className="section-head admin-section-head">
        <div className="admin-title-wrap">
          <span className="admin-page-icon logs" aria-hidden="true">
            <FileText size={30} />
          </span>
          <div className="admin-heading-copy">
            <p className="eyebrow">Management</p>
            <h1>Logs</h1>
            <p className="section-description">Review activity history and clean up old records.</p>
          </div>
        </div>
      </div>

      {error && <MessageBox tone="error" title="Logs error">{error}</MessageBox>}
      {logCleanupStatus && <MessageBox tone="success" title="Logs deleted">{logCleanupStatus}</MessageBox>}

      <div className="log-controls">
        <form className="log-search" onSubmit={submitLogSearch}>
          <input
            type="search"
            value={logSearchInput}
            onChange={(event) => setLogSearchInput(event.target.value)}
            placeholder="Search logs"
            aria-label="Search logs"
          />
          <button className="secondary-button compact-button">Search</button>
        </form>
        <label className="log-page-size">
          <span>Rows</span>
          <select
            value={logPageSize}
            onChange={(event) => {
              setLogPage(1);
              setLogPageSize(Number(event.target.value));
            }}
          >
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </label>
        <div className="log-retention">
          <label>
            <span>Delete older than</span>
            <input
              type="number"
              min={1}
              max={3650}
              value={retentionDays}
              onChange={(event) => setRetentionDays(Math.max(1, Math.min(3650, Number(event.target.value) || 365)))}
            />
            <span>days</span>
          </label>
          <button className="danger-button compact-button" onClick={() => setPendingCleanup(true)}>
            Delete old logs
          </button>
        </div>
      </div>

      {logs.length > 0 ? (
        <>
          <div className="datagrid-wrap log-table-wrap">
            <table className="datagrid log-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event</th>
                  <th>Detail</th>
                  <th>User</th>
                  <th>IP</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((entry) => (
                  <tr key={entry.id}>
                    <td className="datagrid-muted">{formatManagedDate(entry.createdAt)}</td>
                    <td><LogEventCell event={entry.event} /></td>
                    <td>{entry.detail}</td>
                    <td className="datagrid-muted">{entry.actorName ?? "System"}</td>
                    <td className="datagrid-muted">{entry.ipAddress ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="log-pager">
            <span>{(logPage - 1) * logPageSize + 1}-{Math.min(logPage * logPageSize, logTotal)} of {logTotal}</span>
            <div>
              <button className="secondary-button pager-button" disabled={logPage === 1} onClick={() => setLogPage((page) => page - 1)}>
                Previous
              </button>
              <span>Page {logPage} of {logTotalPages}</span>
              <button className="secondary-button pager-button" disabled={logPage === logTotalPages} onClick={() => setLogPage((page) => page + 1)}>
                Next
              </button>
            </div>
          </div>
        </>
      ) : (
        <p className="management-empty">No log entries found.</p>
      )}

      {pendingCleanup && (
        <ConfirmDialog
          title="Delete old logs?"
          confirmLabel="Delete logs"
          busyLabel="Deleting..."
          danger
          busy={deleting}
          onConfirm={deleteOldLogs}
          onCancel={() => setPendingCleanup(false)}
        >
          All log entries older than {retentionDays} days will be permanently deleted.
        </ConfirmDialog>
      )}
    </>
  );
}
