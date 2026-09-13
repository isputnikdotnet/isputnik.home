import fs from "node:fs";
import path from "node:path";
import { db, logActivity } from "../../db.js";
import {
  APP_ROOM_FOLDERS,
  appRoomMode,
  appRoomPath,
  LEGACY_ROOM_FOLDERS,
  setAppRoomMode,
  type AppRoom,
  type AppRoomMode
} from "../../core/app-storage.js";
import {
  configuredThumbnailPathValue,
  getRendersRoot,
  ownThumbnailPathValue,
  RENDER_BUCKETS,
  validateThumbnailPath
} from "./shared/thumbnail.js";
import { assertMoveTargetFree, enqueueStorageMove, storageMoveStatus, type StorageMoveStatus } from "./shared/storage-move.js";
import { createLibraryRecord } from "./shared/library-crud.js";
import { getHouseLibrary, setHouseLibrary } from "./gallery/house-library.js";
import { setSystemLibraryRole } from "./gallery/system-libraries.js";
import { scanLibraryNow } from "./shared/media-types.js";
import {
  AppStorageError,
  dirHasEntries,
  galleryLibraries,
  inboxLibraries,
  itemCount,
  libraryAt,
  samePath,
  type GalleryLibraryRow
} from "./app-storage.js";
import { houseRoom, roomView, type RoomView } from "./app-storage-rooms.js";
import { mapDataDir, ownMapDataDir } from "../maps/storage.js";

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

// ── Switching a room ────────────────────────────────────────────────────────

function requireAppPath(room: AppRoom): string {
  const appPath = appRoomPath(room);
  if (!appPath) throw new AppStorageError("Choose the App storage folder first.");
  fs.mkdirSync(appPath, { recursive: true });
  return appPath;
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

// Map data follows the Renders pattern: the setting flips at once, and whatever
// is already kept follows as a storage move task. The cache keeps working while
// it runs — new tiles land in the new folder, and a tile not yet across is
// fetched again, which costs a request rather than a map.
function switchMaps(mode: AppRoomMode, userId: string): void {
  if (mode === "off") {
    throw new AppStorageError("Map data always lives somewhere: App storage, or its own folder. Whether maps are kept at all is chosen on the Maps page.");
  }
  if (storageMoveStatus("maps").running) {
    throw new AppStorageError("Map data is being moved right now. Wait for that to finish, or cancel it, before changing the room again.", 409);
  }
  const before = mapDataDir();
  let after: string;
  if (mode === "app") {
    after = requireAppPath("maps");
    setAppRoomMode("maps", "app", userId);
  } else {
    after = ownMapDataDir();
    // Recorded as a choice, not left blank: blank means "App storage once there
    // is one", and this admin has asked for the room's own folder.
    setAppRoomMode("maps", "own", userId);
  }
  if (!samePath(before, after)) {
    enqueueStorageMove({ kind: "maps", room: "maps", label: "Map data", from: before, to: after, actorUserId: userId });
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
    // There is one Inbox. Handing the role to another library turns the current
    // one into an ordinary library, so its waiting photos would land on the
    // Timeline unreviewed: refused while any are waiting.
    refuseWhileWaiting(inboxLibraries().find((row) => row.id !== library.id) ?? null);
    setSystemLibraryRole("inbox", library.id);
    return;
  }
  if (mode === "app") {
    if (!appPath) throw new AppStorageError("Choose the App storage folder first.");
    const existing = libraryAt(appPath);
    if (existing) {
      if (existing.role === "app-files") {
        throw new AppStorageError(`"${existing.name}" at that folder is the App files library, so it cannot also be the Photo Inbox.`, 409);
      }
      if (existing.role !== "inbox") {
        refuseWhileWaiting(inboxLibraries().find((row) => row.id !== existing.id) ?? null);
        setSystemLibraryRole("inbox", existing.id);
      }
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
      data: { name: APP_ROOM_FOLDERS.inbox, sourcePath: appPath, visibility: "public", publicRole: "viewer", mode: "managed" },
      userId,
      ip,
      role: "inbox"
    });
    if ("error" in result) throw new AppStorageError(result.error, result.status as number);
    scanLibraryNow("gallery", result.libraryId);
    return;
  }
  // off: the app-made Inbox becomes an ordinary library — refused while photos are
  // still waiting in it, since they would land on the Timeline unreviewed.
  const appInbox = inboxLibraries().find((row) => samePath(row.source_path, appPath));
  if (!appInbox) return;
  refuseWhileWaiting(appInbox);
  setSystemLibraryRole("inbox", null);
}

/** Refuse taking the Inbox role from a library that still has photos waiting in
 *  it: as an ordinary library they would land on the Timeline unreviewed. */
function refuseWhileWaiting(inbox: GalleryLibraryRow | null): void {
  if (!inbox) return;
  const waiting = itemCount(inbox.id);
  if (waiting > 0) {
    throw new AppStorageError(
      `${waiting === 1 ? "One photo is" : `${waiting} photos are`} still waiting in "${inbox.name}". Review or discard them first.`,
      409
    );
  }
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
  if (!existing && own && own.role !== "inbox") {
    queueLibraryMove(own, "house", appPath, userId);
    return;
  }
  let libraryId: string;
  if (existing) {
    if (existing.role === "inbox") {
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
    scanLibraryNow("gallery", libraryId);
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

/** Move one room between its states. `own` is a gallery library's id for the
 *  Inbox and App files. Throws AppStorageError with the status the route should
 *  answer with. */
export function switchRoom(room: AppRoom, mode: AppRoomMode, own: string | null, userId: string, ip = ""): RoomView {
  const ownPath = own;
  switch (room) {
    case "renders": switchRenders(mode, userId); break;
    case "maps": switchMaps(mode, userId); break;
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
