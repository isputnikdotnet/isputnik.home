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
  appRoomPath,
  getAppStorageSetting,
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
import { startTrashMove, trashMoveStatus, type TrashMoveStatus } from "./shared/trash-move.js";
import { folderMoveStatus, moveEntryAcross, startFolderMove, type FolderMoveStatus } from "./shared/folder-move.js";
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
  /** The library behind a library room (Inbox, Made in the app). */
  library: { id: string; name: string } | null;
  /** What a switch would carry: bin items, uploaded tracks, waiting photos. */
  counts: { itemsInBin?: number; tracks?: number; clips?: number; waiting?: number; backups?: number };
  /** The bin move, for the Recycle Bin row. */
  move?: TrashMoveStatus;
  /** The thumbnail move, for the Thumbnails row (docs/app-storage-plan.md, phase 3). */
  folderMove?: FolderMoveStatus;
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
    move: trashMoveStatus()
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
    counts: { waiting: shown ? itemCount(shown.id) : 0 }
  };
}

function houseRoom(): RoomView {
  const appPath = appRoomPath("house");
  const house = getHouseLibrary();
  const usesApp = house !== null && samePath(house.source_path, appPath);
  return {
    room: "house",
    mode: usesApp ? "app" : house ? "own" : "off",
    resolvedPath: house?.source_path ?? null,
    appPath,
    holdsFiles: usesApp,
    library: house ? { id: house.id, name: house.name } : null,
    counts: {}
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
    folderMove: folderMoveStatus()
  };
}

function rendersRoom(): RoomView {
  const appPath = appRoomPath("renders");
  const usesApp = appRoomMode("renders") === "app" && appPath !== null;
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
    counts: { tracks, clips }
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
    counts: { backups }
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
  const roomPaths = new Set(Object.values(APP_ROOM_FOLDERS).map((folder) => path.join(real, folder)));
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

/** Move a whole folder — rename, or copy then delete across volumes — refusing a
 *  target that exists so nothing is merged into by accident. Returns the undo. */
function moveWholeFolder(from: string, to: string, what: string): () => void {
  if (fs.existsSync(to)) throw new AppStorageError(`A folder already exists at ${to}. Move it aside first.`, 409);
  if (!fs.existsSync(from)) {
    fs.mkdirSync(to, { recursive: true });
    return () => { try { fs.rmdirSync(to); } catch { /* not empty any more */ } };
  }
  try {
    moveEntryAcross(path.dirname(from), path.dirname(to), path.basename(from));
  } catch (err) {
    throw new AppStorageError(`Could not move ${what}: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
  // Both folders have the same name, so a plain rename back is the exact reverse.
  return () => moveEntryAcross(path.dirname(to), path.dirname(from), path.basename(to));
}

/** Carry every entry of one folder into another, merging (backups have no
 *  structure the app relies on). Returns the undo, which moves them back. */
function moveFolderEntries(from: string, to: string, what: string): () => void {
  if (samePath(from, to) || !fs.existsSync(from)) return () => undefined;
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
  return () => { for (const name of carried) moveEntryAcross(to, from, name); };
}

/** Carry a library room's library (the Photo Inbox, Made in the app) to the new
 *  folder: its folder moves, and the library's source path follows. Item paths
 *  are relative to it, so they stay right; the bin rows that name the library's
 *  own folder are updated too. */
function moveRoomLibrary(room: "inbox" | "house", from: string, to: string): () => void {
  const library = libraryAt(from);
  if (!library) return moveWholeFolder(from, to, APP_ROOM_FOLDERS[room]);
  if (library.scan_status === "scanning") {
    throw new AppStorageError(`"${library.name}" is being scanned right now. Wait for the scan to finish before moving App storage.`, 409);
  }
  const undoFiles = moveWholeFolder(from, to, `"${library.name}"`);
  const point = (source: string) => {
    db.prepare("UPDATE libraries SET source_path = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(source, library.id);
    db.prepare("UPDATE trashed_items SET source_path = ? WHERE library_id = ?").run(source, library.id);
  };
  point(to);
  return () => { point(from); undoFiles(); };
}

/** Record, change or clear the App storage folder. A room that uses the current
 *  folder is carried to the new one when asked (`carry[room]` true, the default),
 *  or leaves App storage: the Recycle Bin and thumbnails keep their old folder as
 *  their own place, a library room's library stays where it is, and renders and
 *  backups go back to their default place (the thumbnail folder, the backup
 *  folder), since they have no place of their own. The Recycle Bin and the
 *  thumbnails are carried by their background moves; everything else moves before
 *  the setting changes, and a failure puts back what had moved. Clearing the
 *  folder leaves every room. A fresh install, one with no library yet, also gets
 *  the Recycle Bin room switched on (decision 9). */
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
  if (steps.length > 0) {
    if (trashMoveStatus().running) {
      throw new AppStorageError("The bin is being moved right now. Wait for it to finish, or cancel it, before changing App storage.", 409);
    }
    if (folderMoveStatus().running) {
      throw new AppStorageError("The thumbnails are being moved right now. Wait for that to finish, or cancel it, before changing App storage.", 409);
    }
  }
  const oldRoom = (room: AppRoom) => path.join(before!, APP_ROOM_FOLDERS[room]);
  const newRoom = (room: AppRoom) => path.join(wanted!, APP_ROOM_FOLDERS[room]);

  // Where the thumbnails will be once this is done — renders that leave go there.
  const thumbs = step("thumbnails");
  const thumbnailsAfter = thumbs ? (thumbs.carry ? newRoom("thumbnails") : oldRoom("thumbnails")) : (configuredThumbnailPathValue() || null);
  const renders = step("renders");
  if (renders && !renders.carry && !thumbnailsAfter) {
    throw new AppStorageError("There is no thumbnail folder for renders and music to go back to.", 409);
  }

  // The moves that happen now, before the setting changes, each with its undo.
  const undo: (() => void)[] = [];
  try {
    for (const room of ["inbox", "house"] as const) {
      const s = step(room);
      if (s?.carry) undo.push(moveRoomLibrary(room, oldRoom(room), newRoom(room)));
    }
    if (renders) {
      const from = oldRoom("renders");
      const to = renders.carry ? newRoom("renders") : validateThumbnailPath(thumbnailsAfter!);
      const moved = moveRenderBuckets(from, to);
      if (moved > 0) undo.push(() => { moveRenderBuckets(to, from); });
    }
    const backups = step("backups");
    if (backups) {
      const to = backups.carry ? newRoom("backups") : path.resolve(config.backupPath);
      fs.mkdirSync(to, { recursive: true });
      undo.push(moveFolderEntries(oldRoom("backups"), to, "the backups"));
    }
  } catch (err) {
    for (const back of undo.reverse()) { try { back(); } catch { /* reported below as what it was */ } }
    throw err;
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
      case "backups":
        delete modes[s.room];
        break;
      case "inbox":
      case "house":
        // The library stays; the row reads it as the room's own library.
        break;
    }
  }
  saveAppStorageSetting({ path: wanted, rooms: wanted ? modes : {} }, userId);

  // The two big rooms are carried in the background, now that the setting says
  // where they are going.
  if (wanted) {
    if (step("trash")?.carry) {
      fs.mkdirSync(newRoom("trash"), { recursive: true });
      startTrashMove();
    }
    if (thumbs?.carry) {
      fs.mkdirSync(newRoom("thumbnails"), { recursive: true });
      startFolderMove(oldRoom("thumbnails"), newRoom("thumbnails"));
    }
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

/** Carry the render buckets (uploaded music, finished slideshows, legacy
 *  narration) from one root to another. Rename first; across volumes copy
 *  everything, then delete, and if any copy fails put nothing back to guess at —
 *  the copied part is removed and the move is refused whole. */
export function moveRenderBuckets(from: string, to: string): number {
  if (samePath(from, to)) return 0;
  const present = RENDER_BUCKETS.filter((bucket) => fs.existsSync(path.join(from, bucket)));
  if (present.length === 0) return 0;
  fs.mkdirSync(to, { recursive: true });
  for (const bucket of present) {
    if (fs.existsSync(path.join(to, bucket))) {
      throw new AppStorageError(`A "${bucket}" folder already exists in ${to}. Move it aside first.`, 409);
    }
  }
  const copied: string[] = [];
  try {
    for (const bucket of present) {
      const source = path.join(from, bucket);
      const target = path.join(to, bucket);
      try {
        fs.renameSync(source, target);
        continue;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      }
      fs.cpSync(source, target, { recursive: true });
      copied.push(bucket);
    }
  } catch (err) {
    for (const bucket of copied) fs.rmSync(path.join(to, bucket), { recursive: true, force: true });
    throw new AppStorageError(`Could not move the files: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
  for (const bucket of copied) fs.rmSync(path.join(from, bucket), { recursive: true, force: true });
  return present.length;
}

function switchTrash(mode: AppRoomMode, ownPath: string | null, userId: string): void {
  if (trashMoveStatus().running) {
    throw new AppStorageError("The bin is being moved right now. Wait for it to finish, or cancel it, before changing the location again.", 409);
  }
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
  startTrashMove();
}

function switchThumbnails(mode: AppRoomMode, ownPath: string | null, userId: string): void {
  if (mode === "off") throw new AppStorageError("Thumbnails need a folder; choose App storage or one of your own.");
  if (folderMoveStatus().running) {
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
  if (before && !samePath(before, after)) startFolderMove(before, after);
}

function switchRenders(mode: AppRoomMode, userId: string): void {
  if (mode === "off") throw new AppStorageError("Renders and music always live somewhere: App storage, or inside the thumbnail folder.");
  const before = getRendersRoot();
  if (mode === "app") {
    const appPath = requireAppPath("renders");
    moveRenderBuckets(before, appPath);
    setAppRoomMode("renders", "app", userId);
  } else {
    const thumbnails = configuredThumbnailPathValue();
    if (!thumbnails) throw new AppStorageError("There is no thumbnail folder for renders and music to go back to.");
    moveRenderBuckets(before, validateThumbnailPath(thumbnails));
    setAppRoomMode("renders", undefined, userId);
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
      throw new AppStorageError(`"${library.name}" is the Made in the app library; it holds what the family makes, not what is waiting for review.`, 409);
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
  let libraryId: string;
  if (existing) {
    if (parsePolicy(existing.policy_json).inbox === true) {
      throw new AppStorageError(`"${existing.name}" at that folder is a Photo Inbox, so it cannot also be the Made in the app library.`, 409);
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

/** Move one room between its three states. `own` is what "own" needs on the
 *  rooms that take something: a folder for the Recycle Bin and thumbnails, a
 *  gallery library's id for the Inbox and Made in the app. Throws
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

export function statusOf(err: unknown): number {
  if (err instanceof AppStorageError) return err.statusCode;
  if (err instanceof TrashError) return err.statusCode;
  return 400;
}

/** True when a path resolves into App storage — for the pages that say
 *  "made in App storage" beside a library. */
export { isInsideAppStorage, resolveAppLocation };
