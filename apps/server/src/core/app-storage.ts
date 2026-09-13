// App storage — docs/app-storage-plan.md, phase 1.
//
// One folder the app may keep its own things in, laid out as fixed "rooms":
// the Photo Inbox, the App files library, renders and music, and map data.
//
// Since 4.6 (docs/system-data-plan.md, phase 2) the Recycle Bin, thumbnails and
// backups are not rooms: thumbnails and backups belong to system data
// (core/system-data.ts), and the bin's location is its own setting on the
// Recycle Bin page. Installs that had them in App storage were converted at
// startup to the same folders, as settings of their own (system-data-upgrade.ts).
//
// It sits in core/ because every module reads it: slideshow renders, music, map
// data. It knows nothing about libraries or containers — validating the folder
// (inside a container, outside every library) is the storage route's job in
// modules/library/app-storage-routes.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "../db.js";
import { stmt } from "../db/statement-cache.js";
import type { AppSettingRow } from "../db/rows.js";

export const APP_STORAGE_SETTINGS_KEY = "app_storage";

/** The rooms, in the order the Storage page lists them. */
export const APP_ROOMS = ["inbox", "house", "renders", "maps"] as const;
export type AppRoom = (typeof APP_ROOMS)[number];

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

/** app = the room's folder under App storage; own = the room's own setting;
 *  off = the room is not used (only meaningful for the rooms that are features). */
export type AppRoomMode = "app" | "own" | "off";

export interface AppStorageSetting {
  path: string | null;
  /** A room absent here follows its default (decision 6 of the plan). */
  rooms: Partial<Record<AppRoom, AppRoomMode>>;
}

export function getAppStorageSetting(): AppStorageSetting {
  // Read for every thumbnail path resolved (each scanned photo, each thumbnail
  // request), so the statement is compiled once.
  const row = stmt("SELECT value FROM app_settings WHERE key = ?").get(APP_STORAGE_SETTINGS_KEY) as Pick<AppSettingRow, "value"> | undefined;
  if (!row) return { path: null, rooms: {} };
  try {
    const parsed = JSON.parse(row.value) as Partial<AppStorageSetting>;
    const rooms: Partial<Record<AppRoom, AppRoomMode>> = {};
    for (const room of APP_ROOMS) {
      const mode = parsed.rooms?.[room];
      if (mode === "app" || mode === "own" || mode === "off") rooms[room] = mode;
    }
    return { path: typeof parsed.path === "string" && parsed.path.trim() ? parsed.path : null, rooms };
  } catch {
    return { path: null, rooms: {} };
  }
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

/** The App storage folder, or null when none is chosen. */
export function getAppStoragePath(): string | null {
  return getAppStorageSetting().path;
}

/** Folder names a room went by before, still recognised on the installs that
 *  made them: the App files room was "Made in the app" until 3.86.0. */
export const LEGACY_ROOM_FOLDERS: Partial<Record<AppRoom, string>> = {
  house: "Made in the app"
};

/** The room's folder under `root`: the current name, unless the folder exists
 *  under a former name and the current one does not — then the former, so a
 *  rename of the room never moves anybody's files. */
export function appRoomFolderIn(root: string, room: AppRoom): string {
  const current = path.join(root, APP_ROOM_FOLDERS[room]);
  const legacy = LEGACY_ROOM_FOLDERS[room];
  if (!legacy || fs.existsSync(current)) return current;
  const former = path.join(root, legacy);
  return fs.existsSync(former) ? former : current;
}

/** Where a room would live under App storage, or null when App storage is
 *  not set. Does not say whether the room USES it — see the resolvers. */
export function appRoomPath(room: AppRoom): string | null {
  const root = getAppStoragePath();
  return root ? appRoomFolderIn(root, room) : null;
}

/** The stored mode for a room, or undefined when it follows its default. */
export function appRoomMode(room: AppRoom): AppRoomMode | undefined {
  return getAppStorageSetting().rooms[room];
}

export function setAppRoomMode(room: AppRoom, mode: AppRoomMode | undefined, userId: string | null): void {
  const setting = getAppStorageSetting();
  if (mode === undefined) delete setting.rooms[room];
  else setting.rooms[room] = mode;
  saveAppStorageSetting(setting, userId);
}

/** Where an upload waits between arriving and landing: a hidden folder inside
 *  App storage when there is one (so a large recording does not fill a small
 *  root partition), else the system temp folder. Landing renames when it can
 *  and copies across volumes when it cannot, so either is safe. */
export function uploadStagingDir(): string {
  const root = getAppStoragePath();
  const dir = root ? path.join(root, ".staging") : path.join(os.tmpdir(), "isputnik-staging");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** True when `candidate` is App storage itself or somewhere inside it. */
export function isInsideAppStorage(candidate: string | null | undefined): boolean {
  const root = getAppStoragePath();
  if (!root || !candidate) return false;
  const resolved = path.resolve(candidate);
  const base = path.resolve(root);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`);
}

/**
 * The location the rooms that are folders resolve to, by kind:
 *
 *   renders     <App storage>/Renders whenever App storage is set, unless the
 *               room was switched to "own" (inside the thumbnail folder); with
 *               no App storage, null — renders and music follow the thumbnails
 *   maps        <App storage>/Map data whenever App storage is set, unless the
 *               room was switched to "own" (MAP_DATA_PATH, else <data>/map-data);
 *               the Renders rule, because map data is the app's own and regrowable
 *
 * Null means "its own place", which the calling module knows and this file does not.
 */
export function resolveAppLocation(kind: "renders" | "maps"): string | null {
  const setting = getAppStorageSetting();
  const under = (room: AppRoom) => (setting.path ? path.join(setting.path, APP_ROOM_FOLDERS[room]) : null);
  switch (kind) {
    case "renders":
      // Untouched, the room takes App storage as soon as there is one (3.88.0;
      // it used to stay inside the thumbnail folder, usually the small config
      // volume). "own" is the explicit choice to stay inside the thumbnails.
      if (setting.rooms.renders === "own") return null;
      return under("renders");
    case "maps":
      // Null means "its own place", which the maps module knows and this file
      // does not (modules/maps/storage.ts, ownMapDataDir).
      if (setting.rooms.maps === "own") return null;
      return under("maps");
  }
}
