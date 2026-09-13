import path from "node:path";
import { db } from "../../db.js";
import {
  APP_ROOMS,
  APP_ROOM_FOLDERS,
  appRoomPath,
  getAppStorageSetting,
  LEGACY_ROOM_FOLDERS,
  resolveAppLocation,
  type AppRoom,
  type AppRoomMode
} from "../../core/app-storage.js";
import { configuredThumbnailPathValue, RENDER_BUCKETS } from "./shared/thumbnail.js";
import { storageMoveStatus, type StorageMoveStatus } from "./shared/storage-move.js";
import { getHouseLibrary } from "./gallery/house-library.js";
import { MAP_DATA_FOLDERS, mapDataDir } from "../maps/storage.js";
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
  /** What a switch would carry: uploaded tracks, waiting photos. */
  counts: { tracks?: number; clips?: number; waiting?: number };
  /** The room's storage move: running, or the last one's failures (storage-move.ts). */
  move: StorageMoveStatus;
  /** Set when the room's folder still goes by a former name (App files was
   *  "Made in the app" until 3.86.0): the folder it would be renamed to. */
  renameTo: string | null;
  /** Kept for the page's shape: no room of App storage is required since
   *  thumbnails moved to system data (docs/system-data-plan.md). */
  required: boolean;
  /** Why the room's folder cannot be used right now, "" when it is fine. */
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

function rendersRoom(): RoomView {
  const appPath = appRoomPath("renders");
  // Untouched, the room takes App storage once there is one (the resolver's
  // rule); "own" is the explicit choice to stay inside the thumbnail folder.
  const usesApp = appPath !== null && resolveAppLocation("renders") !== null;
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

// Map data: the map cache, the place names and the sign-in location databases
// (docs/map-approach-proposal.md). The Renders rule — App storage as soon as
// there is one, "own" the explicit choice to stay in <data>/map-data. No count
// on the row: the cache can be a hundred thousand small files, too many to walk
// on every page load, and the Contents page already weighs every room.
function mapsRoom(): RoomView {
  const appPath = appRoomPath("maps");
  const usesApp = appPath !== null && resolveAppLocation("maps") !== null;
  const resolved = mapDataDir();
  return {
    room: "maps",
    mode: usesApp ? "app" : "own",
    resolvedPath: resolved,
    appPath,
    holdsFiles: usesApp && MAP_DATA_FOLDERS.some((folder) => dirHasEntries(path.join(appPath, folder))),
    library: null,
    counts: {},
    move: storageMoveStatus("maps"),
    renameTo: null,
    required: false,
    problem: ""
  };
}

export function roomView(room: AppRoom): RoomView {
  switch (room) {
    case "inbox": return inboxRoom();
    case "house": return houseRoom();
    case "renders": return rendersRoom();
    case "maps": return mapsRoom();
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
    libraries: galleryLibraries().map((row) => ({ id: row.id, name: row.name, inbox: row.role === "inbox" }))
  };
}
