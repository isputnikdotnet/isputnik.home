// Move a folder of one gallery library into another gallery library — the way
// to unmix a library: the family videos that landed in the App files library go
// to Current Phone; a "Slideshow music" folder left in a family library goes to
// App files. The files travel as a storage move task (shared/storage-move.ts,
// kind "folder"): a rename on the same volume, a verified copy across volumes,
// on the Tasks page, cancellable, logged. When every file is across, this file
// re-points what the database knows in one transaction:
//
//   - the items: library and path (their ids never change, so stories, albums,
//     slideshows, music tracks, voice notes, tags, people and likes all keep
//     pointing at the same photos);
//   - their thumbnails, previews, web copies and face crops, which live in a
//     bucket per library in the thumbnail store: the files move to the new
//     library's bucket and the keys follow;
//   - the folder locks inside the folder, which name a folder IN a library.
//
// Admin only, and only between gallery libraries the app manages; never into a
// Photo Inbox (what is in the family's collection must not turn into something
// waiting for review).
import fs from "node:fs";
import path from "node:path";
import { db, logActivity } from "../../../db.js";
import { parsePolicy } from "../../../core/permissions.js";
import { normaliseRelativePath, pathIsInside } from "../shared/storage-roots.js";
import { getConfiguredThumbnailPath } from "../shared/thumbnail.js";
import { enqueueStorageMove, folderMoveStatuses, type StorageMoveStatus } from "../shared/storage-move.js";
import { enqueueGalleryScan, processGalleryScanQueue } from "./scanner.js";
import type { GalleryDetailRow, GalleryFaceRow, ItemMetadataRow, LibraryFolderLockRow, LibraryItemRow, LibraryRow, NonNull } from "../../../db/rows.js";

export class FolderMoveError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "FolderMoveError";
  }
}

type GalleryLibraryRow = Pick<LibraryRow, "id" | "name" | "source_path" | "policy_json" | "scan_status">;

function galleryLibrary(id: string): GalleryLibraryRow | null {
  return (db.prepare("SELECT id, name, source_path, policy_json, scan_status FROM libraries WHERE id = ? AND type = 'gallery'").get(id) as GalleryLibraryRow | undefined) ?? null;
}

/** A folder path as the app stores it: "/"-separated, no leading or trailing
 *  slash, no "." or ".." segments. Null when it is not one. */
export function normaliseFolder(input: string): string | null {
  const cleaned = normaliseRelativePath(input.replace(/\\/g, "/")).replace(/^\/+|\/+$/g, "");
  if (!cleaned) return null;
  if (cleaned.split("/").some((part) => part === "." || part === "..")) return null;
  return cleaned;
}

/** Items whose file sits at `folder` or below, in `libraryId`. */
function itemsUnder(libraryId: string, folder: string): { id: string; folder_path: string }[] {
  return db.prepare(
    "SELECT id, folder_path FROM library_items WHERE library_id = ? AND (folder_path = ? OR folder_path LIKE ? ESCAPE '\\')"
  ).all(libraryId, folder, `${folder.replace(/[\\%_]/g, "\\$&")}/%`) as Pick<LibraryItemRow, "id" | "folder_path">[];
}

export interface FolderMovePlan {
  library: { id: string; name: string };
  target: { id: string; name: string };
  folder: string;
  targetFolder: string;
  from: string;
  to: string;
  items: number;
}

/** Check a move before anything is queued: both libraries, the folder on disk,
 *  nothing already at the destination, no scan or move under way on either. */
export function planFolderMove(libraryId: string, folderInput: string, targetLibraryId: string): FolderMovePlan {
  const folder = normaliseFolder(folderInput);
  if (!folder) throw new FolderMoveError("Choose a folder inside the library.");
  const library = galleryLibrary(libraryId);
  if (!library) throw new FolderMoveError("Gallery library not found.", 404);
  const target = galleryLibrary(targetLibraryId);
  if (!target) throw new FolderMoveError("The library to move into was not found.", 404);
  if (target.id === library.id) throw new FolderMoveError("That is the library the folder is already in.");
  if (parsePolicy(target.policy_json).inbox === true) {
    throw new FolderMoveError(`"${target.name}" is a Photo Inbox: what is in the collection cannot be moved into what is waiting for review.`, 409);
  }
  if (parsePolicy(target.policy_json).mode === "external") {
    throw new FolderMoveError(`"${target.name}" is read-only, so nothing can be moved into it.`, 409);
  }
  const from = path.resolve(library.source_path, ...folder.split("/"));
  if (!pathIsInside(from, path.resolve(library.source_path)) || from === path.resolve(library.source_path)) {
    throw new FolderMoveError("Choose a folder inside the library, not the library itself.");
  }
  let stat: fs.Stats;
  try { stat = fs.statSync(from); } catch { throw new FolderMoveError(`The folder is missing on disk: ${from}`, 404); }
  if (!stat.isDirectory()) throw new FolderMoveError("That is a file, not a folder.");
  const to = path.resolve(target.source_path, ...folder.split("/"));
  if (!pathIsInside(to, path.resolve(target.source_path))) throw new FolderMoveError("That folder cannot be placed in the other library.");
  if (fs.existsSync(to)) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(to); } catch { entries = ["?"]; }
    if (entries.length > 0) throw new FolderMoveError(`"${target.name}" already has a "${folder}" folder. Move it aside or rename one first.`, 409);
  }
  if (library.scan_status === "scanning" || target.scan_status === "scanning") {
    throw new FolderMoveError("One of the libraries is being scanned right now. Wait for the scan to finish first.", 409);
  }
  const busy = folderMoveStatuses().find((move) => move.running && (move.libraryId === library.id || move.targetLibraryId === library.id || move.libraryId === target.id || move.targetLibraryId === target.id));
  if (busy) throw new FolderMoveError("A folder move is already running for one of these libraries. Wait for it to finish first.", 409);
  return {
    library: { id: library.id, name: library.name },
    target: { id: target.id, name: target.name },
    folder,
    targetFolder: folder,
    from,
    to,
    items: itemsUnder(library.id, folder).length
  };
}

/** Queue the move as a storage move task. */
export function queueFolderMove(libraryId: string, folderInput: string, targetLibraryId: string, userId: string): { plan: FolderMovePlan; status: StorageMoveStatus } {
  const plan = planFolderMove(libraryId, folderInput, targetLibraryId);
  const status = enqueueStorageMove({
    kind: "folder",
    room: "folder",
    label: `${plan.folder} (${plan.library.name} → ${plan.target.name})`,
    from: plan.from,
    to: plan.to,
    libraryId: plan.library.id,
    targetLibraryId: plan.target.id,
    folder: plan.folder,
    targetFolder: plan.targetFolder,
    actorUserId: userId
  });
  logActivity({
    event: "library.gallery.folder_move_queued",
    actorUserId: userId,
    targetType: "library",
    targetId: plan.library.id,
    detail: `Queued moving "${plan.folder}" (${plan.items} item${plan.items === 1 ? "" : "s"}) from "${plan.library.name}" to "${plan.target.name}".`
  });
  return { plan, status };
}

/** The thumbnail-store keys an item and its faces own, all under the source
 *  library's bucket; each becomes the same key under the target's bucket. */
function rekey(key: string | null, fromLibrary: string, toLibrary: string): string | null {
  if (!key) return null;
  return key.startsWith(`${fromLibrary}/`) ? `${toLibrary}/${key.slice(fromLibrary.length + 1)}` : key;
}

function moveThumbnailFile(oldKey: string | null, newKey: string | null): void {
  if (!oldKey || !newKey || oldKey === newKey) return;
  let root: string;
  try { root = getConfiguredThumbnailPath(); } catch { return; }
  const from = path.resolve(root, oldKey);
  const to = path.resolve(root, newKey);
  if (!pathIsInside(from, root) || !pathIsInside(to, root) || !fs.existsSync(from)) return;
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  } catch {
    /* a missing cover is regenerated by the scan queued after the move */
  }
}

/** Called by the task once every file is across: re-point the items, their
 *  thumbnails and the folder locks. Returns how many items moved. */
export function repointMovedFolder(libraryId: string, folder: string, targetLibraryId: string, targetFolder: string): number {
  const items = itemsUnder(libraryId, folder);
  const newPath = (old: string) => (old === folder ? targetFolder : `${targetFolder}${old.slice(folder.length)}`);
  const updateItem = db.prepare("UPDATE library_items SET library_id = ?, folder_path = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?");
  const updateDetails = db.prepare("UPDATE gallery_details SET relative_path = ?, preview_storage_key = ?, web_video_key = ? WHERE item_id = ?");
  const readDetails = db.prepare("SELECT preview_storage_key, web_video_key FROM gallery_details WHERE item_id = ?");
  const readCover = db.prepare("SELECT cover_storage_key FROM item_metadata WHERE item_id = ?");
  const updateCover = db.prepare("UPDATE item_metadata SET cover_storage_key = ? WHERE item_id = ?");
  const readFaces = db.prepare("SELECT id, thumb_storage_key FROM gallery_faces WHERE item_id = ? AND thumb_storage_key IS NOT NULL");
  const updateFace = db.prepare("UPDATE gallery_faces SET thumb_storage_key = ? WHERE id = ?");
  const locks = db.prepare(
    "SELECT folder_path, locked_by FROM library_folder_locks WHERE library_id = ? AND (folder_path = ? OR folder_path LIKE ? ESCAPE '\\')"
  ).all(libraryId, folder, `${folder.replace(/[\\%_]/g, "\\$&")}/%`) as Pick<LibraryFolderLockRow, "folder_path" | "locked_by">[];

  const fileMoves: [string | null, string | null][] = [];
  db.transaction(() => {
    for (const item of items) {
      updateItem.run(targetLibraryId, newPath(item.folder_path), item.id);
      const details = readDetails.get(item.id) as Pick<GalleryDetailRow, "preview_storage_key" | "web_video_key"> | undefined;
      if (details) {
        const preview = rekey(details.preview_storage_key, libraryId, targetLibraryId);
        const web = rekey(details.web_video_key, libraryId, targetLibraryId);
        updateDetails.run(newPath(item.folder_path), preview, web, item.id);
        fileMoves.push([details.preview_storage_key, preview], [details.web_video_key, web]);
      }
      const cover = readCover.get(item.id) as Pick<ItemMetadataRow, "cover_storage_key"> | undefined;
      if (cover?.cover_storage_key) {
        const next = rekey(cover.cover_storage_key, libraryId, targetLibraryId);
        updateCover.run(next, item.id);
        fileMoves.push([cover.cover_storage_key, next]);
      }
      for (const face of readFaces.all(item.id) as NonNull<Pick<GalleryFaceRow, "id" | "thumb_storage_key">, "thumb_storage_key">[]) {
        const next = rekey(face.thumb_storage_key, libraryId, targetLibraryId);
        updateFace.run(next, face.id);
        fileMoves.push([face.thumb_storage_key, next]);
      }
    }
    for (const lock of locks) {
      db.prepare("DELETE FROM library_folder_locks WHERE library_id = ? AND folder_path = ?").run(libraryId, lock.folder_path);
      db.prepare("INSERT OR IGNORE INTO library_folder_locks (library_id, folder_path, locked_by) VALUES (?, ?, ?)").run(targetLibraryId, newPath(lock.folder_path), lock.locked_by);
    }
  })();
  for (const [oldKey, newKey] of fileMoves) moveThumbnailFile(oldKey, newKey);

  const target = galleryLibrary(targetLibraryId);
  const source = galleryLibrary(libraryId);
  logActivity({
    event: "library.gallery.folder_moved",
    actorUserId: null,
    targetType: "library",
    targetId: targetLibraryId,
    detail: `Moved "${folder}" (${items.length} item${items.length === 1 ? "" : "s"}) from "${source?.name ?? libraryId}" to "${target?.name ?? targetLibraryId}" as "${targetFolder}".`
  });
  // A scoped scan of the folder in its new library re-reads what the move
  // carried, regenerating any cover the thumbnail move could not take along.
  enqueueGalleryScan(targetLibraryId, { folder: targetFolder });
  void processGalleryScanQueue();
  return items.length;
}
