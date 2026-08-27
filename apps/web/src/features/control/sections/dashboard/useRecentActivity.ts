import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../../api";
import type { LogEvent } from "../../types";

// Small fetch hook for the Dashboard's curated recent-activity tables (Logins,
// Content activity) — same /api/logs endpoint LogsSection uses, but with a fixed
// event set and no facet UI, since these views are pre-scoped by design.
// `options` adds the Logins view's extras: a time window (so the table shows the
// same range as the chart above it), a page number, and column sorting.
export type ActivitySort = "time" | "user" | "event" | "ip";

export function useRecentActivity(
  events: string[],
  pageSize = 10,
  options: { from?: string; to?: string; page?: number; sort?: ActivitySort; dir?: "asc" | "desc" } = {}
) {
  const { t } = useTranslation(["common", "controlDash"]);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState("");
  const eventsKey = events.join(",");
  const { from = "", to = "", page = 1, sort = "time", dir = "desc" } = options;

  const load = useCallback(async () => {
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize), sort, dir });
    events.forEach((event) => query.append("event", event));
    if (from) query.set("from", from);
    if (to) query.set("to", to);
    const payload = await api<{ logs: LogEvent[]; total: number; totalPages: number }>(`/api/logs?${query}`);
    setLogs(payload.logs);
    setTotal(payload.total);
    setTotalPages(payload.totalPages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventsKey, pageSize, from, to, page, sort, dir]);

  useEffect(() => {
    setError("");
    load().catch((err) => setError(err instanceof Error ? err.message : t("controlDash:activity.loadFailed")));
  }, [load]);

  return { logs, total, totalPages, error, reload: load };
}
