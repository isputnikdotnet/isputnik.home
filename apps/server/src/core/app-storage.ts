// App storage — docs/app-storage-plan.md, phase 1.
//
// One folder the app may keep its own things in, laid out as fixed "rooms":
// the Recycle Bin, the Photo Inbox, the App files library, thumbnails,
// renders and music, and backups. Every room is optional and each is its own
// choice — use App storage, keep its own place, or (where the room is a
// feature) stay off. The specific settings that existed before this
// (thumbnail folder, bin folder, house library, BACKUP_PATH) are untouched and
// remain the "its own place" answer; this file only adds the one setting that
// can stand in for them, and the resolver that decides which answer applies.
//
// It sits in core/ because every module reads it: thumbnails, the bin,
// slideshow renders, music, backups. It knows nothing about libraries or
// containers — validating the folder (inside a container, outside every
// library) is the storage route's job in modules/library/app-storage-routes.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "../db.js";
import { stmt } from "../db/statement-cache.js";
import type { AppSettingRow } from "../db/rows.js";

export const APP_STORAGE_SETTINGS_KEY = "app_storage";

/** The rooms, in the order the Storage page lists them. */
export const APP_ROOMS = ["trash", "inbox", "house", "thumbnails", "renders", "backups"] as const;
export type AppRoom = (typeof APP_ROOMS)[number];

/** Folder names inside App storage, fixed and in English like the house
 *  library's folders, so a folder listing reads the same on every install. */
export const APP_ROOM_FOLDERS: Record<AppRoom, string> = {
  trash: "Recycle Bin",
  inbox: "Photo Inbox",
  house: "App files",
  thumbnails: "Thumbnails",
  renders: "Renders",
  backups: "Backups"
};

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
 * The location the housekeeping rooms resolve to, by kind:
 *
 *   thumbnails  the thumbnail folder setting if set, else <App storage>/Thumbnails,
 *               else null (the caller keeps raising "configure thumbnail storage")
 *   trash       <App storage>/Recycle Bin when the room is switched to App
 *               storage, else the bin folder setting, else null (per-library .trash)
 *   renders     <App storage>/Renders whenever App storage is set, unless the
 *               room was switched to "own" (inside the thumbnail folder); with
 *               no App storage, null — renders and music follow the thumbnails
 *   backups     <App storage>/Backups when switched on, else BACKUP_PATH
 *
 * `own` is the room's own setting value, passed in by the caller because this
 * file does not know where each module keeps it.
 */
export function resolveAppLocation(kind: "thumbnails" | "trash" | "renders" | "backups", own: string | null): string | null {
  const setting = getAppStorageSetting();
  const under = (room: AppRoom) => (setting.path ? path.join(setting.path, APP_ROOM_FOLDERS[room]) : null);
  switch (kind) {
    case "thumbnails": {
      const mode = setting.rooms.thumbnails;
      if (mode === "app") return under("thumbnails") ?? own;
      if (mode === "own") return own;
      return own ?? under("thumbnails");
    }
    case "trash":
      return setting.rooms.trash === "app" ? under("trash") ?? own : own;
    case "renders":
      // Untouched, the room takes App storage as soon as there is one (3.88.0;
      // it used to stay inside the thumbnail folder, usually the small config
      // volume). "own" is the explicit choice to stay inside the thumbnails.
      if (setting.rooms.renders === "own") return null;
      return under("renders");
    case "backups":
      return setting.rooms.backups === "app" ? under("backups") ?? own : own;
  }
}
