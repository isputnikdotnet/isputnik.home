import { useEffect, useState } from "react";
import {
  Archive,
  ChevronRight,
  Clock3,
  Database,
  HardDrive,
  MemoryStick,
  ScrollText,
  Smartphone,
  Ticket,
  UsersRound,
  type LucideIcon
} from "lucide-react";
import { api } from "../../../../api";
import { controlHref, navigate, type ControlSection } from "../../../../router";
import { Button } from "../../../../shared/Button";
import { KpiCard, type KpiTone } from "../../../../shared/KpiCard";
import { formatBytes, formatManagedDate, formatUptime, relativeTime } from "../../../../shared/utils";
import type { DbInfo, SystemStatus } from "../../types";

// Overview › Dashboard › System — is the server well? Four cards answer that with
// things no other page shows (uptime and version, memory, free disk, the database
// on disk), and a short table under them holds the counts that do have pages of
// their own — users, devices, invites, logs, backups — each with a door to it,
// so this tab is a glance and a jump-off, not a second copy of those pages.

// Free disk is the one number here that can ruin an evening, so it carries the
// only graded tone: fine until a fifth is left, amber below that, red below a
// tenth — the point where the next scan or upload is the one that fails.
function diskTone(free: number, total: number): KpiTone {
  if (total <= 0) return "info";
  const share = free / total;
  if (share < 0.1) return "danger";
  if (share < 0.2) return "warning";
  return "success";
}

interface Pointer {
  icon: LucideIcon;
  label: string;
  value: string;
  note: string;
  section: ControlSection;
}

export function SystemView({ status, dbInfo }: { status: SystemStatus; dbInfo: DbInfo | null }) {
  const [lastBackup, setLastBackup] = useState<{ createdAt: string; kind: string } | null | undefined>(undefined);

  // The newest backup comes from the Backup page's own listing — one fetch for
  // one date, but it's the one date an admin most wants to see next to "is the
  // server well". undefined = still asking, null = there isn't one.
  useEffect(() => {
    api<{ backups: { createdAt: string; kind: string }[] }>("/api/backups")
      .then((payload) => setLastBackup(payload.backups[0] ?? null))
      .catch(() => setLastBackup(null));
  }, []);

  const disk = status.disk;
  const freeShare = disk && disk.totalBytes > 0 ? Math.round((disk.freeBytes / disk.totalBytes) * 100) : null;

  const pointers: Pointer[] = [
    {
      icon: UsersRound,
      label: "Members",
      value: status.users.toLocaleString(),
      note: "Accounts that can sign in",
      section: "users"
    },
    {
      icon: Smartphone,
      label: "Signed-in devices",
      value: status.activeSessions.toLocaleString(),
      note: "Live sessions, displays included",
      section: "signins"
    },
    {
      icon: Ticket,
      label: "Open invite links",
      value: status.activeInvites.toLocaleString(),
      note: "Unused and not yet expired",
      section: "invites"
    },
    {
      icon: ScrollText,
      label: "Log entries",
      value: status.logEntries.toLocaleString(),
      note: "Retention is set on the Logs page",
      section: "logs"
    },
    {
      icon: Archive,
      label: "Last backup",
      value: lastBackup === undefined ? "…" : lastBackup ? relativeTime(lastBackup.createdAt) : "None yet",
      note:
        lastBackup === undefined
          ? "Checking"
          : lastBackup
            ? `${lastBackup.kind === "full" ? "Full backup" : "Database only"} · ${formatManagedDate(lastBackup.createdAt)}`
            : "Take or schedule one under Maintenance",
      section: "backup"
    }
  ];

  return (
    <div className="status-stack">
      <section className="status-block">
        <div className="kpi-cards">
          <KpiCard
            icon={Clock3}
            tone="info"
            label="Uptime"
            value={formatUptime(status.uptimeSeconds)}
            context={`Version ${status.version} · Node ${status.runtime.replace(/^v/, "")}`}
          />
          <KpiCard
            icon={MemoryStick}
            tone="info"
            label="Memory"
            value={formatBytes(status.memory.rssBytes)}
            context={`${formatBytes(status.memory.heapUsedBytes)} of ${formatBytes(status.memory.heapTotalBytes)} heap in use`}
          />
          <KpiCard
            icon={HardDrive}
            tone={disk ? diskTone(disk.freeBytes, disk.totalBytes) : "info"}
            label="Free space"
            value={disk ? formatBytes(disk.freeBytes) : "Unknown"}
            context={
              disk && freeShare !== null
                ? `${freeShare}% of ${formatBytes(disk.totalBytes)} on the data disk`
                : "The platform couldn't measure the data disk"
            }
          />
          <KpiCard
            icon={Database}
            tone="info"
            label="Database"
            value={formatBytes(status.databaseBytes)}
            context={
              dbInfo
                ? `${formatBytes(dbInfo.sizeBytes)} file · ${formatBytes(dbInfo.walSizeBytes)} WAL · changed ${relativeTime(dbInfo.lastModified ?? status.generatedAt)}`
                : "On disk, with its WAL and SHM companions"
            }
          />
        </div>

        <div className="status-subsection">
          <div className="status-table-title">
            <h3>Where things stand</h3>
            <span>Counts with pages of their own · checked {formatManagedDate(status.generatedAt)}</span>
          </div>
          <div className="datagrid-wrap">
            <table className="datagrid locations-table">
              <tbody>
                {pointers.map((pointer) => {
                  const Icon = pointer.icon;
                  return (
                    <tr key={pointer.label} onClick={() => navigate(controlHref(pointer.section))} className="system-pointer-row">
                      <td>
                        <span className="location-cell">
                          <Icon size={17} aria-hidden="true" className="signins-device-icon" />
                          <span className="datagrid-primary">
                            <strong>{pointer.label}</strong>
                            <small>{pointer.note}</small>
                          </span>
                        </span>
                      </td>
                      <td className="col-num system-pointer-value">{pointer.value}</td>
                      <td className="locations-row-action">
                        <Button
                          variant="icon"
                          aria-label={`Open ${pointer.label}`}
                          title={`Open ${pointer.label}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            navigate(controlHref(pointer.section));
                          }}
                        >
                          <ChevronRight size={16} aria-hidden="true" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {dbInfo && (
          <div className="status-subsection">
            <div className="status-table-title">
              <h3>Database file</h3>
              <span>
                Backups are taken and scheduled under{" "}
                <a href={controlHref("backup")}>Maintenance › Backup</a>
              </span>
            </div>
            <p className="muted status-db-path"><code>{dbInfo.path}</code></p>
          </div>
        )}
      </section>
    </div>
  );
}
