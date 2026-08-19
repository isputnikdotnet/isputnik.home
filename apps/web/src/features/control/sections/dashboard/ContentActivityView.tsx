import { formatManagedDate } from "../../../../shared/utils";
import { CONTENT_EVENTS } from "./activityEvents";
import { useRecentActivity } from "./useRecentActivity";

// Same event-category/action split LogsSection uses for its Event column, so a
// row here reads identically whether you're looking at this page or Logs.
function EventCell({ event }: { event: string }) {
  const [category, ...rest] = event.split(".");
  const action = rest.join(" ").replace(/_/g, " ");
  return (
    <span className="log-event-cell">
      <span className={`event-category cat-${category}`}>{category}</span>
      <span className="event-action">{action}</span>
    </span>
  );
}

export function ContentActivityView() {
  const { logs, error } = useRecentActivity(CONTENT_EVENTS, 20);

  return (
    <div className="status-stack">
      <section className="status-block">
        <div className="status-table-title">
          <h3>Recent content activity</h3>
        </div>
        {error && <p className="status-empty">{error}</p>}
        {logs.length > 0 ? (
          <div className="datagrid-wrap">
            <table className="datagrid">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>User</th>
                  <th>Detail</th>
                  <th>IP address</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((entry) => (
                  <tr key={entry.id}>
                    <td><EventCell event={entry.event} /></td>
                    <td className="datagrid-muted">{entry.actorName ?? "System"}</td>
                    <td>{entry.detail}</td>
                    <td className="datagrid-muted">{entry.ipAddress ?? "—"}</td>
                    <td className="datagrid-muted">{formatManagedDate(entry.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="status-empty">No uploads, downloads or deletes yet.</p>
        )}
      </section>
    </div>
  );
}
