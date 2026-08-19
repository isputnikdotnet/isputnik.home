import { useEffect, useState } from "react";
import { BookOpen, Headphones } from "lucide-react";
import { api } from "../../../../api";
import { MessageBox } from "../../../../shared/MessageBox";
import { formatManagedDate } from "../../../../shared/utils";
import type { DashboardInProgressEntry } from "../../types";

export function PlaybackView() {
  const [entries, setEntries] = useState<DashboardInProgressEntry[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ inProgress: DashboardInProgressEntry[] }>("/api/dashboard/in-progress")
      .then((payload) => setEntries(payload.inProgress))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load playback and reading activity"));
  }, []);

  return (
    <div className="status-stack">
      <MessageBox tone="info" title="Current position only">
        This shows what's in progress right now, not a history of past sessions — audiobook and ebook
        progress is overwritten in place as you read or listen, so there is no per-session timeline to chart.
      </MessageBox>

      <section className="status-block">
        <div className="status-table-title">
          <h3>Currently in progress</h3>
        </div>
        {error && <p className="status-empty">{error}</p>}
        {entries.length > 0 ? (
          <div className="datagrid-wrap">
            <table className="datagrid">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Item</th>
                  <th>Type</th>
                  <th className="col-num">Progress</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, index) => (
                  <tr key={`${entry.kind}-${entry.title}-${index}`}>
                    <td>{entry.userName}</td>
                    <td>{entry.title}</td>
                    <td className="datagrid-muted">
                      <span className="log-event-cell">
                        {entry.kind === "audiobook" ? <Headphones size={14} aria-hidden="true" /> : <BookOpen size={14} aria-hidden="true" />}
                        {entry.kind === "audiobook" ? "Audiobook" : "Ebook"}
                      </span>
                    </td>
                    <td className="col-num datagrid-muted">
                      {entry.percentComplete != null ? `${Math.round(entry.percentComplete * 100)}%` : "—"}
                    </td>
                    <td className="datagrid-muted">{formatManagedDate(entry.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="status-empty">Nobody has an audiobook or ebook in progress right now.</p>
        )}
      </section>
    </div>
  );
}
