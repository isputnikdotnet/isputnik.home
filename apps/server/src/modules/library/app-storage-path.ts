// Choosing, changing or clearing the App storage folder itself, and carrying the
// rooms that use it along (or leaving them where they are).
import fs from "node:fs";
import path from "node:path";
import { db, logActivity } from "../../db.js";
import { config } from "../../config.js";
import {
  APP_ROOMS,
  APP_ROOM_FOLDERS,
  appRoomMode,
  appRoomFolderIn,
  getAppStorageSetting,
  saveAppStorageSetting,
  type AppRoom
} from "../../core/app-storage.js";
import {
  configuredThumbnailPathValue,
  thumbnailPathSettingKey,
  validateThumbnailPath
} from "./shared/thumbnail.js";
import { getOwnTrashRootSetting, setTrashRootSetting } from "./shared/trash-settings.js";
import { startTrashMove } from "./shared/trash-move.js";
import { moveEntryAcross, startFolderMove } from "./shared/folder-move.js";
import { anyStorageMoveActive, assertMoveTargetFree, enqueueStorageMove } from "./shared/storage-move.js";
import { AppStorageError, libraryAt, samePath, validateAppStoragePath, type GalleryLibraryRow } from "./app-storage.js";
import { appStorageView, roomView, type AppStorageView } from "./app-storage-rooms.js";
import { switchRoom } from "./app-storage-switch.js";

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
