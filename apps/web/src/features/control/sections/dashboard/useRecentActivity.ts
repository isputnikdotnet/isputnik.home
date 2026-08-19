import { useCallback, useEffect, useState } from "react";
import { api } from "../../../../api";
import type { LogEvent } from "../../types";

// Small fetch hook for the Dashboard's curated recent-activity tables (Logins,
// Content activity) — same /api/logs endpoint LogsSection uses, but with a fixed
// event set and no facet UI, since these views are pre-scoped by design.
export function useRecentActivity(events: string[], pageSize = 10) {
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const eventsKey = events.join(",");

  const load = useCallback(async () => {
    const query = new URLSearchParams({ page: "1", pageSize: String(pageSize) });
    events.forEach((event) => query.append("event", event));
    const payload = await api<{ logs: LogEvent[]; total: number }>(`/api/logs?${query}`);
    setLogs(payload.logs);
    setTotal(payload.total);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventsKey, pageSize]);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : "Unable to load activity"));
  }, [load]);

  return { logs, total, error, reload: load };
}
