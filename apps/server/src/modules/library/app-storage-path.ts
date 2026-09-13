// Choosing, changing or clearing the App storage folder itself, and carrying the
// rooms that use it along (or leaving them where they are).
import path from "node:path";
import { logActivity } from "../../db.js";
import {
  APP_ROOMS,
  APP_ROOM_FOLDERS,
  appRoomFolderIn,
  getAppStorageSetting,
  saveAppStorageSetting,
  type AppRoom
} from "../../core/app-storage.js";
import { configuredThumbnailPathValue, validateThumbnailPath } from "./shared/thumbnail.js";
import { anyStorageMoveActive, assertMoveTargetFree, enqueueStorageMove } from "./shared/storage-move.js";
import { AppStorageError, libraryAt, samePath, validateAppStoragePath, type GalleryLibraryRow } from "./app-storage.js";
import { appStorageView, roomView, type AppStorageView } from "./app-storage-rooms.js";
import { ownMapDataDir } from "../maps/storage.js";

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

/** Record, change or clear the App storage folder. A room that uses the current
 *  folder is carried to the new one when asked (`carry[room]` true, the default),
 *  or leaves App storage: a library room's library stays where it is, and renders
 *  and map data go back to their default place (the thumbnail folder, the room's
 *  own folder). Every carry is a storage move task (storage-move.ts) queued after
 *  the setting changes — a library flips its path only once its files are across
 *  and verified. Every check happens before anything changes. Clearing the folder
 *  leaves every room. */
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

  // Renders that leave go back into the thumbnail folder (system data's).
  const thumbnailsAfter = configuredThumbnailPathValue() || null;
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

  // The rooms that leave record their own place; the rest keep their mode and
  // resolve into the new folder as soon as it is saved.
  const modes = { ...current.rooms };
  for (const s of steps) {
    if (s.carry) continue;
    switch (s.room) {
      case "renders":
        // Left behind means "inside the thumbnail folder", which must be said:
        // blank would read as App storage once there is one — the new folder.
        modes.renders = "own";
        break;
      case "maps":
        // Likewise: left behind means the room's own folder, said explicitly.
        modes.maps = "own";
        break;
      case "inbox":
      case "house":
        // The library stays; the row reads it as the room's own library.
        break;
    }
  }
  saveAppStorageSetting({ path: wanted, rooms: wanted ? modes : {} }, userId);

  // Now the tasks, in the order they should run: the libraries (which flip their
  // path only when across), then the render buckets and map data.
  if (wanted) {
    for (const { library, room } of libraryMoves) {
      enqueueStorageMove({ kind: "library", room, label: library.name, from: library.source_path, to: newRoom(room), libraryId: library.id, actorUserId: userId });
    }
  }
  if (renders) {
    const to = renders.carry ? newRoom("renders") : validateThumbnailPath(thumbnailsAfter!);
    enqueueStorageMove({ kind: "renders", room: "renders", label: "Renders", from: oldRoom("renders"), to, actorUserId: userId });
  }
  // Map data goes with the folder, or back to its own place — the Renders rule.
  // An empty room queues nothing: enqueueStorageMove refuses a move with no
  // units, which matters here because the room follows App storage on every
  // install, maps turned on or not.
  const maps = step("maps");
  if (maps) {
    const to = maps.carry ? newRoom("maps") : ownMapDataDir();
    enqueueStorageMove({ kind: "maps", room: "maps", label: "Map data", from: oldRoom("maps"), to, actorUserId: userId });
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
