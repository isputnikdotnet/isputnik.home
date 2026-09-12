import fs from "node:fs";
import path from "node:path";
import { db } from "../../db.js";
import { parsePolicy } from "../../core/permissions.js";
import {
  APP_ROOMS,
  APP_ROOM_FOLDERS,
  appRoomMode,
  appRoomPath,
  getAppStorageSetting,
  LEGACY_ROOM_FOLDERS,
  resolveAppLocation,
  type AppRoom,
  type AppRoomMode
} from "../../core/app-storage.js";
import { configuredThumbnailPathValue, RENDER_BUCKETS } from "./shared/thumbnail.js";
import { getTrashRootSetting } from "./shared/trash-settings.js";
import { storageMoveStatus, type StorageMoveStatus } from "./shared/storage-move.js";
import { getHouseLibrary } from "./gallery/house-library.js";
import { backupDir } from "../backups/index.js";
import { dirHasEntries, galleryLibraries, inboxLibraries, itemCount, samePath, validateAppStoragePath } from "./app-storage.js";

// ── What each room is doing ─────────────────────────────────────────────────

export interface RoomView {
  room: AppRoom;
  mode: AppRoomMode;
  /** Where the room's files go right now; null when off or not set. */
  resolvedPath: string | null;
  /** Where App storage would put it; null until App storage is chosen. */
  appPath: string | null;
  /** True while this room keeps files inside App storage — what locks the folder. */
  holdsFiles: boolean;
  /** The library behind a library room (Inbox, App files). */
  library: { id: string; name: string } | null;
  /** What a switch would carry: bin items, uploaded tracks, waiting photos. */
  counts: { itemsInBin?: number; tracks?: number; clips?: number; waiting?: number; backups?: number };
  /** The room's storage move: running, or the last one's failures (storage-move.ts). */
  move: StorageMoveStatus;
  /** Set when the room's folder still goes by a former name (App files was
   *  "Made in the app" until 3.86.0): the folder it would be renamed to. */
  renameTo: string | null;
  /** True for a room that cannot be left without a place. Only Thumbnails: no
   *  library can be added until they have a folder (thumbnail.ts raises
   *  "Configure thumbnail storage before creating a library"). */
  required: boolean;
  /** Why the room's folder cannot be used right now, "" when it is fine. The
   *  row says so rather than leaving it to fail at the next scan. */
  problem: string;
}

export interface AppStorageView {
  path: string | null;
  ready: boolean;
  error: string;
  lockedBy: AppRoom[];
  folders: typeof APP_ROOM_FOLDERS;
  rooms: RoomView[];
  /** The gallery libraries the library rooms' "own" option can pick from. */
  libraries: { id: string; name: string; inbox: boolean }[];
}

function trashRoom(): RoomView {
  const appPath = appRoomPath("trash");
  const resolved = getTrashRootSetting();
  const usesApp = appRoomMode("trash") === "app" && appPath !== null;
  const itemsInBin = (db.prepare("SELECT COUNT(*) AS n FROM trashed_items").get() as { n: number }).n;
  return {
    room: "trash",
    mode: usesApp ? "app" : resolved ? "own" : "off",
    resolvedPath: resolved,
    appPath,
    holdsFiles: usesApp && (itemsInBin > 0 || dirHasEntries(resolved)),
    library: null,
    counts: { itemsInBin },
    move: storageMoveStatus("trash"),
    renameTo: null,
    required: false,
    problem: ""
  };
}

function inboxRoom(): RoomView {
  const appPath = appRoomPath("inbox");
  const inboxes = inboxLibraries();
  const appInbox = inboxes.find((row) => samePath(row.source_path, appPath)) ?? null;
  const shown = appInbox ?? inboxes[0] ?? null;
  return {
    room: "inbox",
    mode: appInbox ? "app" : shown ? "own" : "off",
    resolvedPath: shown?.source_path ?? null,
    appPath,
    holdsFiles: appInbox !== null,
    library: shown ? { id: shown.id, name: shown.name } : null,
    counts: { waiting: shown ? itemCount(shown.id) : 0 },
    move: storageMoveStatus("inbox"),
    renameTo: null,
    required: false,
    problem: ""
  };
}

export function houseRoom(): RoomView {
  const appPath = appRoomPath("house");
  const house = getHouseLibrary();
  const usesApp = house !== null && samePath(house.source_path, appPath);
  // Still under the former name? Then the row can offer the rename: the folder
  // beside it with the current name, which appRoomFolderIn says does not exist.
  const legacy = LEGACY_ROOM_FOLDERS.house;
  const underFormerName = usesApp && appPath !== null && legacy !== undefined && path.basename(appPath) === legacy;
  return {
    room: "house",
    mode: usesApp ? "app" : house ? "own" : "off",
    resolvedPath: house?.source_path ?? null,
    appPath,
    holdsFiles: usesApp,
    library: house ? { id: house.id, name: house.name } : null,
    counts: {},
    move: storageMoveStatus("house"),
    renameTo: underFormerName ? path.join(path.dirname(appPath!), APP_ROOM_FOLDERS.house) : null,
    required: false,
    problem: ""
  };
}

/** Why the thumbnail folder cannot be used, said in a sentence rather than as an
 *  fs error code — the row is read by whoever set the path, not by a developer.
 *  A folder that is merely missing is not a problem: like every other room's, it
 *  is made on demand, and this says so only when it cannot be made. */
function thumbnailProblem(folder: string): string {
  if (!path.isAbsolute(folder)) return "Use an absolute server path for the thumbnail folder.";
  try {
    if (!fs.statSync(folder).isDirectory()) return "That path is a file, not a folder.";
    fs.accessSync(folder, fs.constants.R_OK | fs.constants.W_OK);
    return "";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") return "The app cannot read and write in that folder.";
    try {
      fs.mkdirSync(folder, { recursive: true });
      return "";
    } catch {
      return "That folder does not exist and cannot be created.";
    }
  }
}

function thumbnailsRoom(): RoomView {
  const appPath = appRoomPath("thumbnails");
  const resolved = configuredThumbnailPathValue() || null;
  const usesApp = resolved !== null && samePath(resolved, appPath);
  // The one room whose folder is checked while the page is read: an unwritable
  // thumbnail folder is otherwise only met by the next scan, as a failed render.
  const problem = resolved ? thumbnailProblem(resolved) : "";
  return {
    room: "thumbnails",
    mode: usesApp ? "app" : resolved ? "own" : "off",
    resolvedPath: resolved,
    appPath,
    holdsFiles: usesApp && dirHasEntries(resolved),
    library: null,
    counts: {},
    move: storageMoveStatus("thumbnails"),
    renameTo: null,
    required: true,
    problem
  };
}

function rendersRoom(): RoomView {
  const appPath = appRoomPath("renders");
  // Untouched, the room takes App storage once there is one (the resolver's
  // rule); "own" is the explicit choice to stay inside the thumbnail folder.
  const usesApp = appPath !== null && resolveAppLocation("renders", null) !== null;
  let resolved: string | null = null;
  try {
    resolved = usesApp ? appPath : (configuredThumbnailPathValue() || null);
  } catch {
    resolved = null;
  }
  // Only the tracks still kept as bucket files: the rest are library assets now.
  const tracks = (db.prepare("SELECT COUNT(*) AS n FROM gallery_music_tracks WHERE item_id IS NULL").get() as { n: number }).n;
  const clips = (db.prepare("SELECT COUNT(*) AS n FROM story_audio").get() as { n: number }).n;
  return {
    room: "renders",
    mode: usesApp ? "app" : "own",
    resolvedPath: resolved,
    appPath,
    holdsFiles: usesApp && RENDER_BUCKETS.some((bucket) => dirHasEntries(path.join(appPath, bucket))),
    library: null,
    counts: { tracks, clips },
    move: storageMoveStatus("renders"),
    renameTo: null,
    required: false,
    problem: ""
  };
}

function backupsRoom(): RoomView {
  const appPath = appRoomPath("backups");
  const usesApp = appRoomMode("backups") === "app" && appPath !== null;
  const resolved = backupDir();
  let backups = 0;
  try {
    backups = fs.readdirSync(resolved).filter((name) => name.endsWith(".zip") || name.endsWith(".sqlite")).length;
  } catch {
    backups = 0;
  }
  return {
    room: "backups",
    mode: usesApp ? "app" : "own",
    resolvedPath: resolved,
    appPath,
    holdsFiles: usesApp && backups > 0,
    library: null,
    counts: { backups },
    move: storageMoveStatus("backups"),
    renameTo: null,
    required: false,
    problem: ""
  };
}

export function roomView(room: AppRoom): RoomView {
  switch (room) {
    case "trash": return trashRoom();
    case "inbox": return inboxRoom();
    case "house": return houseRoom();
    case "thumbnails": return thumbnailsRoom();
    case "renders": return rendersRoom();
    case "backups": return backupsRoom();
  }
}

export function appStorageView(): AppStorageView {
  const setting = getAppStorageSetting();
  let ready = false;
  let error = "";
  if (setting.path) {
    try {
      validateAppStoragePath(setting.path, { allowRoomLibraries: true });
      ready = true;
    } catch (err) {
      error = err instanceof Error ? err.message : "App storage is not available.";
    }
  }
  const rooms = APP_ROOMS.map(roomView);
  return {
    path: setting.path,
    ready,
    error,
    lockedBy: rooms.filter((room) => room.holdsFiles).map((room) => room.room),
    folders: APP_ROOM_FOLDERS,
    rooms,
    libraries: galleryLibraries().map((row) => ({ id: row.id, name: row.name, inbox: parsePolicy(row.policy_json).inbox === true }))
  };
}
