import { useState, useEffect, useCallback } from "react";
import { FileText, Search, Trash2 } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { FacetFilterButton, FacetFilterChips, type FacetDef } from "../../../shared/FacetFilter";
import { Pager } from "../../../shared/Pager";
import { RefreshButton } from "../../../shared/RefreshButton";
import { SelectMenu } from "../../../shared/SelectMenu";
import { formatManagedDate } from "../../../shared/utils";
import type { LogEvent } from "../types";
import { ControlSectionHead } from "../ControlSectionHead";

type LogFilterKey = "event" | "user" | "ip";

const EMPTY_LOG_FILTERS: Record<LogFilterKey, string[]> = { event: [], user: [], ip: [] };

const LOG_FACET_ORDER: FacetDef<LogFilterKey>[] = [
  { key: "event", title: "Event", searchable: true },
  { key: "user", title: "User", searchable: true },
  { key: "ip", title: "IP address", searchable: true }
];

const PAGE_SIZE_OPTIONS = [
  { value: "10", label: "10 rows" },
  { value: "25", label: "25 rows" },
  { value: "50", label: "50 rows" },
  { value: "100", label: "100 rows" }
];

// Typing straight into the results, without a Search button to press. Each query
// is a server round-trip, so it waits for a pause in typing rather than firing per
// keystroke.
const SEARCH_DEBOUNCE_MS = 350;

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
  const [filters, setFilters] = useState<Record<LogFilterKey, string[]>>(EMPTY_LOG_FILTERS);
  const [facets, setFacets] = useState<Partial<Record<LogFilterKey, string[]>>>({});
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
    (Object.keys(filters) as LogFilterKey[]).forEach((key) => {
      filters[key].forEach((value) => query.append(key, value));
    });
    const payload = await api<{
      logs: LogEvent[];
      facets: Record<LogFilterKey, string[]>;
      page: number;
      pageSize: number;
      total: number;
      totalPages: number;
    }>(`/api/logs?${query}`);
    setLogs(payload.logs);
    setFacets(payload.facets);
    setLogPage(payload.page);
    setLogTotal(payload.total);
    setLogTotalPages(payload.totalPages);
  }, [logPage, logPageSize, logSearch, filters]);

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

  useEffect(() => {
    const query = logSearchInput.trim();
    if (query === logSearch) return;
    const timer = window.setTimeout(() => {
      setLogCleanupStatus("");
      setLogPage(1);
      setLogSearch(query);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [logSearchInput, logSearch]);

  const changeFilters = (next: Record<LogFilterKey, string[]>) => {
    setLogCleanupStatus("");
    setLogPage(1);
    setFilters(next);
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
      <ControlSectionHead
        section="logs"
        icon={<FileText size={30} />}
        iconClassName="logs"
        description="Review activity history and clean up old records."
      >
        {/* Search rides in the header beside the title, like the Duplicate photos
            page — it's what you reach for first, and it keeps the toolbar below
            for the controls that change the whole view. */}
        <label className="search-field log-search">
          <Search size={17} aria-hidden="true" />
          <span className="sr-only">Search logs by detail, event, user or IP</span>
          <input
            type="search"
            value={logSearchInput}
            onChange={(event) => setLogSearchInput(event.target.value)}
            placeholder="Search logs..."
          />
        </label>
      </ControlSectionHead>

      {error && <MessageBox tone="error" title="Logs error">{error}</MessageBox>}
      {logCleanupStatus && <MessageBox tone="success" title="Logs deleted">{logCleanupStatus}</MessageBox>}

      {/* Filter on the left, view controls and the destructive action on the right. */}
      <div className="log-toolbar">
        <FacetFilterButton
          order={LOG_FACET_ORDER}
          facets={facets}
          value={filters}
          onChange={changeFilters}
          empty={EMPTY_LOG_FILTERS}
        />

        <div className="log-toolbar-controls">
          <SelectMenu
            value={String(logPageSize)}
            options={PAGE_SIZE_OPTIONS}
            label="Rows per page"
            className="log-page-size"
            onChange={(value) => { setLogPage(1); setLogPageSize(Number(value)); }}
          />
          <RefreshButton
            onRefresh={async () => {
              setError("");
              try {
                await loadLogs();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Unable to refresh logs");
                throw err;
              }
            }}
          />
          <Button
            variant="icon"
            danger
            onClick={() => { setLogCleanupStatus(""); setPendingCleanup(true); }}
            aria-label="Delete old logs"
            title="Delete old logs"
          >
            <Trash2 size={18} aria-hidden="true" />
          </Button>
        </div>
      </div>

      <FacetFilterChips value={filters} onChange={changeFilters} empty={EMPTY_LOG_FILTERS} />

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
          {/* Count on the left, page controls on the right — the same row the
              Duplicate photos list ends with. */}
          <div className="log-pager-row">
            <span className="datagrid-muted">
              Showing {(logPage - 1) * logPageSize + 1}–{Math.min(logPage * logPageSize, logTotal)} of {logTotal}
            </span>
            <Pager page={logPage} totalPages={logTotalPages} onChange={setLogPage} label="Log pages" />
          </div>
        </>
      ) : (
        <p className="management-empty">No log entries found.</p>
      )}

      {pendingCleanup && (
        <ConfirmDialog
          title="Delete old logs?"
          confirmLabel={`Delete logs older than ${retentionDays} days`}
          busyLabel="Deleting…"
          danger
          busy={deleting}
          onConfirm={deleteOldLogs}
          onCancel={() => setPendingCleanup(false)}
          rich
        >
          {/* The age lives here rather than in the toolbar: it's only ever read at
              the moment you delete, and a stray number box beside the results
              looked like a filter. */}
          <p>
            Log entries older than this are permanently deleted. Nothing else is touched, and the entries
            currently on screen stay unless they fall outside the window.
          </p>
          <label className="log-retention-field">
            <span>Delete entries older than</span>
            <input
              type="number"
              min={1}
              max={3650}
              value={retentionDays}
              disabled={deleting}
              autoFocus
              onChange={(event) => setRetentionDays(Math.max(1, Math.min(3650, Number(event.target.value) || 365)))}
            />
            <span>days</span>
          </label>
        </ConfirmDialog>
      )}
    </>
  );
}
