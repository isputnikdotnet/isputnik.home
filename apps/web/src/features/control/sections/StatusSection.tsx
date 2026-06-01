import { useState, useEffect } from "react";
import { Activity, Clock3, Database, HardDrive, RefreshCw, ScrollText, Ticket, UsersRound } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { formatManagedDate, formatBytes, formatUptime } from "../../../shared/utils";
import type { DbInfo, SystemStatus } from "../types";

function StatusMetric({ icon: Icon, label, value, note }: { icon: LucideIcon; label: string; value: string; note?: string }) {
  return (
    <article className="status-metric">
      <span className="status-metric-icon" aria-hidden="true"><Icon size={18} /></span>
      <span className="status-metric-label">{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </article>
  );
}

export function StatusSection() {
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [dbInfo, setDbInfo] = useState<DbInfo | null>(null);
  const [error, setError] = useState("");

  const loadStatus = async () => {
    const payload = await api<{ status: SystemStatus }>("/api/status");
    setSystemStatus(payload.status);
    // Database details are secondary — load them separately so a db-info failure
    // never hides the main status view.
    api<{ db: DbInfo }>("/api/db/info")
      .then((dbPayload) => setDbInfo(dbPayload.db))
      .catch(() => setDbInfo(null));
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
          <RefreshCw size={15} aria-hidden="true" />
          Refresh
        </button>
      </div>

      {error && <MessageBox tone="error" title="Status error">{error}</MessageBox>}

      {systemStatus && (
        <div className="status-stack">
          <section className="status-block">
            <div className="status-block-head">
              <div>
                <p className="eyebrow">Application</p>
                <h2>System</h2>
              </div>
              <div className="health-line">
                <span className="health-dot" aria-hidden="true"></span>
                <strong>{systemStatus.health}</strong>
                <span>Updated {formatManagedDate(systemStatus.generatedAt)}</span>
              </div>
            </div>
            <div className="status-grid">
              <StatusMetric icon={UsersRound} label="Users" value={String(systemStatus.users)} />
              <StatusMetric icon={Activity} label="Active sessions" value={String(systemStatus.activeSessions)} />
              <StatusMetric icon={Ticket} label="Active invites" value={String(systemStatus.activeInvites)} />
              <StatusMetric icon={ScrollText} label="Log entries" value={String(systemStatus.logEntries)} />
              <StatusMetric icon={Database} label="Database size" value={formatBytes(systemStatus.databaseBytes)} />
              <StatusMetric icon={Clock3} label="Server uptime" value={formatUptime(systemStatus.uptimeSeconds)} />
            </div>
          </section>

          {dbInfo && (
            <section className="status-block">
              <div className="status-block-head">
                <div>
                  <p className="eyebrow">Application</p>
                  <h2>Database</h2>
                </div>
              </div>
              <div className="status-grid">
                <StatusMetric icon={Database} label="File" value={dbInfo.filename} />
                <StatusMetric icon={Database} label="Database size" value={formatBytes(dbInfo.sizeBytes)} />
                <StatusMetric icon={Database} label="WAL size" value={formatBytes(dbInfo.walSizeBytes)} />
                <StatusMetric icon={HardDrive} label="Total on disk" value={formatBytes(dbInfo.totalSizeBytes)} />
                <StatusMetric icon={Clock3} label="Last modified" value={dbInfo.lastModified ? formatManagedDate(dbInfo.lastModified) : "—"} />
              </div>
              <p className="muted status-db-path">{dbInfo.path}</p>
              <p className="muted status-db-hint">
                To back up, copy the database file with its <code>-wal</code> and <code>-shm</code> companions while the server is idle, or run <code>sqlite3 isputnik.sqlite .backup backup.sqlite</code> for a safe online backup.
              </p>
            </section>
          )}
        </div>
      )}
    </>
  );
}
