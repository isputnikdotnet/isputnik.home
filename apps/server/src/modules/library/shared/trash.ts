// Recycle Bin — the shared, type-agnostic trash engine for catalogued items
// (audiobooks, ebooks, and any future library type). See docs/recycle-bin.md.
//
// Trashing keeps today's exact hard-delete teardown (drop the books row, cascade its
// children, clean the polymorphic tables) but MOVES the item's files into a bin folder
// instead of fs.rmSync-ing them. By default that is the library's own hidden
// <source>/.trash/<token>/ — the scanner ignores all dot-folders, so trashed files are
// never re-indexed, and the move is an instant same-volume rename. An install-wide bin
// can be chosen instead (Storage page), in which case files go to <bin>/<library>/<token>/
// and the move may have to cross volumes. A trashed_items row snapshots everything needed
// to restore (origin path) or purge (bin root + trash path) the item later.
//
// The unit moved is the book's OWN entry, keyed off books.folder_path — which is the
// book's folder for audiobooks but the single file for ebooks (one file = one book, many
// ebooks sharing one directory). Moving the whole folder would take an ebook's siblings
// with it; moving the folder_path entry does not.
//
// Beside this file: trash-settings.ts (where the bin is, how long it keeps things),
// trash-fs.ts (the moves themselves) and trash-retention.ts (the auto-purge).
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { db } from "../../../db.js";
import { parsePolicy } from "../../../core/permissions.js";
import { validateLibrarySource } from "./library-source.js";
import { pathIsInside } from "./storage-roots.js";
import { thumbnailStorageKey, thumbnailAbsolutePath } from "./thumbnail.js";
import { deleteSharesForResource } from "./share-access.js";
import { deleteCollectionItemsForResource } from "../../collections/cleanup.js";
import { deleteStoryBlocksForResource } from "../../stories/cleanup.js";
import { getMediaType, scanLibraryNow } from "./media-types.js";
import { lockCovering } from "./folder-locks.js";
import {
  binRootFor,
  expiryFor,
  getTrashRootSetting,
  TrashError,
  trashPathFor,
  type TrashSource
} from "./trash-settings.js";
import {
  moveEntryIntoTrash,
  moveEntryOutOfTrash,
  pruneEmptyTrashDir,
  type TrashBookRow
} from "./trash-fs.js";

/** The one row the bin move is carrying right now. Restore and purge step around it for
 *  the seconds the move takes rather than racing it for the same folder. Kept here, not
 *  in trash-move.ts, so the check needs no import in the other direction. */
let movingItemId: string | null = null;
export function setMovingTrashedItem(id: string | null): void {
  movingItemId = id;
}
function refuseWhileMoving(id: string): void {
  if (movingItemId === id) {
    throw new TrashError("This item is being moved to the bin's new location right now. Try again in a moment.", 409);
  }
}

export interface TrashedItem {
  id: string;
  library_id: string;
  library_type: string;
  library_name: string;
  source_path: string;
  title: string;
  origin_path: string;
  trash_path: string;
  file_count: number;
  size_bytes: number;
  /** Thumbnail kept alive for the bin's preview; null for pre-2.11 rows. */
  cover_key: string | null;
  /** What removed it — a hand delete or a duplicate cleanup. Decides which retention
   *  clock it was given, and lets the bin separate a cleanup's thousands of rows from
   *  the handful someone deleted themselves. */
  source: string;
  /** When it will be purged, fixed at the moment it was trashed. NULL = kept until the
   *  bin is emptied by hand. */
  expires_at: string | null;
  /** The install-wide bin folder this row's files went into; NULL = the library's own
   *  `.trash`, which is the default and what every pre-2.23 row means. */
  trash_root: string | null;
  trashed_by: string | null;
  trashed_at: string;
}

// Load the live book with the extra fields the bin snapshot needs (type, size, counts
// across both audio files and documents — ebooks have only documents).
function loadBookForTrash(bookId: string): TrashBookRow | undefined {
  return db.prepare(`
    SELECT
      library_items.id,
      library_items.folder_path,
      library_items.library_id,
      libraries.name AS library_name,
      libraries.type AS library_type,
      libraries.source_path,
      COALESCE(item_metadata.title, library_items.folder_path) AS title,
      item_metadata.cover_storage_key,
      (SELECT COUNT(*) FROM audio_files WHERE audio_files.item_id = library_items.id AND audio_files.deleted_at IS NULL)
        + (SELECT COUNT(*) FROM document_files WHERE document_files.item_id = library_items.id AND document_files.deleted_at IS NULL)
        + (SELECT COUNT(*) FROM gallery_details WHERE gallery_details.item_id = library_items.id) AS file_count,
      (SELECT COALESCE(SUM(size), 0) FROM audio_files WHERE audio_files.item_id = library_items.id AND audio_files.deleted_at IS NULL)
        + (SELECT COALESCE(SUM(size), 0) FROM document_files WHERE document_files.item_id = library_items.id AND document_files.deleted_at IS NULL)
        + (SELECT COALESCE(SUM(size), 0) FROM gallery_details WHERE gallery_details.item_id = library_items.id) AS size_bytes
    FROM library_items
    JOIN libraries ON libraries.id = library_items.library_id
    LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
    WHERE library_items.id = ? AND library_items.deleted_at IS NULL
  `).get(bookId) as TrashBookRow | undefined;
}

function getTrashedItem(id: string): TrashedItem | undefined {
  return db.prepare("SELECT * FROM trashed_items WHERE id = ?").get(id) as TrashedItem | undefined;
}

// Cover thumbnails (kept outside the source dir). Removed on trash — they regenerate when
// a restored item is re-catalogued. Best-effort; a missing thumbnail store never blocks.
// `keep` spares one thumbnail from the sweep — the Recycle Bin holds on to a
// single small cover so a binned row can show what it is. It's removed later, when
// the item is purged or restored.
function deleteBookCovers(libraryId: string, bookId: string, coverStorageKey: string | null, keep?: string | null): void {
  const keys = new Set([
    thumbnailStorageKey(libraryId, bookId, `${bookId}-cover.webp`),
    thumbnailStorageKey(libraryId, bookId, `${bookId}-cover-large.webp`),
    // Gallery video web-playable copy (transcode.ts); a no-op for non-video items.
    thumbnailStorageKey(libraryId, bookId, `${bookId}-web.mp4`)
  ]);
  if (coverStorageKey) keys.add(coverStorageKey);
  if (keep) keys.delete(keep);
  for (const key of keys) {
    try { fs.rmSync(thumbnailAbsolutePath(key), { force: true }); } catch { /* ignore */ }
  }
}

function removeBinCover(coverKey: string | null | undefined): void {
  if (!coverKey) return;
  try { fs.rmSync(thumbnailAbsolutePath(coverKey), { force: true }); } catch { /* ignore */ }
}

// The small cover to keep for the bin's preview: whatever the item's metadata
// points at, else the conventional generated one. Returns null when neither is on
// disk (an audiobook with no art), and the row falls back to a media-type icon.
function coverToKeep(libraryId: string, bookId: string, coverStorageKey: string | null): string | null {
  const candidates = [coverStorageKey, thumbnailStorageKey(libraryId, bookId, `${bookId}-cover.webp`)];
  for (const key of candidates) {
    if (!key) continue;
    try {
      if (fs.existsSync(thumbnailAbsolutePath(key))) return key;
    } catch { /* unreadable store — treat as no cover */ }
  }
  return null;
}

// DB teardown — identical to the old hard delete. FK cascades clear audio_files/metadata/
// item_people/documents/progress/bookmarks/saves; the polymorphic tables (taggables, shares,
// collections, story blocks) have no FK and are cleaned explicitly. shares/collections are
// namespaced by the library type; taggables use 'library_item' for every type.
function deleteBookRecord(bookId: string, libraryType: string): void {
  db.prepare("DELETE FROM taggables WHERE entity_type = 'library_item' AND entity_id = ?").run(bookId);
  deleteSharesForResource(libraryType, bookId);
  deleteCollectionItemsForResource(libraryType, bookId);
  deleteStoryBlocksForResource(libraryType, bookId);
  db.prepare("DELETE FROM library_items WHERE id = ?").run(bookId);
}

export interface TrashResult {
  id: string;
  title: string;
  libraryName: string;
  fileCount: number;
}

// Move one book to the Recycle Bin. Throws TrashError on a filesystem problem; the book is
// only removed from the catalog once its files are safely relocated (and put back if the
// teardown itself fails).
/** Does this library's own policy permit removing files from it at all?
 *
 *  Separate from "may this person delete": that is a question about a user and is
 *  answered by can(). This is a property of the LIBRARY — an external library is
 *  somewhere the app reads and does not own, and allowDelete=false says the same
 *  thing more narrowly. Nobody's role overrides either. */
export function libraryAllowsDelete(libraryId: string): boolean {
  const row = db.prepare("SELECT policy_json FROM libraries WHERE id = ?").get(libraryId) as
    | { policy_json: string }
    | undefined;
  if (!row) return false;
  const policy = parsePolicy(row.policy_json);
  if ((policy.mode ?? "managed") === "external") return false;
  return policy.allowDelete !== false;
}

export function trashBook(
  bookId: string,
  userId: string,
  /** Why it is going, which decides how long it is kept. Defaults to a hand delete —
   *  the safer assumption, since that is the longest-kept kind. */
  options: { source?: TrashSource } = {}
): TrashResult {
  const row = loadBookForTrash(bookId);
  if (!row) throw new TrashError("Item not found.", 404);
  const source = options.source ?? "manual";

  // The fail-safe, deliberately HERE rather than at each caller. The item routes
  // check can() before getting this far, but the duplicate finders call straight in
  // — they act on sets that span libraries, and had no notion of a library that must
  // not be written to. One protected copy in a set was enough to delete a file out
  // of a library the app was only ever supposed to read.
  if (!libraryAllowsDelete(row.library_id)) {
    throw new TrashError(
      `"${row.library_name}" is set to external, or has deleting turned off, so its files can't be removed by the app.`,
      403
    );
  }

  // Folder locks, enforced HERE for the same reason as the library check above:
  // every deletion path — hand delete, bulk select, duplicate cleanup — ends at
  // this function, and only this function knows the item it is about to move.
  // 423 (Locked) rather than 403 so bulk callers can count locked refusals
  // separately from permission refusals.
  const lockedUnder = lockCovering(row.library_id, row.folder_path);
  if (lockedUnder !== null) {
    throw new TrashError(
      `"${lockedUnder}" in "${row.library_name}" is locked, so nothing inside it can be deleted from the app.`,
      423
    );
  }

  let root: string;
  try {
    root = validateLibrarySource(row.source_path);
  } catch (err) {
    throw new TrashError(err instanceof Error ? err.message : "Library source folder is unavailable.", 400);
  }

  const token = nanoid(12);
  // Where this row's files go, and what its trash_path is relative to. With an
  // install-wide bin the library id is a folder inside it, so one bin can hold every
  // library without two libraries' tokens sharing a directory. Both layouts end in
  // <container>/<token>, which is what prune and restore rely on.
  const trashRoot = getTrashRootSetting();
  const trashPath = trashPathFor(row.library_id, token, trashRoot);
  const trashAbs = path.resolve(trashRoot ?? root, trashPath);

  // Face-crop thumbnails cascade away as DB rows with the item but live on as files —
  // snapshot their keys now (the teardown deletes the rows) and remove the files once
  // the teardown commits. They regenerate on a restore, like covers do.
  const mediaType = getMediaType(row.library_type);
  const faceCropKeys = mediaType?.cropKeysForItem?.(row.id) ?? [];

  moveEntryIntoTrash(root, trashAbs, row);

  // Kept out of the cover sweep below and recorded on the bin row, so the Recycle
  // Bin can show the item rather than just its name.
  const coverKey = coverToKeep(row.library_id, row.id, row.cover_storage_key);

  try {
    db.transaction(() => {
      deleteBookCovers(row.library_id, row.id, row.cover_storage_key, coverKey);
      deleteBookRecord(row.id, row.library_type);
      db.prepare(`
        INSERT INTO trashed_items
          (id, library_id, library_type, library_name, source_path, title, origin_path, trash_path,
           file_count, size_bytes, cover_key, source, expires_at, trash_root, trashed_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        nanoid(16), row.library_id, row.library_type, row.library_name, row.source_path,
        row.title, row.folder_path, trashPath, row.file_count, row.size_bytes, coverKey,
        source, expiryFor(source), trashRoot, userId
      );
    })();
  } catch (err) {
    // Teardown failed and nothing was committed — put the files back so the book stays live.
    const undo = { origin_path: row.folder_path, trash_path: trashPath, trash_root: trashRoot };
    try { moveEntryOutOfTrash(root, undo, false); } catch { /* ignore */ }
    pruneEmptyTrashDir(root, undo);
    throw new TrashError(err instanceof Error ? err.message : "Could not move the item to the Recycle Bin.", 500);
  }

  mediaType?.removeCropFiles?.(faceCropKeys);
  return { id: bookId, title: row.title, libraryName: row.library_name, fileCount: row.file_count };
}

// Restore a trashed item: move its files back (deduping the path if it's been reused) and
// re-catalogue from disk. Per-user progress/bookmarks/shares from before are not resurrected
// — the item comes back as if freshly added (matches what a hard delete + re-add would do).
/** Kick the library scan that re-discovers a restored file. Public so a bulk restore
 *  can call it once per library instead of once per item. */
export function scanForRestored(libraryType: string, libraryId: string): void {
  // A type that re-catalogues single items (audiobooks) already did, item by item,
  // in restoreTrashedItem; every other type catalogues from a path, so a library
  // scan finds the restored file.
  if (getMediaType(libraryType)?.rescanItem) return;
  scanLibraryNow(libraryType, libraryId);
}

/** `deferScan` leaves the re-discovery scan to the caller — see scanForRestored.
 *  Types with rescanItem (audiobooks) ignore it: they re-catalogue their own single
 *  item, which is cheap and is not a library-wide walk. */
export async function restoreTrashedItem(id: string, deferScan = false): Promise<TrashResult> {
  const item = getTrashedItem(id);
  if (!item) throw new TrashError("Item not found.", 404);
  refuseWhileMoving(id);

  const library = db.prepare("SELECT id, type FROM libraries WHERE id = ?").get(item.library_id) as
    | { id: string; type: string }
    | undefined;
  if (!library) {
    throw new TrashError("The library this item belonged to no longer exists. It can be permanently deleted, but not restored.", 409);
  }

  let root: string;
  try {
    root = validateLibrarySource(item.source_path);
  } catch (err) {
    throw new TrashError(err instanceof Error ? err.message : "Library source folder is unavailable.", 400);
  }

  const restoredPath = moveEntryOutOfTrash(root, item, true);
  pruneEmptyTrashDir(root, item);

  const rescanItem = getMediaType(item.library_type)?.rescanItem;
  if (rescanItem) {
    // rescanItem needs a row to scan — revive a stale one at this path or insert fresh,
    // mirroring the upload path's catalog step.
    const existing = db.prepare("SELECT id FROM library_items WHERE library_id = ? AND folder_path = ?")
      .get(item.library_id, restoredPath) as { id: string } | undefined;
    const bookId = existing?.id ?? nanoid(16);
    if (existing) {
      db.prepare("UPDATE library_items SET deleted_at = NULL, status = 'pending', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(bookId);
    } else {
      db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, ?, ?, ?, 'pending')")
        .run(bookId, item.library_id, item.library_type, restoredPath);
    }
    try { await rescanItem(bookId); } catch { /* files are back; a library rescan will finish it */ }
  } else if (!deferScan) {
    // A library scan re-discovers the restored file by its path. Deferred by callers
    // restoring in bulk, which start ONE scan per library when they are done: the
    // scan is per-library work, so doing it per item is the same walk over and over.
    scanForRestored(item.library_type, item.library_id);
  }

  // The restored item is re-catalogued from disk under a fresh id and generates its
  // own cover, so the one the bin was holding would just be orphaned in the store.
  removeBinCover(item.cover_key);
  db.prepare("DELETE FROM trashed_items WHERE id = ?").run(id);
  return { id, title: item.title, libraryName: item.library_name, fileCount: item.file_count };
}

// Best-effort removal of a token dir's files under its (snapshotted) source root, guarded so
// it can only ever touch <source>/.trash/<token>. fs.rmSync(force) is a no-op when the path
// is already gone (e.g. the source drive is offline), so this never throws on a missing path.
export function removeTrashFiles(item: TrashedItem): void {
  // The preview thumbnail the bin was holding for this row (see coverToKeep).
  // Every purge path funnels through here, so this is the one place it's dropped.
  removeBinCover(item.cover_key);
  // The bin this row went into — the library itself by default, the install-wide folder
  // otherwise. Guarded the same way either way: this can only ever touch <bin>/<...>/<token>.
  const root = binRootFor(item);
  const abs = path.resolve(root, item.trash_path);
  if (pathIsInside(abs, root) && abs !== root) {
    fs.rmSync(abs, { recursive: true, force: true });
    const container = path.dirname(abs);
    try {
      if (container !== root && fs.existsSync(container) && fs.readdirSync(container).length === 0) {
        fs.rmdirSync(container);
      }
    } catch { /* ignore */ }
  }
}

// Permanently delete one trashed item — the real, irreversible removal. Unconditional:
// removes the files (if reachable) and always drops the row so the bin can't wedge.
export function purgeTrashedItem(id: string): TrashedItem | null {
  const item = getTrashedItem(id);
  if (!item) return null;
  refuseWhileMoving(id);
  removeTrashFiles(item);
  db.prepare("DELETE FROM trashed_items WHERE id = ?").run(id);
  return item;
}

// Permanently tear down one catalogued item WITHOUT a Recycle Bin round-trip — for a
// tombstone whose source file is already gone from disk (a scan reconcile set its
// deleted_at). Mirrors trashBook's teardown exactly, minus the .trash move: FK cascades
// clear gallery_details/faces/metadata/album membership; covers + face-crop files (which
// never cascade) are removed here; the polymorphic tables are cleaned in deleteBookRecord.
// Returns false if the item no longer exists. Callers gate this on deleted_at themselves.
export function purgeCataloguedItem(itemId: string): boolean {
  const row = db.prepare(`
    SELECT library_items.id, library_items.library_id, libraries.type AS library_type, item_metadata.cover_storage_key
    FROM library_items
    JOIN libraries ON libraries.id = library_items.library_id
    LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
    WHERE library_items.id = ?
  `).get(itemId) as { id: string; library_id: string; library_type: string; cover_storage_key: string | null } | undefined;
  if (!row) return false;

  const mediaType = getMediaType(row.library_type);
  const faceCropKeys = mediaType?.cropKeysForItem?.(row.id) ?? [];
  db.transaction(() => {
    deleteBookCovers(row.library_id, row.id, row.cover_storage_key);
    deleteBookRecord(row.id, row.library_type);
  })();
  mediaType?.removeCropFiles?.(faceCropKeys);
  return true;
}
