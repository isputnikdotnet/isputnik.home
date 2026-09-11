// App storage's rooms — docs/app-storage-plan.md, phase 1. The setting itself is
// core/app-storage.ts; this is what the Storage page shows for each room, and the
// switches that move a room between "use App storage", "its own place" and "off".
//
// Every switch is one room. Choosing the App storage folder records a path and
// nothing else; changing it later carries each room that uses it along, or
// leaves the room where it is, as the admin chose for that room.
import fs from "node:fs";
import path from "node:path";
import { db, logActivity } from "../../db.js";
import { config } from "../../config.js";
import { parsePolicy } from "../../core/permissions.js";
import {
  APP_ROOMS,
  APP_ROOM_FOLDERS,
  appRoomMode,
  appRoomFolderIn,
  appRoomPath,
  getAppStorageSetting,
  LEGACY_ROOM_FOLDERS,
  isInsideAppStorage,
  resolveAppLocation,
  saveAppStorageSetting,
  setAppRoomMode,
  type AppRoom,
  type AppRoomMode
} from "../../core/app-storage.js";
import { findStorageRootForPath, pathIsInside } from "./shared/storage-roots.js";
import {
  configuredThumbnailPathValue,
  getRendersRoot,
  ownThumbnailPathValue,
  RENDER_BUCKETS,
  thumbnailPathSettingKey,
  validateThumbnailPath
} from "./shared/thumbnail.js";
import {
  getOwnTrashRootSetting,
  getTrashRootSetting,
  moveEntry,
  setTrashRootSetting,
  TrashError,
  validateTrashRootPath
} from "./shared/trash.js";
import { startTrashMove } from "./shared/trash-move.js";
import { moveEntryAcross, startFolderMove } from "./shared/folder-move.js";
import { anyStorageMoveActive, assertMoveTargetFree, enqueueStorageMove, storageMoveStatus, type StorageMoveStatus } from "./shared/storage-move.js";
import { createLibraryRecord } from "./shared/library-crud.js";
import { getHouseLibrary, setHouseLibrary } from "./gallery/house-library.js";
import { enqueueGalleryScan, processGalleryScanQueue } from "./gallery/scanner.js";
import { backupDir } from "../backups/index.js";

export class AppStorageError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "AppStorageError";
  }
}

interface GalleryLibraryRow {
  id: string;
  name: string;
  source_path: string;
  policy_json: string;
  scan_status: string;
}

const samePath = (a: string | null | undefined, b: string | null | undefined): boolean =>
  Boolean(a && b) && path.resolve(a!) === path.resolve(b!);

function galleryLibraries(): GalleryLibraryRow[] {
  return db.prepare("SELECT id, name, source_path, policy_json, scan_status FROM libraries WHERE type = 'gallery' ORDER BY name COLLATE NOCASE")
    .all() as GalleryLibraryRow[];
}

function inboxLibraries(): GalleryLibraryRow[] {
  return galleryLibraries().filter((row) => parsePolicy(row.policy_json).inbox === true);
}

function libraryAt(sourcePath: string | null): GalleryLibraryRow | null {
  if (!sourcePath) return null;
  return galleryLibraries().find((row) => samePath(row.source_path, sourcePath)) ?? null;
}

function itemCount(libraryId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM library_items WHERE library_id = ? AND deleted_at IS NULL").get(libraryId) as { n: number }).n;
}

function dirHasEntries(dir: string | null): boolean {
  if (!dir) return false;
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

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
    renameTo: null
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
    renameTo: null
  };
}

function houseRoom(): RoomView {
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
    renameTo: underFormerName ? path.join(path.dirname(appPath!), APP_ROOM_FOLDERS.house) : null
  };
}

function thumbnailsRoom(): RoomView {
  const appPath = appRoomPath("thumbnails");
  const resolved = configuredThumbnailPathValue() || null;
  const usesApp = resolved !== null && samePath(resolved, appPath);
  return {
    room: "thumbnails",
    mode: usesApp ? "app" : resolved ? "own" : "off",
    resolvedPath: resolved,
    appPath,
    holdsFiles: usesApp && dirHasEntries(resolved),
    library: null,
    counts: {},
    move: storageMoveStatus("thumbnails"),
    renameTo: null
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
    renameTo: null
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
    renameTo: null
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

// ── The folder itself ───────────────────────────────────────────────────────

/** Vet a candidate App storage folder the way a library source is vetted: it must
 *  exist, sit inside an approved container (but not BE one — its rooms would sit
 *  beside libraries), and be outside every library. It may contain the libraries
 *  its own rooms made, and nothing else. */
export function validateAppStoragePath(candidate: string, opts: { allowRoomLibraries?: boolean } = {}): string {
  const resolved = path.resolve(candidate);
  if (!path.isAbsolute(resolved)) throw new AppStorageError("Use an absolute server path for App storage.");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new AppStorageError(`That folder is missing or not accessible: ${resolved}`);
  }
  if (!stat.isDirectory()) throw new AppStorageError("App storage must be a folder.");
  const real = fs.realpathSync(resolved);
  const root = findStorageRootForPath(real);
  if (!root) throw new AppStorageError("Choose a folder inside a configured Digital Library container.");
  if (path.resolve(root.path) === real) {
    throw new AppStorageError("Choose a folder inside the container, not the container itself: the app makes its own folders in it.");
  }
  const roomPaths = new Set([...Object.values(APP_ROOM_FOLDERS), ...Object.values(LEGACY_ROOM_FOLDERS)].map((folder) => path.join(real, folder)));
  const libraries = db.prepare("SELECT name, source_path FROM libraries").all() as { name: string; source_path: string }[];
  for (const library of libraries) {
    const source = path.resolve(library.source_path);
    if (pathIsInside(real, source)) {
      throw new AppStorageError(`That folder is inside the library "${library.name}". Choose one outside every library.`);
    }
    if (pathIsInside(source, real) && !(opts.allowRoomLibraries && roomPaths.has(source))) {
      throw new AppStorageError(`The library "${library.name}" is inside that folder. App storage must not contain a library.`);
    }
  }
  return real;
}

/** What the admin chose for each room that uses App storage when the folder
 *  changes: true carries the room to the new folder, false leaves it where it is
 *  (the room becomes "its own place", or goes back to its default for the rooms
 *  that have no place of their own). A room not mentioned is carried. */
export type CarryRooms = Partial<Record<AppRoom, boolean>>;

/** The steps a folder change takes for the rooms that use the current folder. */
interface CarryStep {
  room: AppRoom;
  carry: boolean;
}

/** Carry every entry of one folder into another, merging (backups have no
 *  structure the app relies on). Used for the backups on a folder change: a
 *  handful of files, moved in the request. */
function moveFolderEntries(from: string, to: string, what: string): void {
  if (samePath(from, to) || !fs.existsSync(from)) return;
  const names = fs.readdirSync(from);
  const carried: string[] = [];
  try {
    for (const name of names) {
      moveEntryAcross(from, to, name);
      carried.push(name);
    }
  } catch (err) {
    for (const name of carried) { try { moveEntryAcross(to, from, name); } catch { /* left at the target */ } }
    throw new AppStorageError(`Could not move ${what}: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
  try { fs.rmdirSync(from); } catch { /* not empty, or someone else's */ }
}

/** Queue moving a gallery library's folder to `to` as a storage move task
 *  (storage-move.ts): the library keeps pointing at its old folder until every
 *  file is across and verified, then the path flips. Refused up front while the
 *  library is being scanned or something already sits at the target. */
function queueLibraryMove(library: GalleryLibraryRow, room: "inbox" | "house", to: string, userId: string): void {
  if (library.scan_status === "scanning") {
    throw new AppStorageError(`"${library.name}" is being scanned right now. Wait for the scan to finish before moving it.`, 409);
  }
  assertMoveTargetFree(to, `"${library.name}"`);
  enqueueStorageMove({ kind: "library", room, label: library.name, from: library.source_path, to, libraryId: library.id, actorUserId: userId });
}

/** Record, change or clear the App storage folder. A room that uses the current
 *  folder is carried to the new one when asked (`carry[room]` true, the default),
 *  or leaves App storage: the Recycle Bin and thumbnails keep their old folder as
 *  their own place, a library room's library stays where it is, and renders and
 *  backups go back to their default place (the thumbnail folder, the backup
 *  folder), since they have no place of their own. Every carry is a storage
 *  move task (storage-move.ts) queued after the setting changes — a library
 *  flips its path only once its files are across and verified — except the
 *  backups, a few files moved in the request. Every check happens before
 *  anything changes. Clearing the folder leaves every room. A fresh install,
 *  one with no library yet, also gets the Recycle Bin room switched on
 *  (decision 9). */
export function setAppStoragePath(candidate: string | null, userId: string, carry: CarryRooms = {}): AppStorageView {
  const current = getAppStorageSetting();
  // Libraries its own rooms made (a turned-off Inbox, say) may stay inside it.
  const wanted = candidate?.trim() ? validateAppStoragePath(candidate.trim(), { allowRoomLibraries: true }) : null;
  if (samePath(current.path, wanted) || (!current.path && !wanted)) return appStorageView();

  const before = current.path;
  const rooms = APP_ROOMS.map(roomView);
  const steps: CarryStep[] = before
    ? rooms.filter((room) => room.mode === "app").map((room) => ({ room: room.room, carry: wanted !== null && carry[room.room] !== false }))
    : [];
  const step = (room: AppRoom) => steps.find((s) => s.room === room);
  if (steps.length > 0 && anyStorageMoveActive()) {
    throw new AppStorageError("A storage move is running right now. Wait for it to finish, or cancel it on the Tasks page, before changing App storage.", 409);
  }
  // The old folder may go by a room's former name on an install that made it then.
  const oldRoom = (room: AppRoom) => appRoomFolderIn(before!, room);
  const newRoom = (room: AppRoom) => path.join(wanted!, APP_ROOM_FOLDERS[room]);

  // Where the thumbnails will be once this is done — renders that leave go there.
  const thumbs = step("thumbnails");
  const thumbnailsAfter = thumbs ? (thumbs.carry ? newRoom("thumbnails") : oldRoom("thumbnails")) : (configuredThumbnailPathValue() || null);
  const renders = step("renders");
  if (renders && !renders.carry && !thumbnailsAfter) {
    throw new AppStorageError("There is no thumbnail folder for renders and music to go back to.", 409);
  }

  // Every check before any change: a library room's library must be movable.
  const libraryMoves: { library: GalleryLibraryRow; room: "inbox" | "house" }[] = [];
  for (const room of ["inbox", "house"] as const) {
    const s = step(room);
    if (!s?.carry) continue;
    const library = libraryAt(oldRoom(room));
    if (!library) continue;
    if (library.scan_status === "scanning") {
      throw new AppStorageError(`"${library.name}" is being scanned right now. Wait for the scan to finish before moving App storage.`, 409);
    }
    assertMoveTargetFree(newRoom(room), `"${library.name}"`);
    libraryMoves.push({ library, room });
  }

  // The backups are the one thing carried in the request: a handful of files.
  const backups = step("backups");
  if (backups) {
    const to = backups.carry ? newRoom("backups") : path.resolve(config.backupPath);
    fs.mkdirSync(to, { recursive: true });
    moveFolderEntries(oldRoom("backups"), to, "the backups");
  }

  // The rooms that leave record their own place; the rest keep their mode and
  // resolve into the new folder as soon as it is saved.
  const modes = { ...current.rooms };
  for (const s of steps) {
    if (s.carry) continue;
    switch (s.room) {
      case "trash":
        setTrashRootSetting(oldRoom("trash"), userId);
        modes.trash = "own";
        break;
      case "thumbnails":
        db.prepare(
          `INSERT INTO app_settings (key, value, updated_by, updated_at)
           VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
        ).run(thumbnailPathSettingKey, oldRoom("thumbnails"), userId);
        modes.thumbnails = "own";
        break;
      case "renders":
        // Left behind means "inside the thumbnail folder", which must be said:
        // blank would read as App storage once there is one — the new folder.
        modes.renders = "own";
        break;
      case "backups":
        delete modes.backups;
        break;
      case "inbox":
      case "house":
        // The library stays; the row reads it as the room's own library.
        break;
    }
  }
  saveAppStorageSetting({ path: wanted, rooms: wanted ? modes : {} }, userId);

  // Now the tasks, in the order they should run: the libraries (which flip their
  // path only when across), the render buckets, the thumbnails, then the bin.
  if (wanted) {
    for (const { library, room } of libraryMoves) {
      enqueueStorageMove({ kind: "library", room, label: library.name, from: library.source_path, to: newRoom(room), libraryId: library.id, actorUserId: userId });
    }
    if (thumbs?.carry) {
      fs.mkdirSync(newRoom("thumbnails"), { recursive: true });
      startFolderMove(oldRoom("thumbnails"), newRoom("thumbnails"), userId);
    }
    if (step("trash")?.carry) {
      fs.mkdirSync(newRoom("trash"), { recursive: true });
      startTrashMove(userId, oldRoom("trash"));
    }
  }
  if (renders) {
    const to = renders.carry ? newRoom("renders") : validateThumbnailPath(thumbnailsAfter!);
    enqueueStorageMove({ kind: "renders", room: "renders", label: "Renders", from: oldRoom("renders"), to, actorUserId: userId });
  }

  if (wanted && !before) {
    const libraryCount = (db.prepare("SELECT COUNT(*) AS n FROM libraries").get() as { n: number }).n;
    if (libraryCount === 0 && !getOwnTrashRootSetting() && appRoomMode("trash") === undefined) {
      try {
        switchRoom("trash", "app", null, userId);
      } catch {
        /* the folder stays; the bin can be switched on from its row */
      }
    }
  }
  logActivity({
    event: "config.updated",
    actorUserId: userId,
    targetType: "setting",
    targetId: "app_storage",
    detail: [
      wanted ? `App storage set to ${wanted}.` : "App storage cleared.",
      ...steps.map((s) => `${APP_ROOM_FOLDERS[s.room]}: ${s.carry ? "carried along" : "left where it was"}.`)
    ].join(" ")
  });
  return appStorageView();
}

// ── Switching a room ────────────────────────────────────────────────────────

function requireAppPath(room: AppRoom): string {
  const appPath = appRoomPath(room);
  if (!appPath) throw new AppStorageError("Choose the App storage folder first.");
  fs.mkdirSync(appPath, { recursive: true });
  return appPath;
}

function switchTrash(mode: AppRoomMode, ownPath: string | null, userId: string): void {
  if (storageMoveStatus("trash").running) {
    throw new AppStorageError("The bin is being moved right now. Wait for it to finish, or cancel it, before changing the location again.", 409);
  }
  // Where the bin was until now: the task carries the replaced originals from
  // there, since they have no rows to say where they are.
  const before = getTrashRootSetting();
  if (mode === "app") {
    const appPath = requireAppPath("trash");
    validateTrashRootPath(appPath);
    setAppRoomMode("trash", "app", userId);
  } else if (mode === "own") {
    if (!ownPath?.trim()) throw new AppStorageError("Choose the folder the Recycle Bin should use.");
    const resolved = validateTrashRootPath(ownPath.trim());
    setTrashRootSetting(resolved, userId);
    setAppRoomMode("trash", "own", userId);
  } else {
    setTrashRootSetting(null, userId);
    setAppRoomMode("trash", "off", userId);
  }
  startTrashMove(userId, before);
}

function switchThumbnails(mode: AppRoomMode, ownPath: string | null, userId: string): void {
  if (mode === "off") throw new AppStorageError("Thumbnails need a folder; choose App storage or one of your own.");
  if (storageMoveStatus("thumbnails").running) {
    throw new AppStorageError("The thumbnails are being moved right now. Wait for that to finish, or cancel it, before changing the folder again.", 409);
  }
  const before = configuredThumbnailPathValue() || null;
  let after: string;
  if (mode === "app") {
    after = validateThumbnailPath(requireAppPath("thumbnails"));
    setAppRoomMode("thumbnails", "app", userId);
  } else {
    if (!ownPath?.trim()) throw new AppStorageError("Choose the folder thumbnails should use.");
    after = validateThumbnailPath(ownPath.trim());
    db.prepare(
      `INSERT INTO app_settings (key, value, updated_by, updated_at)
       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    ).run(thumbnailPathSettingKey, after, userId);
    setAppRoomMode("thumbnails", "own", userId);
  }
  // Everything in the old folder (each library's bucket, the people bucket, and
  // the render buckets when they follow the thumbnails) is carried across in the
  // background (phase 3); until an entry arrives, its covers are missing.
  if (before && !samePath(before, after)) startFolderMove(before, after, userId);
}

function switchRenders(mode: AppRoomMode, userId: string): void {
  if (mode === "off") throw new AppStorageError("Renders and music always live somewhere: App storage, or inside the thumbnail folder.");
  if (storageMoveStatus("renders").running) {
    throw new AppStorageError("Renders and music are being moved right now. Wait for that to finish, or cancel it, before changing the room again.", 409);
  }
  const before = getRendersRoot();
  let after: string;
  if (mode === "app") {
    after = requireAppPath("renders");
    setAppRoomMode("renders", "app", userId);
  } else {
    const thumbnails = configuredThumbnailPathValue();
    if (!thumbnails) throw new AppStorageError("There is no thumbnail folder for renders and music to go back to.");
    after = validateThumbnailPath(thumbnails);
    // Recorded as a choice, not left blank: blank means "App storage once there
    // is one", and this admin has asked for the thumbnail folder.
    setAppRoomMode("renders", "own", userId);
  }
  // The setting has flipped; the buckets follow as a task, and a track not yet
  // across is missing for the seconds it takes.
  if (!samePath(before, after)) {
    enqueueStorageMove({ kind: "renders", room: "renders", label: "Renders", from: before, to: after, actorUserId: userId });
  }
}

function switchBackups(mode: AppRoomMode, userId: string): void {
  if (mode === "off") throw new AppStorageError("Backups always go somewhere: App storage, or the backup folder.");
  if (mode === "app") {
    requireAppPath("backups");
    setAppRoomMode("backups", "app", userId);
  } else {
    fs.mkdirSync(config.backupPath, { recursive: true });
    setAppRoomMode("backups", undefined, userId);
  }
}

function switchInbox(mode: AppRoomMode, libraryId: string | null, userId: string, ip: string): void {
  const appPath = appRoomPath("inbox");
  if (mode === "own") {
    // One of the admin's own gallery libraries becomes the Inbox: the same switch
    // the library's Access tab offers, reachable from the room's row.
    if (!libraryId) throw new AppStorageError("Choose which gallery library should be the Photo Inbox.");
    const library = galleryLibraries().find((row) => row.id === libraryId);
    if (!library) throw new AppStorageError("That gallery library doesn't exist.", 404);
    if (getHouseLibrary()?.id === library.id) {
      throw new AppStorageError(`"${library.name}" is the App files library; it holds what the family makes, not what is waiting for review.`, 409);
    }
    setInboxFlag(library.id, true);
    return;
  }
  if (mode === "app") {
    if (!appPath) throw new AppStorageError("Choose the App storage folder first.");
    const existing = libraryAt(appPath);
    if (existing) {
      if (parsePolicy(existing.policy_json).inbox !== true) setInboxFlag(existing.id, true);
      return;
    }
    // An Inbox of the admin's own moves into App storage, photos and all, rather
    // than a second Inbox being made beside it: the row shows one Inbox, and the
    // photos waiting for review keep waiting where the row now points.
    const own = inboxLibraries()[0] ?? null;
    if (own) {
      queueLibraryMove(own, "inbox", appPath, userId);
      return;
    }
    fs.mkdirSync(appPath, { recursive: true });
    const result = createLibraryRecord({
      type: "gallery",
      data: { name: APP_ROOM_FOLDERS.inbox, sourcePath: appPath, visibility: "public", publicRole: "viewer", mode: "managed", inbox: true },
      userId,
      ip
    });
    if ("error" in result) throw new AppStorageError(result.error, result.status as number);
    enqueueGalleryScan(result.libraryId);
    void processGalleryScanQueue();
    return;
  }
  // off: the app-made Inbox becomes an ordinary library — refused while photos are
  // still waiting in it, since they would land on the Timeline unreviewed.
  const appInbox = inboxLibraries().find((row) => samePath(row.source_path, appPath));
  if (!appInbox) return;
  const waiting = itemCount(appInbox.id);
  if (waiting > 0) {
    throw new AppStorageError(
      `${waiting === 1 ? "One photo is" : `${waiting} photos are`} still waiting in "${appInbox.name}". Review or discard them first.`,
      409
    );
  }
  setInboxFlag(appInbox.id, false);
}

function setInboxFlag(libraryId: string, inbox: boolean): void {
  const row = db.prepare("SELECT policy_json FROM libraries WHERE id = ?").get(libraryId) as { policy_json: string } | undefined;
  if (!row) return;
  let policy: Record<string, unknown> = {};
  try { policy = JSON.parse(row.policy_json || "{}") as Record<string, unknown>; } catch { /* rebuilt */ }
  if (inbox) policy.inbox = true;
  else delete policy.inbox;
  db.prepare("UPDATE libraries SET policy_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .run(JSON.stringify(policy), libraryId);
}

function switchHouse(mode: AppRoomMode, ownLibraryId: string | null, userId: string, ip: string): void {
  if (mode === "own") {
    if (!ownLibraryId) throw new AppStorageError("Choose which gallery library should hold what is made in the app.");
    const nominated = setHouseLibrary(ownLibraryId, userId);
    if (!nominated.ok) throw new AppStorageError(nominated.error, nominated.status);
    return;
  }
  if (mode === "off") {
    setHouseLibrary(null, userId);
    return;
  }
  const appPath = appRoomPath("house");
  if (!appPath) throw new AppStorageError("Choose the App storage folder first.");
  const existing = libraryAt(appPath);
  // The nominated library of the admin's own moves into App storage whole and
  // stays nominated (the owner's call, 2026-09-10): what the family made is in
  // it, and a second library beside it would split that in two.
  const currentHouse = getHouseLibrary();
  const own = currentHouse ? galleryLibraries().find((row) => row.id === currentHouse.id) ?? null : null;
  if (!existing && own && parsePolicy(own.policy_json).inbox !== true) {
    queueLibraryMove(own, "house", appPath, userId);
    return;
  }
  let libraryId: string;
  if (existing) {
    if (parsePolicy(existing.policy_json).inbox === true) {
      throw new AppStorageError(`"${existing.name}" at that folder is a Photo Inbox, so it cannot also be the App files library.`, 409);
    }
    libraryId = existing.id;
  } else {
    fs.mkdirSync(appPath, { recursive: true });
    const result = createLibraryRecord({
      type: "gallery",
      data: { name: APP_ROOM_FOLDERS.house, sourcePath: appPath, visibility: "public", publicRole: "member", mode: "managed" },
      userId,
      ip
    });
    if ("error" in result) throw new AppStorageError(result.error, result.status as number);
    libraryId = result.libraryId;
    enqueueGalleryScan(libraryId);
    void processGalleryScanQueue();
  }
  const nominated = setHouseLibrary(libraryId, userId);
  if (!nominated.ok) throw new AppStorageError(nominated.error, nominated.status);
}

/** Rename a room's folder from its former name to the current one — today
 *  only the App files room, on an install that made it as "Made in the app".
 *  The rename is the same storage move task the row's switches use: one rename
 *  on the same disk, every file copied and checked across disks, and the
 *  library follows its folder in the same step, so nothing is rescanned. A
 *  library that was itself named after the old folder takes the new name too.
 *  Throws AppStorageError with the status the route should answer with. */
export function renameRoomFolder(room: AppRoom, userId: string, ip = ""): RoomView {
  if (room !== "house") throw new AppStorageError("That room's folder has no former name to rename from.", 404);
  const view = houseRoom();
  if (!view.renameTo || !view.library) {
    throw new AppStorageError(`The ${APP_ROOM_FOLDERS.house} folder already has its current name.`, 409);
  }
  const library = galleryLibraries().find((row) => row.id === view.library!.id);
  if (!library) throw new AppStorageError("The App files library is gone.", 404);
  queueLibraryMove(library, "house", view.renameTo, userId);
  if (library.name === LEGACY_ROOM_FOLDERS.house) {
    db.prepare("UPDATE libraries SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(APP_ROOM_FOLDERS.house, library.id);
  }
  logActivity({
    event: "config.updated",
    actorUserId: userId,
    targetType: "setting",
    targetId: "app_storage.house",
    detail: `${APP_ROOM_FOLDERS.house}: renaming its folder from "${library.source_path}" to "${view.renameTo}".`,
    ipAddress: ip || undefined
  });
  return roomView("house");
}

/** Move one room between its three states. `own` is what "own" needs on the
 *  rooms that take something: a folder for the Recycle Bin and thumbnails, a
 *  gallery library's id for the Inbox and App files. Throws
 *  AppStorageError or TrashError with the status the route should answer with. */
export function switchRoom(room: AppRoom, mode: AppRoomMode, own: string | null, userId: string, ip = ""): RoomView {
  const ownPath = own;
  switch (room) {
    case "trash": switchTrash(mode, ownPath, userId); break;
    case "thumbnails": switchThumbnails(mode, ownPath, userId); break;
    case "renders": switchRenders(mode, userId); break;
    case "backups": switchBackups(mode, userId); break;
    case "inbox": switchInbox(mode, own, userId, ip); break;
    case "house": switchHouse(mode, own, userId, ip); break;
  }
  logActivity({
    event: "config.updated",
    actorUserId: userId,
    targetType: "setting",
    targetId: `app_storage.${room}`,
    detail: `${APP_ROOM_FOLDERS[room]}: ${mode === "app" ? "uses App storage" : mode === "own" ? `uses ${ownPath ?? "its own place"}` : "turned off"}.`,
    ipAddress: ip || undefined
  });
  return roomView(room);
}

/** Once at startup (3.88.0): an install with App storage whose Renders row was
 *  never touched used to keep renders inside the thumbnail folder; the room now
 *  defaults to App storage, so whatever the thumbnail folder still holds in the
 *  render buckets is carried into `<App storage>/Renders` as a storage move
 *  task. A row switched to "own" is left alone. Returns the status when a move
 *  was queued, null when there was nothing to do. */
export function migrateRendersIntoAppStorage(): StorageMoveStatus | null {
  const appPath = appRoomPath("renders");
  if (!appPath || appRoomMode("renders") !== undefined) return null;
  const thumbnails = ownThumbnailPathValue() || null;
  if (!thumbnails || samePath(thumbnails, appPath)) return null;
  if (!RENDER_BUCKETS.some((bucket) => dirHasEntries(path.join(thumbnails, bucket)))) return null;
  fs.mkdirSync(appPath, { recursive: true });
  const status = enqueueStorageMove({ kind: "renders", room: "renders", label: "Renders", from: thumbnails, to: appPath, actorUserId: null });
  logActivity({
    event: "config.updated",
    actorUserId: null,
    targetType: "setting",
    targetId: "app_storage.renders",
    detail: `Renders: uses App storage from now on (the room's new default); carrying the render buckets from ${thumbnails} to ${appPath}.`
  });
  return status;
}

export function statusOf(err: unknown): number {
  if (err instanceof AppStorageError) return err.statusCode;
  if (err instanceof TrashError) return err.statusCode;
  return 400;
}

/** True when a path resolves into App storage — for the pages that say
 *  "made in App storage" beside a library. */
export { isInsideAppStorage, resolveAppLocation };
