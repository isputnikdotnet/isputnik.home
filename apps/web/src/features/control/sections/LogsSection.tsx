import { Fragment, useState, useEffect, useCallback } from "react";
import { ChevronDown, ChevronRight, Download, FileText, Search, Trash2 } from "lucide-react";
import { api } from "../../../api";
import { navigate } from "../../../router";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import {
  ALL_TIME,
  DateRangePicker,
  formatRangeLabel,
  type DateRangeValue
} from "../../../shared/DateRangePicker";
import { FacetFilterButton, FacetFilterChips, type FacetDef } from "../../../shared/FacetFilter";
import { Pager } from "../../../shared/Pager";
import { RefreshButton } from "../../../shared/RefreshButton";
import { SelectMenu } from "../../../shared/SelectMenu";
import { SortHeader, type SortDirection } from "../../../shared/SortHeader";
import { formatManagedDate } from "../../../shared/utils";
import type { LogEvent } from "../types";
import { ControlSectionHead } from "../ControlSectionHead";
import { signInsHref } from "./dashboard/SignInsSection";

// Overview › Logs — the activity archive. Everything the server has recorded,
// searchable and filterable, with a date toolbar, sortable columns, a row that
// opens to show the whole record, and an export of exactly what is on screen.
// An address or a person in a row is a door into the Sign-ins dive for it.

type LogFilterKey = "event" | "user" | "ip";
type LogSort = "time" | "user" | "event" | "ip";

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

// A private or loopback address has no Sign-ins story of its own worth diving
// for — it is the house.
function isDiveableIp(ip: string | null): ip is string {
  return Boolean(ip) && !/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fe80:)/.test(ip!);
}

export function LogsSection() {
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [error, setError] = useState("");
  const [logSearchInput, setLogSearchInput] = useState("");
  const [logSearch, setLogSearch] = useState("");
  const [filters, setFilters] = useState<Record<LogFilterKey, string[]>>(EMPTY_LOG_FILTERS);
  const [facets, setFacets] = useState<Partial<Record<LogFilterKey, string[]>>>({});
  const [range, setRange] = useState<DateRangeValue>(ALL_TIME);
  const [sort, setSort] = useState<LogSort>("time");
  const [dir, setDir] = useState<SortDirection>("desc");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [logPage, setLogPage] = useState(1);
  const [logPageSize, setLogPageSize] = useState(10);
  const [logTotal, setLogTotal] = useState(0);
  const [logTotalPages, setLogTotalPages] = useState(1);
  const [retentionDays, setRetentionDays] = useState(365);
  const [logCleanupStatus, setLogCleanupStatus] = useState("");
  const [pendingCleanup, setPendingCleanup] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // One query string for the page and the export, built the same way, so the
  // CSV is exactly the rows on screen — every filter, the window, the sort.
  const buildQuery = useCallback(() => {
    const query = new URLSearchParams({ sort, dir });
    if (logSearch) query.set("q", logSearch);
    (Object.keys(filters) as LogFilterKey[]).forEach((key) => {
      filters[key].forEach((value) => query.append(key, value));
    });
    if (range.from) query.set("from", range.from);
    if (range.to) query.set("to", range.to);
    return query;
  }, [sort, dir, logSearch, filters, range.from, range.to]);

  const loadLogs = useCallback(async () => {
    const query = buildQuery();
    query.set("page", String(logPage));
    query.set("pageSize", String(logPageSize));
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
  }, [buildQuery, logPage, logPageSize]);

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

  const changeRange = (next: DateRangeValue) => {
    setLogCleanupStatus("");
    setLogPage(1);
    setRange(next);
  };

  const sortBy = (nextSort: LogSort, nextDir: SortDirection) => {
    setSort(nextSort);
    setDir(nextDir);
    setLogPage(1);
  };

  // A plain navigation rather than a fetch: the browser handles the download
  // and the admin cookie rides along, so there is nothing to buffer in memory.
  const exportCsv = () => {
    window.location.assign(`/api/logs/export?${buildQuery()}`);
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
    <div className="compact-tables">
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

      {/* The window first — the same toolbar the dashboard tabs use, with "All"
          added because this is the archive, not a chart. */}
      <div className="status-range-row log-range-row">
        <DateRangePicker value={range} onChange={changeRange} label="Logs time range" allowAll />
        <span className="status-range-label">{formatRangeLabel(range)}</span>
      </div>

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
            onClick={exportCsv}
            disabled={logTotal === 0}
            aria-label="Export these entries as CSV"
            title={logTotal === 0 ? "Nothing to export" : `Export ${logTotal.toLocaleString()} entries as CSV`}
          >
            <Download size={18} aria-hidden="true" />
          </Button>
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
                  <th className="col-expand" aria-label="Details" />
                  <SortHeader column="time" label="Time" sort={sort} dir={dir} onChange={sortBy} initial="desc" />
                  <SortHeader column="event" label="Event" sort={sort} dir={dir} onChange={sortBy} />
                  <th>Detail</th>
                  <SortHeader column="user" label="User" sort={sort} dir={dir} onChange={sortBy} />
                  <SortHeader column="ip" label="IP" sort={sort} dir={dir} onChange={sortBy} />
                </tr>
              </thead>
              <tbody>
                {logs.map((entry) => {
                  const open = expanded === entry.id;
                  return (
                    <Fragment key={entry.id}>
                      <tr className={open ? "is-expanded" : undefined}>
                        <td className="col-expand">
                          <Button
                            variant="icon"
                            aria-label={open ? "Hide details" : "Show details"}
                            aria-expanded={open}
                            onClick={() => setExpanded(open ? null : entry.id)}
                          >
                            {open ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
                          </Button>
                        </td>
                        <td className="datagrid-muted">{formatManagedDate(entry.createdAt)}</td>
                        <td><LogEventCell event={entry.event} /></td>
                        <td className="log-detail-cell">{entry.detail}</td>
                        <td className="datagrid-muted">
                          {entry.actorId ? (
                            <a
                              href={signInsHref({ user: entry.actorId })}
                              className="log-dive-link"
                              title="This person's sign-ins"
                              onClick={(event) => {
                                event.preventDefault();
                                navigate(signInsHref({ user: entry.actorId! }));
                              }}
                            >
                              {entry.actorName ?? "System"}
                            </a>
                          ) : (
                            entry.actorName ?? "System"
                          )}
                        </td>
                        <td className="datagrid-muted">
                          {isDiveableIp(entry.ipAddress) ? (
                            <a
                              href={signInsHref({ ip: entry.ipAddress })}
                              className="log-dive-link"
                              title="Sign-ins from this address"
                              onClick={(event) => {
                                event.preventDefault();
                                navigate(signInsHref({ ip: entry.ipAddress! }));
                              }}
                            >
                              {entry.ipAddress}
                            </a>
                          ) : (
                            entry.ipAddress ?? "—"
                          )}
                        </td>
                      </tr>
                      {open && (
                        <tr className="login-detail-row">
                          <td colSpan={6}>
                            {/* Same grid the Logins table opens its rows into — one
                                idiom for "the whole record" across the panel. */}
                            <dl className="login-detail-grid">
                              <div>
                                <dt>Event</dt>
                                <dd><code>{entry.event}</code></dd>
                              </div>
                              <div>
                                <dt>User</dt>
                                <dd>{entry.actorName ?? "System"}</dd>
                              </div>
                              <div>
                                <dt>IP address</dt>
                                <dd>{entry.ipAddress ?? "Not recorded"}</dd>
                              </div>
                              <div>
                                <dt>When</dt>
                                <dd>{formatManagedDate(entry.createdAt)} · <code>{entry.createdAt}</code></dd>
                              </div>
                              <div className="login-detail-wide">
                                <dt>Detail</dt>
                                <dd>{entry.detail || "—"}</dd>
                              </div>
                            </dl>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* Count on the left, page controls on the right — the same row the
              Duplicate photos list ends with. */}
          <div className="log-pager-row">
            <span className="datagrid-muted">
              Showing {(logPage - 1) * logPageSize + 1}–{Math.min(logPage * logPageSize, logTotal)} of {logTotal.toLocaleString()}
            </span>
            <Pager page={logPage} totalPages={logTotalPages} onChange={setLogPage} label="Log pages" />
          </div>
        </>
      ) : (
        <p className="management-empty">
          {range.preset === "all" && !logSearch && Object.values(filters).every((list) => list.length === 0)
            ? "No log entries yet."
            : "No log entries match — widen the window or clear a filter."}
        </p>
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
    </div>
  );
}
