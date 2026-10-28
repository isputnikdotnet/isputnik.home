// Overview › Dashboard: what /api/status does not say and the page needs to tell
// an admin whether to look closer — which disks this server's files sit on, how
// Home is reached, and how many sign-ins and tasks failed in the last day
// (docs/dashboard-and-backups-plan.md). The containers' side comes from
// modules/apps (status and error counts), read through the gateway.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { config } from "../../config.js";
import { getAppStoragePath } from "../../core/app-storage.js";
import { getSystemDataPath, resolveBackupPath, systemDataFolder } from "../../core/system-data.js";
import { getTrashRootSetting } from "../library/shared/trash-settings.js";

/** What a place on a disk holds. A library carries its name. */
export type DiskHolding =
  | { kind: "database" | "thumbnails" | "backups" | "appFiles" | "trash" | "systemData"; path: string }
  | { kind: "library"; name: string; libraryType: string; path: string };

export interface DashboardDisk {
  /** The top folder of the mount as this server sees it (`/media`), or the
   *  nearest folder above the first holding when that cannot be told. */
  mount: string;
  freeBytes: number;
  totalBytes: number;
  holds: DiskHolding[];
}

/** The device and the folder a path is on: the path itself, or the nearest
 *  folder above it that exists (a folder about to be made lives there). */
function existingAncestor(candidate: string): { dir: string; dev: number } | null {
  let current = path.resolve(candidate);
  for (;;) {
    try {
      return { dir: current, dev: fs.statSync(current).dev };
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/** Where a mount starts: climb while the parent is on the same device. */
function mountOf(dir: string, dev: number): string {
  let current = dir;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    try {
      if (fs.statSync(parent).dev !== dev) return current;
    } catch {
      return current;
    }
    current = parent;
  }
}

/** Every place Home keeps files. Video libraries live on the engine, not here:
 *  their folder is the engine's, and measuring it here would report Home's disk. */
export function homeHoldings(): DiskHolding[] {
  const holds: DiskHolding[] = [{ kind: "database", path: path.dirname(path.resolve(config.dbPath)) }];
  const systemData = getSystemDataPath();
  if (systemData) holds.push({ kind: "systemData", path: systemData });
  const thumbnails = config.thumbnailPath || systemDataFolder("thumbnails");
  if (thumbnails) holds.push({ kind: "thumbnails", path: thumbnails });
  holds.push({ kind: "backups", path: resolveBackupPath().path });
  const appFiles = getAppStoragePath();
  if (appFiles) holds.push({ kind: "appFiles", path: appFiles });
  const trash = getTrashRootSetting();
  if (trash) holds.push({ kind: "trash", path: trash });
  const libraries = db.prepare(
    "SELECT name, type, source_path FROM libraries WHERE type != 'video' ORDER BY name COLLATE NOCASE"
  ).all() as { name: string; type: string; source_path: string }[];
  for (const library of libraries) {
    holds.push({ kind: "library", name: library.name, libraryType: library.type, path: library.source_path });
  }
  return holds;
}

/** The holdings grouped by the disk they are on, biggest disk first. A place
 *  that cannot be measured (no folder above it exists) is left out. */
export function groupByDisk(holds: DiskHolding[]): DashboardDisk[] {
  const byDevice = new Map<number, DashboardDisk>();
  for (const hold of holds) {
    const where = existingAncestor(hold.path);
    if (!where) continue;
    let disk = byDevice.get(where.dev);
    if (!disk) {
      let stats: fs.StatsFs;
      try {
        stats = fs.statfsSync(where.dir);
      } catch {
        continue;
      }
      disk = {
        mount: mountOf(where.dir, where.dev),
        freeBytes: Number(stats.bavail) * Number(stats.bsize),
        totalBytes: Number(stats.blocks) * Number(stats.bsize),
        holds: []
      };
      byDevice.set(where.dev, disk);
    }
    disk.holds.push(hold);
  }
  return [...byDevice.values()].sort((a, b) => b.totalBytes - a.totalBytes);
}

/** This machine's own addresses (a container on br0 has the LAN one). */
function homeAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry): entry is os.NetworkInterfaceInfo => Boolean(entry && !entry.internal && entry.family === "IPv4"))
    .map((entry) => entry.address);
}

const DAY_AGO_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')";

export async function dashboardOverviewPlugin(app: FastifyInstance) {
  app.get("/api/dashboard/overview", { preHandler: app.requireAdmin }, async () => {
    const failedSignIns = db.prepare(
      `SELECT COUNT(*) AS n FROM activity_logs WHERE event = 'auth.login_failed' AND created_at >= ${DAY_AGO_SQL}`
    ).get() as { n: number };
    const failedTasks = db.prepare(
      `SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed' AND failed_at >= ${DAY_AGO_SQL}`
    ).get() as { n: number };
    return {
      home: { addresses: homeAddresses(), port: config.port, publicUrl: config.appUrl },
      disks: groupByDisk(homeHoldings()),
      failedSignIns24h: failedSignIns.n,
      failedTasks24h: failedTasks.n
    };
  });
}
