// System data — docs/system-data-plan.md, phase 2.
//
// The one folder the app needs in order to run: thumbnails, backups and metadata
// go there unless a folder of their own was chosen. The admin picks it (the
// setup guide and the Storage page suggest the folder next to the database), and
// no library can be created until it is set, because thumbnails would have
// nowhere to go.
//
// The database is not inside the choice: every setting, this one included,
// lives in it, so the running app cannot say where it is. It stays where the
// install put it (DB_PATH).
//
// It sits in core/ because every module reads it: thumbnails, backups, metadata.
// Validating a candidate (outside every library, not a container) is the storage
// route's job in modules/library/system-data.ts.
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { db } from "../db.js";
import { stmt } from "../db/statement-cache.js";
import type { AppSettingRow } from "../db/rows.js";

export const SYSTEM_DATA_SETTINGS_KEY = "system_data";

/** A folder of its own for the backups, chosen on the Storage page. Absent =
 *  BACKUP_PATH, else `<system data>/backups`. */
export const BACKUP_PATH_SETTINGS_KEY = "backup_path";

/** Folder names inside system data: lowercase, and the names Docker installs
 *  have always used under /config, so an upgrade finds its files where they are. */
export const SYSTEM_DATA_FOLDERS = {
  thumbnails: "thumbnails",
  backups: "backups",
  metadata: "metadata"
} as const;

export type SystemDataFolder = keyof typeof SYSTEM_DATA_FOLDERS;

/** The folder next to the database's own: `/config` for `/config/db/isputnik.sqlite`,
 *  `<app>/data` for a bare install. What the picker suggests. */
export function suggestedSystemDataPath(): string {
  return path.dirname(path.dirname(path.resolve(config.dbPath)));
}

export function getSystemDataPath(): string | null {
  // Read on every thumbnail path resolved, so the statement is compiled once.
  const row = stmt("SELECT value FROM app_settings WHERE key = ?").get(SYSTEM_DATA_SETTINGS_KEY) as Pick<AppSettingRow, "value"> | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { path?: unknown };
    return typeof parsed.path === "string" && parsed.path.trim() ? parsed.path : null;
  } catch {
    return null;
  }
}

export function saveSystemDataPath(value: string | null, userId: string | null): void {
  writeSetting(SYSTEM_DATA_SETTINGS_KEY, JSON.stringify({ path: value }), userId);
}

/** `<system data>/<folder>`, or null while system data is not set. */
export function systemDataFolder(folder: SystemDataFolder, root = getSystemDataPath()): string | null {
  return root ? path.join(root, SYSTEM_DATA_FOLDERS[folder]) : null;
}

/** The backups' own folder setting, or null when they follow BACKUP_PATH / system data. */
export function getBackupPathSetting(): string | null {
  const row = stmt("SELECT value FROM app_settings WHERE key = ?").get(BACKUP_PATH_SETTINGS_KEY) as Pick<AppSettingRow, "value"> | undefined;
  const value = row?.value.trim();
  return value ? value : null;
}

export function saveBackupPathSetting(value: string | null, userId: string | null): void {
  if (value) writeSetting(BACKUP_PATH_SETTINGS_KEY, value, userId);
  else db.prepare("DELETE FROM app_settings WHERE key = ?").run(BACKUP_PATH_SETTINGS_KEY);
}

export type BackupPathSource = "setting" | "env" | "system" | "default";

/** Where backups go, and which answer decided it: the folder chosen on the Storage
 *  page, else BACKUP_PATH, else `<system data>/backups`, else `<app>/data/backups`
 *  (a server that has not been given system data still needs somewhere for the
 *  copy it takes before an upgrade). Read at call time, never cached. */
export function resolveBackupPath(): { path: string; source: BackupPathSource } {
  const own = getBackupPathSetting();
  if (own) return { path: own, source: "setting" };
  if (process.env.BACKUP_PATH) return { path: config.backupPath, source: "env" };
  const system = systemDataFolder("backups");
  if (system) return { path: system, source: "system" };
  return { path: config.backupPath, source: "default" };
}

export type MetadataPathSource = "env" | "system";

/** Where book metadata exports go: METADATA_PATH, else `<system data>/metadata`,
 *  else nowhere (exports are skipped until system data is set). */
export function resolveMetadataPath(): { path: string; source: MetadataPathSource } | null {
  if (config.metadataPath) return { path: path.resolve(config.metadataPath), source: "env" };
  const system = systemDataFolder("metadata");
  return system ? { path: system, source: "system" } : null;
}

/** Free and total bytes on the disk that holds `candidate`, or on the nearest
 *  folder above it that exists (a folder about to be created lives there). */
export function diskSpace(candidate: string): { free: number; total: number } | null {
  let current = path.resolve(candidate);
  for (;;) {
    try {
      const stats = fs.statfsSync(current);
      return { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize };
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/** True when two paths sit on the same disk, by device id. Either missing = false. */
export function sameDisk(a: string, b: string): boolean {
  const device = (p: string): number | null => {
    let current = path.resolve(p);
    for (;;) {
      try { return fs.statSync(current).dev; } catch {
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
      }
    }
  };
  const left = device(a);
  const right = device(b);
  return left !== null && left === right;
}

function writeSetting(key: string, value: string, userId: string | null): void {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_by = excluded.updated_by,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(key, value, userId);
}
