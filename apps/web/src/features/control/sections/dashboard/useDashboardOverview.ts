import { useCallback, useEffect, useState } from "react";
import { api } from "../../../../api";
import type { AppStatus } from "../AppsSection";

// What the Dashboard reads besides /api/status (useSystemStatus): the disks and
// last day's failures (modules/dashboard/overview.ts), how each container stands
// (Apps › Installed's own call), the newest backup, and each running container's
// errors of the last day — read through the gateway from its own events, as
// Apps › Events does — and the disks the video engine's files sit on, which home
// cannot see (they are mounted on the engine). Each is loaded on its own so one
// that fails costs its part of the page, never the rest.

export type DiskHolding =
  | { kind: "database" | "thumbnails" | "backups" | "appFiles" | "trash" | "systemData" | "artwork" | "transcode"; path: string }
  | { kind: "library"; name: string; libraryType?: string; path: string };

/** One folder mapped into a container, as home (modules/dashboard/overview.ts)
 *  or the video engine (its /api/admin/disks) measured it. */
export interface DashboardDisk {
  mount: string;
  /** The device id; mounts of one filesystem share it. Only compared. */
  filesystem: string;
  freeBytes: number;
  totalBytes: number;
  holds: DiskHolding[];
  /** Other mounts of the same filesystem in the same container. */
  sharesWith: string[];
}

/** A disk with whose container measured it: "home", or an app's id. */
export type OwnedDisk = DashboardDisk & { owner: string };

export interface DashboardOverview {
  home: { addresses: string[]; port: number; publicUrl: string };
  disks: DashboardDisk[];
  failedSignIns24h: number;
  failedTasks24h: number;
}

export interface LastBackup {
  createdAt: string;
  kind: string;
  /** Older than STALE_BACKUP_DAYS when it was read — worth a line in the attention list. */
  stale: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_BACKUP_DAYS = 7;

/** Error events a container recorded in the last day; null when it could not be asked. */
async function errorsToday(prefix: string): Promise<number | null> {
  try {
    const page = await api<{ events: { at: string }[] }>(`${prefix}/api/admin/events?level=error&pageSize=100`);
    const since = Date.now() - DAY_MS;
    return page.events.filter((event) => Date.parse(event.at) >= since).length;
  } catch {
    return null;
  }
}

export function useDashboardOverview() {
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [apps, setApps] = useState<AppStatus[] | null>(null);
  /** undefined = still asking, null = there isn't one (or it could not be read). */
  const [lastBackup, setLastBackup] = useState<LastBackup | null | undefined>(undefined);
  const [appErrors, setAppErrors] = useState<Record<string, number | null>>({});
  const [appDisks, setAppDisks] = useState<OwnedDisk[]>([]);

  const load = useCallback(async () => {
    const overviewCall = api<DashboardOverview>("/api/dashboard/overview").then(setOverview).catch(() => setOverview(null));
    const backupCall = api<{ backups: Omit<LastBackup, "stale">[] }>("/api/backups")
      .then((payload) => {
        const newest = payload.backups[0];
        setLastBackup(newest ? { ...newest, stale: Date.now() - Date.parse(newest.createdAt) > STALE_BACKUP_DAYS * DAY_MS } : null);
      })
      // Unreadable is not "none yet": leave it unknown rather than raise a false alarm.
      .catch(() => undefined);
    const appsCall = api<{ apps: AppStatus[] }>("/api/apps/admin/status")
      .then(async (payload) => {
        setApps(payload.apps);
        const running = payload.apps.filter((app) => app.server?.ok);
        const [counts, disks] = await Promise.all([
          Promise.all(running.map(async (app) => [app.id, await errorsToday(app.prefix)] as const)),
          // Only an engine keeps media of its own; an engine too old to answer is left out.
          Promise.all(running.filter((app) => app.kind === "engine").map((app) =>
            api<{ disks: DashboardDisk[] }>(`${app.prefix}/api/admin/disks`)
              .then((payload) => payload.disks.map((disk) => ({ ...disk, owner: app.id })))
              .catch(() => [] as OwnedDisk[])
          ))
        ]);
        setAppErrors(Object.fromEntries(counts));
        setAppDisks(disks.flat());
      })
      .catch(() => setApps([]));
    await Promise.all([overviewCall, backupCall, appsCall]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { overview, apps, lastBackup, appErrors, appDisks, reload: load };
}
