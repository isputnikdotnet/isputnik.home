import { Fingerprint, KeyRound, Link2 } from "lucide-react";
import { StatusMetric } from "../StatusMetric";
import { formatManagedDate } from "../../../../shared/utils";
import type { DashboardSummary } from "../../types";
import { LOGIN_EVENTS, loginMethodLabel, loginResultLabel } from "./activityEvents";
import { useRecentActivity } from "./useRecentActivity";

export function LoginsView({ summary }: { summary: DashboardSummary }) {
  const { logs, error } = useRecentActivity(LOGIN_EVENTS, 10);
  const { password, passkey, deviceLink } = summary.loginMethods;
  const total = password + passkey + deviceLink;
  const pct = (n: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : "—");

  return (
    <div className="status-stack">
      <section className="status-block">
        <div className="status-grid">
          <StatusMetric icon={KeyRound} label="Password" value={`${password} (${pct(password)})`} />
          <StatusMetric icon={Fingerprint} label="Passkey" value={`${passkey} (${pct(passkey)})`} />
          <StatusMetric icon={Link2} label="Device link" value={`${deviceLink} (${pct(deviceLink)})`} />
        </div>

        <div className="status-subsection">
          <div className="status-table-title">
            <h3>Recent logins</h3>
          </div>
          {error && <p className="status-empty">{error}</p>}
          {logs.length > 0 ? (
            <div className="datagrid-wrap">
              <table className="datagrid">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Method</th>
                    <th>Result</th>
                    <th>IP address</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((entry) => (
                    <tr key={entry.id}>
                      <td>{entry.actorName ?? "Unknown"}</td>
                      <td className="datagrid-muted">{loginMethodLabel(entry.event)}</td>
                      <td>
                        <span className={`status-badge ${loginResultLabel(entry.event) === "Failed" ? "failed" : "completed"}`}>
                          {loginResultLabel(entry.event)}
                        </span>
                      </td>
                      <td className="datagrid-muted">{entry.ipAddress ?? "—"}</td>
                      <td className="datagrid-muted">{formatManagedDate(entry.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="status-empty">No login activity yet.</p>
          )}
        </div>
      </section>
    </div>
  );
}
