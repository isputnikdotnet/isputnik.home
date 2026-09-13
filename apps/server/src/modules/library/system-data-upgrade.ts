// The 4.6 storage conversion — docs/system-data-plan.md, "Upgrading an existing
// install". Runs at startup before anything reads a folder (index.ts calls it
// before the backups plugin, whose rescue reads backupDir()).
//
// It moves nothing. It writes the new settings from what was in effect under the
// old rules, so every folder resolves to exactly where it did before:
//
//   - system data: the parent of the thumbnail folder when that folder is called
//     `thumbnails` (every Docker install: /config/thumbnails), else the folder next
//     to the database;
//   - thumbnails, backups: a setting of their own when they were somewhere other
//     than `<system data>/thumbnails|backups` and no environment variable still says so;
//   - the Recycle Bin, thumbnails and backups rooms of App storage: their App
//     storage folders written as those settings, and the rooms dropped.
//
// The old rules needed one thing the new image no longer has: the Dockerfile set
// THUMBNAIL_PATH, BACKUP_PATH and METADATA_PATH to /config/thumbnails, /config/backups
// and /config/metadata until 4.6. On the image's layout (the database at
// /config/db/isputnik.sqlite) those are taken as what the variables said.
//
// A fresh install (no library, nothing configured) is left alone: its admin
// chooses system data. Once system data is set, this does nothing at all.
import path from "node:path";
import { config } from "../../config.js";
import { db, logActivity } from "../../db.js";
import { FORMER_ROOM_FOLDERS, APP_STORAGE_SETTINGS_KEY } from "../../core/app-storage.js";
import {
  BACKUP_PATH_SETTINGS_KEY,
  getSystemDataPath,
  saveSystemDataPath,
  suggestedSystemDataPath,
  SYSTEM_DATA_FOLDERS
} from "../../core/system-data.js";
import { thumbnailPathSettingKey } from "./shared/thumbnail.js";
import { pathIsInside } from "./shared/storage-roots.js";
import type { AppSettingRow, LibraryRow, StorageRootRow } from "../../db/rows.js";

const TRASH_ROOT_KEY = "trash_root_path";

export interface StorageConversion {
  systemData: string;
  thumbnails: string | null;
  backups: string | null;
  trash: string | null;
  droppedRooms: string[];
}

function readSetting(key: string): string | null {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as Pick<AppSettingRow, "value"> | undefined;
  const value = row?.value?.trim();
  return value ? value : null;
}

function writeSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     VALUES (?, ?, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value);
}

const samePath = (a: string, b: string): boolean => {
  const norm = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
};

/** The old image's value for THUMBNAIL_PATH, BACKUP_PATH or METADATA_PATH, on the
 *  image's layout only. */
function formerImageDefault(name: string): string | null {
  const imageDatabase = path.posix.join("/config", "db", "isputnik.sqlite");
  if (process.platform === "win32" || path.resolve(config.dbPath) !== imageDatabase) return null;
  return path.posix.join("/config", name);
}

/** A folder fit to be system data without asking: it holds no library of the
 *  household's and is no container, nor holds one. A thumbnail folder's parent
 *  can be a whole media share, which must not become system data by accident. */
function fitForSystemData(folder: string): boolean {
  const resolved = path.resolve(folder);
  const libraries = db.prepare("SELECT source_path, role FROM libraries").all() as Pick<LibraryRow, "source_path" | "role">[];
  if (libraries.some((library) => !library.role && (pathIsInside(path.resolve(library.source_path), resolved) || pathIsInside(resolved, path.resolve(library.source_path))))) return false;
  const roots = db.prepare("SELECT path FROM storage_roots").all() as Pick<StorageRootRow, "path">[];
  return !roots.some((root) => pathIsInside(path.resolve(root.path), resolved));
}

export function convertStorageSettings(): StorageConversion | null {
  if (getSystemDataPath()) return null;

  let appStorage: { path?: unknown; rooms?: Record<string, unknown> } = {};
  const rawAppStorage = readSetting(APP_STORAGE_SETTINGS_KEY);
  if (rawAppStorage) {
    try { appStorage = JSON.parse(rawAppStorage) as typeof appStorage; } catch { appStorage = {}; }
  }
  const appPath = typeof appStorage.path === "string" && appStorage.path.trim() ? appStorage.path : null;
  const rooms = appStorage.rooms && typeof appStorage.rooms === "object" ? appStorage.rooms : {};
  const inApp = (room: keyof typeof FORMER_ROOM_FOLDERS) => (appPath ? path.join(appPath, FORMER_ROOM_FOLDERS[room]) : null);

  // ── What was in effect under the old rules ──
  const thumbnailSetting = readSetting(thumbnailPathSettingKey);
  const thumbnailOwn = thumbnailSetting || config.thumbnailPath || formerImageDefault(SYSTEM_DATA_FOLDERS.thumbnails);
  let thumbnailsBefore: string | null;
  if (rooms.thumbnails === "app") thumbnailsBefore = inApp("thumbnails") ?? thumbnailOwn;
  else if (rooms.thumbnails === "own") thumbnailsBefore = thumbnailOwn;
  else thumbnailsBefore = thumbnailOwn ?? inApp("thumbnails");

  const backupsEnv = process.env.BACKUP_PATH ? config.backupPath : null;
  const backupsBefore = rooms.backups === "app" && appPath
    ? inApp("backups")!
    : backupsEnv ?? formerImageDefault(SYSTEM_DATA_FOLDERS.backups) ?? config.backupPath;

  const trashBefore = rooms.trash === "app" && appPath ? inApp("trash") : null;
  const droppedRooms = (["trash", "thumbnails", "backups"] as const).filter((room) => room in rooms);

  const libraries = (db.prepare("SELECT COUNT(*) AS n FROM libraries").get() as { n: number }).n;
  const configured = Boolean(thumbnailSetting || config.thumbnailPath || appPath || droppedRooms.length > 0);
  if (libraries === 0 && !configured) return null;

  // ── The new settings that keep every folder where it was ──
  const parentOfThumbnails = thumbnailsBefore && path.basename(thumbnailsBefore) === SYSTEM_DATA_FOLDERS.thumbnails
    ? path.dirname(path.resolve(thumbnailsBefore))
    : null;
  const systemData = parentOfThumbnails && fitForSystemData(parentOfThumbnails) ? parentOfThumbnails : suggestedSystemDataPath();

  let thumbnails: string | null = null;
  if (thumbnailsBefore
    && !samePath(thumbnailsBefore, path.join(systemData, SYSTEM_DATA_FOLDERS.thumbnails))
    && !(config.thumbnailPath && samePath(thumbnailsBefore, config.thumbnailPath) && !thumbnailSetting)) {
    thumbnails = path.resolve(thumbnailsBefore);
  }

  let backups: string | null = null;
  if (!samePath(backupsBefore, path.join(systemData, SYSTEM_DATA_FOLDERS.backups))
    && !(backupsEnv && samePath(backupsBefore, backupsEnv))) {
    backups = path.resolve(backupsBefore);
  }

  const convert = db.transaction(() => {
    saveSystemDataPath(systemData, null);
    if (thumbnails && !(thumbnailSetting && samePath(thumbnailSetting, thumbnails))) writeSetting(thumbnailPathSettingKey, thumbnails);
    // A setting that only repeats the new default is dropped, so the thumbnails
    // follow system data from now on — unless THUMBNAIL_PATH would then take over.
    if (!thumbnails && thumbnailSetting && samePath(thumbnailSetting, path.join(systemData, SYSTEM_DATA_FOLDERS.thumbnails))
      && (!config.thumbnailPath || samePath(config.thumbnailPath, thumbnailSetting))) {
      db.prepare("DELETE FROM app_settings WHERE key = ?").run(thumbnailPathSettingKey);
    }
    if (backups) writeSetting(BACKUP_PATH_SETTINGS_KEY, backups);
    if (trashBefore) writeSetting(TRASH_ROOT_KEY, trashBefore);
    if (droppedRooms.length > 0) {
      const kept = { ...rooms };
      for (const room of droppedRooms) delete kept[room];
      writeSetting(APP_STORAGE_SETTINGS_KEY, JSON.stringify({ path: appPath, rooms: kept }));
    }
  });
  convert();

  const result: StorageConversion = { systemData, thumbnails, backups, trash: trashBefore, droppedRooms };
  logActivity({
    event: "config.updated",
    actorUserId: null,
    targetType: "setting",
    targetId: "system_data",
    detail: [
      `Storage settings converted for 4.6 without moving any file. System data: ${systemData}.`,
      thumbnails ? `Thumbnails keep their folder: ${thumbnails}.` : "",
      backups ? `Backups keep their folder: ${backups}.` : "",
      trashBefore ? `The Recycle Bin keeps its folder: ${trashBefore}.` : "",
      droppedRooms.length > 0 ? `App storage no longer holds: ${droppedRooms.join(", ")}.` : ""
    ].filter(Boolean).join(" ")
  });
  return result;
}
