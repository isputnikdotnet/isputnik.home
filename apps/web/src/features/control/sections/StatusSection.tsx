import { useState, useEffect } from "react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { formatManagedDate, formatBytes, formatUptime } from "../../../shared/utils";
import type { SystemStatus } from "../types";

function StatusMetric({ label, value }: { label: string; value: string }) {
  return (
    <article className="status-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

export function StatusSection() {
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState("");

  const loadStatus = async () => {
    const payload = await api<{ status: SystemStatus }>("/api/status");
    setSystemStatus(payload.status);
  };

  useEffect(() => {
    loadStatus().catch((err) => setError(err instanceof Error ? err.message : "Unable to load status"));
  }, []);

  return (
    <>
      <div className="section-head">
        <div>
          <p className="eyebrow">System</p>
          <h1>Status</h1>
        </div>
        <button className="secondary-button compact-button" onClick={() => loadStatus().catch((err) => setError(err instanceof Error ? err.message : "Unable to refresh status"))}>
          Refresh
        </button>
      </div>

      {error && <MessageBox tone="error" title="Status error">{error}</MessageBox>}

      {systemStatus && (
        <>
          <div className="health-line">
            <span className="health-dot" aria-hidden="true"></span>
            <strong>{systemStatus.health}</strong>
            <span>Updated {formatManagedDate(systemStatus.generatedAt)}</span>
          </div>
          <div className="status-grid">
            <StatusMetric label="Users" value={String(systemStatus.users)} />
            <StatusMetric label="Active sessions" value={String(systemStatus.activeSessions)} />
            <StatusMetric label="Active invites" value={String(systemStatus.activeInvites)} />
            <StatusMetric label="Log entries" value={String(systemStatus.logEntries)} />
            <StatusMetric label="Audiobook libraries" value={String(systemStatus.audiobookLibraries)} />
            <StatusMetric label="Audiobook books" value={String(systemStatus.audiobookBooks)} />
            <StatusMetric label="Database size" value={formatBytes(systemStatus.databaseBytes)} />
            <StatusMetric label="Server uptime" value={formatUptime(systemStatus.uptimeSeconds)} />
          </div>
        </>
      )}
    </>
  );
}
