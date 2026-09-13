// App storage's switch — docs/system-data-plan.md, phase 3 (decisions 7–14).
//
// One switch for the Photo Inbox, App files, Renders and Map data. On, the app
// makes the two system libraries and the folders in one place: `app-storage`
// inside system data, or a custom folder. Off, none of them exist — refused while
// any of them still holds something the family would lose. Change moves the whole
// of App storage; a part left outside it (by the 4.6 conversion, or made before)
// offers to move in on its own.
//
// Every move is a storage move task (shared/storage-move.ts). The settings flip
// first for the plain folders (renders, map data) and the files follow; a library
// flips its source path only once its files are across and verified.
import fs from "node:fs";
import path from "node:path";
import { db, logActivity } from "../../db.js";
import {
  APP_ROOMS,
  APP_ROOM_FOLDERS,
  appRoomFolderIn,
  appStorageFolderFor,
  getAppStorageSetting,
  LEGACY_ROOM_FOLDERS,
  resolveAppLocation,
  saveAppStorageSetting,
  type AppFolderPart,
  type AppRoom,
  type AppStorageSetting,
  type AppStorageWhere
} from "../../core/app-storage.js";
import { diskSpace, getSystemDataPath } from "../../core/system-data.js";
import { configuredThumbnailPathValue, RENDER_BUCKETS } from "./shared/thumbnail.js";
import {
  anyStorageMoveActive,
  assertMoveTargetFree,
  cancelStorageMove,
  enqueueStorageMove,
  retryStorageMove,
  storageMoveStatus,
  type StorageMoveStatus
} from "./shared/storage-move.js";
import { createLibraryRecord } from "./shared/library-crud.js";
import { scanLibraryNow } from "./shared/media-types.js";
import { HOUSE_FOLDERS, ensureAudioScanExtensions } from "./gallery/house-library.js";
import { setSystemLibraryRole } from "./gallery/system-libraries.js";
import { inboxReviewerCount } from "./gallery/inbox-reviewers.js";
import { deleteGalleryLibraryRecord } from "./gallery/library-delete.js";
import { pendingBucketMusic } from "./gallery/music.js";
import {
  AppStorageError,
  dirHasEntries,
  folderStats,
  itemCount,
  libraryAt,
  libraryWithRole,
  samePath,
  validateAppStorageFolder,
  type GalleryLibraryRow
} from "./app-storage.js";
import { MAP_DATA_FOLDERS, clearTileCache, ownMapDataDir } from "../maps/storage.js";
import { getMapSettings, saveMapSettings } from "../maps/settings.js";
import { placesDir, removePlaces } from "../maps/places/dataset.js";
import { placesBuildStatus } from "../maps/places/job.js";

// The slideshow render queue's job type, named here rather than imported: the queue
// module pulls in the whole renderer, and all this needs is whether a render is waiting.
const RENDER_JOB_TYPE = "gallery-slideshow-render";

const ROLE_OF: Record<"inbox" | "house", "inbox" | "app-files"> = { inbox: "inbox", house: "app-files" };

export interface AppStoragePart {
  part: AppRoom;
  /** Where the part is now — or, while App storage is off, where it would be. */
  folder: string | null;
  /** The part is in App storage's folder. False while App storage is off. */
  inside: boolean;
  /** The system library behind the Inbox and App files parts. */
  library: { id: string; name: string } | null;
  /** reviewers: people and groups an admin named on the Inbox (phase 4); Everyone counts as one.
   *  unowned: App files items outside the app's own folders — photos a library
   *  nominated before 4.6 already held. Nothing owns them, so only admins see them. */
  counts: { waiting?: number; files?: number; tracks?: number; reviewers?: number; unowned?: number };
  move: StorageMoveStatus;
  /** App files under its former folder name ("Made in the app"): the name it
   *  would be renamed to. Null everywhere else. */
  renameTo: string | null;
}

export interface AppStorageView {
  enabled: boolean;
  where: AppStorageWhere;
  /** The custom folder, remembered while "system" is chosen. */
  customPath: string | null;
  /** App storage's folder while on; where it would be while off (null when that
   *  needs system data, or a custom folder, not yet chosen). */
  folder: string | null;
  /** Where "In system data" would put it, for the choice's hint. */
  systemFolder: string | null;
  systemDataSet: boolean;
  space: { free: number; total: number } | null;
  parts: AppStoragePart[];
  /** A storage move is queued or running: App storage must not change under it. */
  moving: boolean;
}

// ── The view ────────────────────────────────────────────────────────────────

/** App files items outside every folder the app writes to: owned by nothing, so
 *  only admins see them (decision 22). A library nominated before 4.6 may hold a
 *  whole photo collection like this; the row says so. */
function unownedAppFiles(libraryId: string | null): number {
  if (!libraryId) return 0;
  const folders = Object.values(HOUSE_FOLDERS);
  const outside = folders.map(() => "NOT (folder_path = ? OR substr(folder_path, 1, ?) = ?)").join(" AND ");
  const args = folders.flatMap((folder) => [folder, folder.length + 1, `${folder}/`]);
  return (db.prepare(`SELECT COUNT(*) AS n FROM library_items WHERE library_id = ? AND deleted_at IS NULL AND ${outside}`)
    .get(libraryId, ...args) as { n: number }).n;
}

function partLibrary(part: "inbox" | "house"): GalleryLibraryRow | null {
  return libraryWithRole(ROLE_OF[part]);
}

function partView(part: AppRoom, setting: AppStorageSetting, root: string | null): AppStoragePart {
  const base = { part, move: storageMoveStatus(part), renameTo: null as string | null };
  if (part === "inbox" || part === "house") {
    const library = partLibrary(part);
    const expected = root ? appRoomFolderIn(root, part) : null;
    const inside = Boolean(setting.enabled && library && root && samePath(path.dirname(library.source_path), root));
    const legacy = LEGACY_ROOM_FOLDERS[part];
    const renameTo = inside && library && legacy && path.basename(library.source_path) === legacy
      ? path.join(root!, APP_ROOM_FOLDERS[part])
      : null;
    const count = library ? itemCount(library.id) : 0;
    return {
      ...base,
      folder: library?.source_path ?? expected,
      inside,
      library: library ? { id: library.id, name: library.name } : null,
      counts: part === "inbox" ? { waiting: count, reviewers: inboxReviewerCount() } : { files: count, unowned: unownedAppFiles(library?.id ?? null) },
      renameTo
    };
  }
  const outside = setting.enabled && setting.outside[part] === true;
  const own = part === "renders" ? (configuredThumbnailPathValue() || null) : ownMapDataDir();
  const folder = outside ? own : root ? path.join(root, APP_ROOM_FOLDERS[part]) : null;
  return {
    ...base,
    folder,
    inside: setting.enabled && !outside && root !== null,
    library: null,
    counts: part === "renders" ? { tracks: pendingBucketMusic() } : {}
  };
}

export function appStorageView(): AppStorageView {
  const setting = getAppStorageSetting();
  const root = appStorageFolderFor(setting.where, setting.path);
  const systemFolder = appStorageFolderFor("system", null);
  return {
    enabled: setting.enabled,
    where: setting.where,
    customPath: setting.path,
    folder: root,
    systemFolder,
    systemDataSet: getSystemDataPath() !== null,
    space: diskSpace(root ?? systemFolder ?? getSystemDataPath() ?? "."),
    parts: APP_ROOMS.map((part) => partView(part, setting, root)),
    moving: anyStorageMoveActive()
  };
}

// ── Choosing where ──────────────────────────────────────────────────────────

export interface AppStorageChoice {
  where: AppStorageWhere;
  path?: string | null;
}

/** The folder a choice means, vetted. "system" needs system data; "custom" needs
 *  a folder that passes validateAppStorageFolder. */
function folderForChoice(choice: AppStorageChoice): string {
  if (choice.where === "system") {
    const folder = appStorageFolderFor("system", null);
    if (!folder) throw new AppStorageError("Choose system data first: App storage goes inside it.", 409);
    fs.mkdirSync(folder, { recursive: true });
    return fs.realpathSync(folder);
  }
  if (!choice.path?.trim()) throw new AppStorageError("Type the folder App storage should use.");
  return validateAppStorageFolder(choice.path);
}

function requireNoMove(): void {
  if (anyStorageMoveActive()) {
    throw new AppStorageError("A storage move is running right now. Wait for it to finish, or cancel it on the Tasks page, before changing App storage.", 409);
  }
}

function thumbnailFolder(): string | null {
  const value = configuredThumbnailPathValue();
  return value ? path.resolve(value) : null;
}

// ── Switching on ────────────────────────────────────────────────────────────

/** Make whichever system library is missing, in its folder under `root`: adopt an
 *  ordinary gallery library already sitting at that folder, or create one. A part
 *  whose library exists (anywhere) is left as it is. Returns the libraries made. */
function ensureSystemLibraries(root: string, userId: string, ip: string): string[] {
  const made: string[] = [];
  for (const part of ["inbox", "house"] as const) {
    const role = ROLE_OF[part];
    if (libraryWithRole(role)) continue;
    const folder = appRoomFolderIn(root, part);
    fs.mkdirSync(folder, { recursive: true });
    const existing = libraryAt(folder);
    let libraryId: string;
    if (existing) {
      if (existing.role) throw new AppStorageError(`"${existing.name}" at ${folder} already is a system library.`, 409);
      setSystemLibraryRole(role, existing.id);
      libraryId = existing.id;
    } else {
      const result = createLibraryRecord({
        type: "gallery",
        data: {
          name: APP_ROOM_FOLDERS[part],
          sourcePath: folder,
          // The Inbox ignores these: its reviewers decide who sees it (phase 4).
          // App files takes what the family makes.
          visibility: "public",
          publicRole: "member",
          mode: "managed"
        },
        userId,
        ip,
        role
      });
      if ("error" in result) throw new AppStorageError(result.error, result.status);
      libraryId = result.libraryId;
    }
    if (part === "house") ensureAudioScanExtensions(libraryId);
    scanLibraryNow("gallery", libraryId);
    made.push(APP_ROOM_FOLDERS[part]);
  }
  return made;
}

/** Carry what a plain-folder part left in its own place into App storage. */
function carryFolderPartIn(part: AppFolderPart, root: string, userId: string | null): void {
  const to = path.join(root, APP_ROOM_FOLDERS[part]);
  fs.mkdirSync(to, { recursive: true });
  if (part === "renders") {
    const from = thumbnailFolder();
    if (from && RENDER_BUCKETS.some((bucket) => dirHasEntries(path.join(from, bucket)))) {
      enqueueStorageMove({ kind: "renders", room: "renders", label: "Renders", from, to, actorUserId: userId });
    }
    return;
  }
  const from = ownMapDataDir();
  if (!samePath(from, to) && MAP_DATA_FOLDERS.some((folder) => dirHasEntries(path.join(from, folder)))) {
    enqueueStorageMove({ kind: "maps", room: "maps", label: "Map data", from, to, actorUserId: userId });
  }
}

export function turnOnAppStorage(choice: AppStorageChoice, userId: string, ip = ""): AppStorageView {
  const before = getAppStorageSetting();
  if (before.enabled) throw new AppStorageError("App storage is already on.", 409);
  requireNoMove();
  if (!getSystemDataPath()) {
    throw new AppStorageError("Choose system data first: the libraries App storage makes need somewhere for their thumbnails.", 409);
  }
  const root = folderForChoice(choice);
  for (const part of APP_ROOMS) fs.mkdirSync(appRoomFolderIn(root, part), { recursive: true });

  // On before the libraries are made: their folders are accepted as library
  // sources because they are inside App storage (library-source.ts).
  const next: AppStorageSetting = {
    enabled: true,
    where: choice.where,
    path: choice.where === "custom" ? root : before.path,
    outside: {}
  };
  saveAppStorageSetting(next, userId);
  let made: string[];
  try {
    made = ensureSystemLibraries(root, userId, ip);
  } catch (err) {
    saveAppStorageSetting(before, userId);
    throw err;
  }
  carryFolderPartIn("renders", root, userId);
  carryFolderPartIn("maps", root, userId);

  logActivity({
    event: "config.updated",
    actorUserId: userId,
    targetType: "setting",
    targetId: "app_storage",
    detail: `App storage turned on at ${root}${made.length > 0 ? `; made ${made.join(" and ")}` : ""}.`,
    ipAddress: ip || undefined
  });
  return appStorageView();
}

// ── Switching off ───────────────────────────────────────────────────────────

/** Why App storage cannot be switched off right now, or null when it can. */
export function turnOffRefusal(): string | null {
  const inbox = partLibrary("inbox");
  const house = partLibrary("house");
  const waiting = inbox ? itemCount(inbox.id) : 0;
  if (waiting > 0) {
    return `${waiting === 1 ? "One photo is" : `${waiting} photos are`} still waiting in the Photo Inbox. Keep or discard them first.`;
  }
  const files = house ? itemCount(house.id) : 0;
  if (files > 0) {
    return `App files holds ${files === 1 ? "one file" : `${files} files`} that belong to stories, photos and slideshows. The Contents tab shows what owns each one.`;
  }
  const ids = [inbox?.id, house?.id].filter((id): id is string => Boolean(id));
  if ([inbox, house].some((library) => library?.scan_status === "scanning")) {
    return "A Photo Inbox or App files scan is running. Wait for it to finish first.";
  }
  if (ids.length > 0) {
    const binned = (db.prepare(`SELECT COUNT(*) AS n FROM trashed_items WHERE library_id IN (${ids.map(() => "?").join(",")})`).get(...ids) as { n: number }).n;
    if (binned > 0) {
      return `The Recycle Bin still holds ${binned === 1 ? "one item" : `${binned} items`} from the Photo Inbox or App files. Restore or delete ${binned === 1 ? "it" : "them"} first.`;
    }
  }
  const rendering = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = ? AND status IN ('pending', 'running')").get(RENDER_JOB_TYPE) as { n: number }).n;
  if (rendering > 0) return "A slideshow movie is being rendered. Wait for it to finish first.";
  if (placesBuildStatus().running) return "The place names database is being built. Wait for that to finish first.";
  return null;
}

/** Remove a folder the app made, when nothing but empty folders is left in it. */
function removeIfEmpty(folder: string | null): void {
  if (!folder || !fs.existsSync(folder)) return;
  try {
    if (folderStats(folder).files === 0) fs.rmSync(folder, { recursive: true, force: true });
  } catch {
    /* best-effort: a folder the app cannot remove stays */
  }
}

export function turnOffAppStorage(userId: string, ip = ""): AppStorageView {
  const before = getAppStorageSetting();
  if (!before.enabled) throw new AppStorageError("App storage is already off.", 409);
  requireNoMove();
  const refusal = turnOffRefusal();
  if (refusal) throw new AppStorageError(refusal, 409);
  const root = appStorageFolderFor(before.where, before.path);

  // Map data first, while it still resolves to where it is: kept tiles and place
  // names go (both download again), and caching is off with nowhere to keep them.
  let freedBytes = 0;
  const maps = getMapSettings();
  if (maps.cache) saveMapSettings({ ...maps, cache: false }, userId);
  freedBytes += clearTileCache();
  if (fs.existsSync(placesDir())) freedBytes += removePlaces();
  const mapsFrom = resolveAppLocation("maps");
  const rendersFrom = resolveAppLocation("renders");

  // The two system libraries are empty (checked above): their rows go, and their
  // folders with them when nothing but empty subfolders is left.
  const removed: string[] = [];
  for (const part of ["inbox", "house"] as const) {
    const library = partLibrary(part);
    if (!library) continue;
    deleteGalleryLibraryRecord(library.id);
    removeIfEmpty(library.source_path);
    removed.push(library.name);
  }

  saveAppStorageSetting({ enabled: false, where: before.where, path: before.path, outside: {} }, userId);

  // What must survive leaves as tasks: music still waiting to be imported goes back
  // into the thumbnail folder, the sign-in location databases to map data's own folder.
  const thumbs = thumbnailFolder();
  if (rendersFrom && thumbs && RENDER_BUCKETS.some((bucket) => dirHasEntries(path.join(rendersFrom, bucket)))) {
    enqueueStorageMove({ kind: "renders", room: "renders", label: "Renders", from: rendersFrom, to: thumbs, actorUserId: userId });
  } else {
    removeIfEmpty(rendersFrom);
  }
  if (mapsFrom && dirHasEntries(path.join(mapsFrom, "Locations"))) {
    enqueueStorageMove({ kind: "maps", room: "maps", label: "Map data", from: mapsFrom, to: ownMapDataDir(), actorUserId: userId });
  } else {
    removeIfEmpty(mapsFrom);
  }
  if (before.where === "system") removeIfEmpty(root);

  logActivity({
    event: "config.updated",
    actorUserId: userId,
    targetType: "setting",
    targetId: "app_storage",
    detail: `App storage turned off${removed.length > 0 ? `; removed the empty ${removed.join(" and ")}` : ""}${freedBytes > 0 ? `; freed ${freedBytes} bytes of map data` : ""}.`,
    ipAddress: ip || undefined
  });
  return appStorageView();
}

// ── Changing where ──────────────────────────────────────────────────────────

/** While off: remember the choice for when it is switched on. While on: move App
 *  storage there, every part that is inside it carried along as a task; a part
 *  outside it stays where it is. Every check happens before anything changes. */
export function changeAppStorage(choice: AppStorageChoice, userId: string, ip = ""): AppStorageView {
  const before = getAppStorageSetting();
  if (!before.enabled) {
    const customPath = choice.where === "custom" ? folderForChoice(choice) : before.path;
    saveAppStorageSetting({ ...before, where: choice.where, path: customPath }, userId);
    return appStorageView();
  }
  requireNoMove();
  const oldRoot = appStorageFolderFor(before.where, before.path);
  const newRoot = folderForChoice(choice);
  const next: AppStorageSetting = { ...before, where: choice.where, path: choice.where === "custom" ? newRoot : before.path };
  if (samePath(oldRoot, newRoot)) {
    saveAppStorageSetting(next, userId);
    return appStorageView();
  }

  const libraryMoves: { library: GalleryLibraryRow; part: "inbox" | "house"; to: string }[] = [];
  for (const part of ["inbox", "house"] as const) {
    const library = partLibrary(part);
    if (!library || !oldRoot || !samePath(path.dirname(library.source_path), oldRoot)) continue;
    if (library.scan_status === "scanning") {
      throw new AppStorageError(`"${library.name}" is being scanned right now. Wait for the scan to finish before moving App storage.`, 409);
    }
    const to = path.join(newRoot, path.basename(library.source_path));
    assertMoveTargetFree(to, `"${library.name}"`);
    libraryMoves.push({ library, part, to });
  }
  const folderMoves = (["renders", "maps"] as const)
    .filter((part) => !before.outside[part] && oldRoot)
    .map((part) => ({ part, from: path.join(oldRoot!, APP_ROOM_FOLDERS[part]), to: path.join(newRoot, APP_ROOM_FOLDERS[part]) }));

  saveAppStorageSetting(next, userId);
  for (const { library, part, to } of libraryMoves) {
    enqueueStorageMove({ kind: "library", room: part, label: library.name, from: library.source_path, to, libraryId: library.id, actorUserId: userId });
  }
  for (const { part, from, to } of folderMoves) {
    fs.mkdirSync(to, { recursive: true });
    enqueueStorageMove({ kind: part, room: part, label: APP_ROOM_FOLDERS[part], from, to, actorUserId: userId });
  }

  logActivity({
    event: "config.updated",
    actorUserId: userId,
    targetType: "setting",
    targetId: "app_storage",
    detail: `App storage moving from ${oldRoot} to ${newRoot}.`,
    ipAddress: ip || undefined
  });
  return appStorageView();
}

// ── A part outside App storage ──────────────────────────────────────────────

/** Bring one part into App storage: a library outside it moves in whole (made,
 *  when it does not exist yet); renders or map data in their own place follow as
 *  a task once the setting points inside. */
export function movePartIn(part: AppRoom, userId: string, ip = ""): AppStorageView {
  const setting = getAppStorageSetting();
  if (!setting.enabled) throw new AppStorageError("Switch App storage on first.", 409);
  requireNoMove();
  const root = appStorageFolderFor(setting.where, setting.path);
  if (!root) throw new AppStorageError("Choose system data first: App storage goes inside it.", 409);

  if (part === "inbox" || part === "house") {
    const library = partLibrary(part);
    if (!library) {
      ensureSystemLibraries(root, userId, ip);
      return appStorageView();
    }
    if (samePath(path.dirname(library.source_path), root)) return appStorageView();
    if (library.scan_status === "scanning") {
      throw new AppStorageError(`"${library.name}" is being scanned right now. Wait for the scan to finish before moving it.`, 409);
    }
    const to = appRoomFolderIn(root, part);
    assertMoveTargetFree(to, `"${library.name}"`);
    enqueueStorageMove({ kind: "library", room: part, label: library.name, from: library.source_path, to, libraryId: library.id, actorUserId: userId });
  } else {
    if (!setting.outside[part]) return appStorageView();
    const outside = { ...setting.outside };
    delete outside[part];
    saveAppStorageSetting({ ...setting, outside }, userId);
    carryFolderPartIn(part, root, userId);
  }
  logActivity({
    event: "config.updated",
    actorUserId: userId,
    targetType: "setting",
    targetId: `app_storage.${part}`,
    detail: `${APP_ROOM_FOLDERS[part]}: moving into App storage at ${root}.`,
    ipAddress: ip || undefined
  });
  return appStorageView();
}

/** Rename App files' folder from its former name ("Made in the app") to the
 *  current one: the same library move task, the library following its folder. A
 *  library named after the old folder takes the new name too. */
export function renameAppFilesFolder(userId: string, ip = ""): AppStorageView {
  requireNoMove();
  const view = appStorageView().parts.find((entry) => entry.part === "house")!;
  const library = partLibrary("house");
  if (!view.renameTo || !library) {
    throw new AppStorageError(`The ${APP_ROOM_FOLDERS.house} folder already has its current name.`, 409);
  }
  if (library.scan_status === "scanning") {
    throw new AppStorageError(`"${library.name}" is being scanned right now. Wait for the scan to finish before renaming its folder.`, 409);
  }
  assertMoveTargetFree(view.renameTo, `"${library.name}"`);
  enqueueStorageMove({ kind: "library", room: "house", label: library.name, from: library.source_path, to: view.renameTo, libraryId: library.id, actorUserId: userId });
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
  return appStorageView();
}

export function retryPartMove(part: AppRoom, userId: string): AppStorageView {
  retryStorageMove(part, userId);
  return appStorageView();
}

export function cancelPartMove(part: AppRoom): AppStorageView {
  cancelStorageMove(part);
  return appStorageView();
}

/** At startup: App storage is on but a system library is missing (an install the
 *  4.6 conversion switched on, say). Made in its folder, by the first admin. */
export function ensureAppStorageParts(): string[] {
  const setting = getAppStorageSetting();
  if (!setting.enabled) return [];
  const root = appStorageFolderFor(setting.where, setting.path);
  if (!root || !getSystemDataPath()) return [];
  if (libraryWithRole("inbox") && libraryWithRole("app-files")) return [];
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
  if (!admin) return [];
  for (const part of APP_ROOMS) fs.mkdirSync(appRoomFolderIn(root, part), { recursive: true });
  return ensureSystemLibraries(root, admin.id, "");
}
