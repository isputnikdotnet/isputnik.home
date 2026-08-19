import { Activity, Clock3, Database, HardDrive, ScrollText, Ticket, UsersRound } from "lucide-react";
import { formatManagedDate, formatManagedDateParts, formatBytes, formatUptime } from "../../../../shared/utils";
import { StatusMetric } from "../StatusMetric";
import type { DbInfo, SystemStatus } from "../../types";

export function SystemView({ status, dbInfo }: { status: SystemStatus; dbInfo: DbInfo | null }) {
  const lastModified = dbInfo?.lastModified ? formatManagedDateParts(dbInfo.lastModified) : null;

  return (
    <div className="status-stack">
      <section className="status-block">
        <div className="status-block-head">
          <div>
            <p className="eyebrow">Application</p>
            <h2>System</h2>
          </div>
          <div className="health-line">
            <span className="health-dot" aria-hidden="true"></span>
            <strong>{status.health}</strong>
            <span>Updated {formatManagedDate(status.generatedAt)}</span>
          </div>
        </div>
        <div className="status-grid">
          <StatusMetric icon={UsersRound} label="Users" value={String(status.users)} />
          <StatusMetric icon={Activity} label="Active sessions" value={String(status.activeSessions)} />
          <StatusMetric icon={Ticket} label="Active invites" value={String(status.activeInvites)} />
          <StatusMetric icon={ScrollText} label="Log entries" value={String(status.logEntries)} />
          <StatusMetric icon={Database} label="Database size" value={formatBytes(status.databaseBytes)} />
          <StatusMetric icon={Clock3} label="Server uptime" value={formatUptime(status.uptimeSeconds)} />
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
            <StatusMetric
              icon={Clock3}
              label="Last modified"
              value={lastModified?.date ?? "—"}
              note={lastModified?.time}
            />
          </div>
          <p className="muted status-db-path">{dbInfo.path}</p>
          <p className="muted status-db-hint">
            To back up, copy the database file with its <code>-wal</code> and <code>-shm</code> companions while the server is idle, or run <code className="status-db-command">sqlite3 isputnik.sqlite .backup backup.sqlite</code> for a safe online backup.
          </p>
        </section>
      )}
    </div>
  );
}
