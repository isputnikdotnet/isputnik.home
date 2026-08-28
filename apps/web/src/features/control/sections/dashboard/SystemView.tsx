import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
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
import { controlHref, navigate } from "../../../../router";
import { Button } from "../../../../shared/Button";
import { KpiCard, type KpiTone } from "../../../../shared/KpiCard";
import { formatBytes, formatManagedDate, formatUptime, relativeTime } from "../../../../shared/utils";
import { signInsHref } from "./SignInsView";
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
  /** An address, not a section: Devices lands on a view of this same page. */
  href: string;
}

export function SystemView({ status, dbInfo }: { status: SystemStatus; dbInfo: DbInfo | null }) {
  const { t } = useTranslation(["common", "controlDash"]);
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
      label: t("controlDash:system.members"),
      value: status.users.toLocaleString(),
      note: t("controlDash:system.membersNote"),
      href: controlHref("users")
    },
    {
      icon: Smartphone,
      label: t("controlDash:system.devices"),
      value: status.activeSessions.toLocaleString(),
      note: t("controlDash:system.devicesNote"),
      href: signInsHref({})
    },
    {
      icon: Ticket,
      label: t("controlDash:system.invites"),
      value: status.activeInvites.toLocaleString(),
      note: t("controlDash:system.invitesNote"),
      href: controlHref("invites")
    },
    {
      icon: ScrollText,
      label: t("controlDash:system.logEntries"),
      value: status.logEntries.toLocaleString(),
      note: t("controlDash:system.logEntriesNote"),
      href: controlHref("logs")
    },
    {
      icon: Archive,
      label: t("controlDash:system.lastBackup"),
      value: lastBackup === undefined ? "…" : lastBackup ? relativeTime(lastBackup.createdAt) : t("controlDash:system.noneYet"),
      note:
        lastBackup === undefined
          ? t("controlDash:system.checkingNote")
          : lastBackup
            ? `${lastBackup.kind === "full" ? t("controlDash:system.fullBackup") : t("controlDash:system.databaseOnly")} · ${formatManagedDate(lastBackup.createdAt)}`
            : t("controlDash:system.backupHint"),
      href: controlHref("backup")
    }
  ];

  return (
    <div className="status-stack">
      <section className="status-block">
        <div className="kpi-cards">
          <KpiCard
            icon={Clock3}
            tone="info"
            label={t("controlDash:system.uptime")}
            value={formatUptime(status.uptimeSeconds)}
            context={t("controlDash:system.uptimeContext", { version: status.version, node: status.runtime.replace(/^v/, "") })}
          />
          <KpiCard
            icon={MemoryStick}
            tone="info"
            label={t("controlDash:system.memory")}
            value={formatBytes(status.memory.rssBytes)}
            context={t("controlDash:system.memoryContext", { used: formatBytes(status.memory.heapUsedBytes), total: formatBytes(status.memory.heapTotalBytes) })}
          />
          <KpiCard
            icon={HardDrive}
            tone={disk ? diskTone(disk.freeBytes, disk.totalBytes) : "info"}
            label={t("controlDash:system.freeSpace")}
            value={disk ? formatBytes(disk.freeBytes) : t("controlDash:system.unknown")}
            context={
              disk && freeShare !== null
                ? t("controlDash:system.diskContext", { share: freeShare, total: formatBytes(disk.totalBytes) })
                : t("controlDash:system.diskUnmeasured")
            }
          />
          <KpiCard
            icon={Database}
            tone="info"
            label={t("controlDash:system.database")}
            value={formatBytes(status.databaseBytes)}
            context={
              dbInfo
                ? t("controlDash:system.databaseContext", {
                    size: formatBytes(dbInfo.sizeBytes),
                    wal: formatBytes(dbInfo.walSizeBytes),
                    when: relativeTime(dbInfo.lastModified ?? status.generatedAt)
                  })
                : t("controlDash:system.databaseFallback")
            }
          />
        </div>

        <div className="status-subsection">
          <div className="status-table-title">
            <h3>{t("controlDash:system.standTitle")}</h3>
            <span>{t("controlDash:system.standNote", { date: formatManagedDate(status.generatedAt) })}</span>
          </div>
          <div className="datagrid-wrap">
            <table className="datagrid locations-table">
              <tbody>
                {pointers.map((pointer) => {
                  const Icon = pointer.icon;
                  return (
                    <tr key={pointer.label} onClick={() => navigate(pointer.href)} className="system-pointer-row">
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
                          aria-label={t("controlDash:system.open", { label: pointer.label })}
                          title={t("controlDash:system.open", { label: pointer.label })}
                          onClick={(event) => {
                            event.stopPropagation();
                            navigate(pointer.href);
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
              <h3>{t("controlDash:system.databaseFile")}</h3>
              <span>
                <Trans i18nKey="system.backupNote" ns="controlDash" components={{ link: <a href={controlHref("backup")} /> }} />
              </span>
            </div>
            <p className="muted status-db-path"><code>{dbInfo.path}</code></p>
          </div>
        )}
      </section>
    </div>
  );
}
