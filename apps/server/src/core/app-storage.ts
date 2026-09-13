// App storage — docs/system-data-plan.md, phase 3.
//
// One switch for four parts that always go together: the Photo Inbox, the App
// files library, Renders and Map data. Off, none of them exist; on, they live in
// one folder — `app-storage` inside system data, or a custom folder the admin
// picked. What the parts do is the modules' business; this file only says whether
// App storage is on, where it is, and where each part's folder is.
//
// A part can sit outside App storage while it is on: the 4.6 conversion left
// renders in the thumbnail folder and map data in its own folder rather than move
// them at boot, and a Photo Inbox or App files library made before 4.6 keeps its
// folder. The two libraries say where they are through their own source_path; the
// two plain folders are marked in `outside` until someone moves them in.
//
// It sits in core/ because every module reads it: slideshow renders, music, map
// data, upload staging. Validating a folder and switching are the storage
// module's job (modules/library/app-storage-service.ts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "../db.js";
import { stmt } from "../db/statement-cache.js";
import { getSystemDataPath } from "./system-data.js";
import type { AppSettingRow } from "../db/rows.js";

export const APP_STORAGE_SETTINGS_KEY = "app_storage";

/** The folder App storage takes inside system data when the admin chooses that. */
export const APP_STORAGE_SYSTEM_FOLDER = "app-storage";

/** The parts, in the order the Storage page lists them. */
export const APP_ROOMS = ["inbox", "house", "renders", "maps"] as const;
export type AppRoom = (typeof APP_ROOMS)[number];

/** The parts that are plain folders rather than libraries. */
export type AppFolderPart = "renders" | "maps";

/** Folder names inside App storage, fixed and in English like the house
 *  library's folders, so a folder listing reads the same on every install. */
export const APP_ROOM_FOLDERS: Record<AppRoom, string> = {
  inbox: "Photo Inbox",
  house: "App files",
  renders: "Renders",
  maps: "Map data"
};

/** The rooms App storage had until 4.6 and their folder names, for the startup
 *  conversion that turns them into settings of their own (system-data-upgrade.ts). */
export const FORMER_ROOM_FOLDERS = {
  trash: "Recycle Bin",
  thumbnails: "Thumbnails",
  backups: "Backups"
} as const;

export type AppStorageWhere = "system" | "custom";

export interface AppStorageSetting {
  enabled: boolean;
  where: AppStorageWhere;
  /** The custom folder. Kept while "system" is chosen, so switching back offers it again. */
  path: string | null;
  /** Plain-folder parts still in their own place while App storage is on. */
  outside: Partial<Record<AppFolderPart, boolean>>;
}

const OFF: AppStorageSetting = { enabled: false, where: "system", path: null, outside: {} };

/** The stored value, raw: the 4.6 shape, or the rooms shape before it (read by
 *  the conversion in app-storage-upgrade.ts, and as a fallback until it runs). */
export function readAppStorageRaw(): Record<string, unknown> | null {
  const row = stmt("SELECT value FROM app_settings WHERE key = ?").get(APP_STORAGE_SETTINGS_KEY) as Pick<AppSettingRow, "value"> | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function getAppStorageSetting(): AppStorageSetting {
  // Read for every render and map asset resolved, so the statement is compiled once.
  const raw = readAppStorageRaw();
  if (!raw) return { ...OFF, outside: {} };
  const path_ = typeof raw.path === "string" && raw.path.trim() ? raw.path : null;
  if (typeof raw.enabled === "boolean") {
    const outside = raw.outside && typeof raw.outside === "object" ? raw.outside as Record<string, unknown> : {};
    return {
      enabled: raw.enabled,
      where: raw.where === "custom" ? "custom" : "system",
      path: path_,
      outside: { ...(outside.renders === true ? { renders: true } : {}), ...(outside.maps === true ? { maps: true } : {}) }
    };
  }
  // The rooms shape, until the startup conversion rewrites it: a folder meant on.
  const rooms = raw.rooms && typeof raw.rooms === "object" ? raw.rooms as Record<string, unknown> : {};
  return {
    enabled: path_ !== null,
    where: "custom",
    path: path_,
    outside: { ...(rooms.renders === "own" ? { renders: true } : {}), ...(rooms.maps === "own" ? { maps: true } : {}) }
  };
}

export function saveAppStorageSetting(setting: AppStorageSetting, userId: string | null): void {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_by = excluded.updated_by,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(APP_STORAGE_SETTINGS_KEY, JSON.stringify(setting), userId);
}

/** Where App storage is, or would be, for a where-choice: `<system data>/app-storage`
 *  (null while system data is not chosen), or the custom folder. On or off. */
export function appStorageFolderFor(where: AppStorageWhere, customPath: string | null): string | null {
  if (where === "system") {
    const system = getSystemDataPath();
    return system ? path.join(system, APP_STORAGE_SYSTEM_FOLDER) : null;
  }
  return customPath;
}

export function isAppStorageEnabled(): boolean {
  return getAppStorageSetting().enabled;
}

/** The App storage folder while it is on; null while it is off. */
export function getAppStoragePath(): string | null {
  const setting = getAppStorageSetting();
  return setting.enabled ? appStorageFolderFor(setting.where, setting.path) : null;
}

/** Folder names a part went by before, still recognised on the installs that
 *  made them: the App files room was "Made in the app" until 3.86.0. */
export const LEGACY_ROOM_FOLDERS: Partial<Record<AppRoom, string>> = {
  house: "Made in the app"
};

/** The part's folder under `root`: the current name, unless the folder exists
 *  under a former name and the current one does not — then the former, so a
 *  rename of the part never moves anybody's files. */
export function appRoomFolderIn(root: string, room: AppRoom): string {
  const current = path.join(root, APP_ROOM_FOLDERS[room]);
  const legacy = LEGACY_ROOM_FOLDERS[room];
  if (!legacy || fs.existsSync(current)) return current;
  const former = path.join(root, legacy);
  return fs.existsSync(former) ? former : current;
}

/** Where a part lives under App storage, or null while App storage is off. Does
 *  not say whether the part IS there — see resolveAppLocation and the libraries. */
export function appRoomPath(room: AppRoom): string | null {
  const root = getAppStoragePath();
  return root ? appRoomFolderIn(root, room) : null;
}

/** Where an upload waits between arriving and landing: a hidden folder inside
 *  App storage when it is on (so a large recording does not fill a small root
 *  partition), else the system temp folder. Landing renames when it can and
 *  copies across volumes when it cannot, so either is safe. */
export function uploadStagingDir(): string {
  const root = getAppStoragePath();
  const dir = root ? path.join(root, ".staging") : path.join(os.tmpdir(), "isputnik-staging");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** True when `candidate` is App storage itself or somewhere inside it, while it is on. */
export function isInsideAppStorage(candidate: string | null | undefined): boolean {
  const root = getAppStoragePath();
  if (!root || !candidate) return false;
  const resolved = path.resolve(candidate);
  const base = path.resolve(root);
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  return norm(resolved) === norm(base) || norm(resolved).startsWith(norm(`${base}${path.sep}`));
}

/**
 * Where a plain-folder part lives right now:
 *
 *   renders  <App storage>/Renders while App storage is on and the part is not
 *            outside; otherwise null — renders and music follow the thumbnails
 *   maps     <App storage>/Map data likewise; otherwise null — map data keeps its
 *            own folder (MAP_DATA_PATH, else beside the database)
 *
 * Null means "its own place", which the calling module knows and this file does not.
 */
export function resolveAppLocation(kind: AppFolderPart): string | null {
  const setting = getAppStorageSetting();
  if (!setting.enabled || setting.outside[kind]) return null;
  const root = appStorageFolderFor(setting.where, setting.path);
  return root ? path.join(root, APP_ROOM_FOLDERS[kind]) : null;
}
