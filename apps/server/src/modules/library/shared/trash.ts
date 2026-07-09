// Recycle Bin — the shared, type-agnostic trash engine for catalogued items
// (audiobooks, ebooks, and any future library type). See docs/recycle-bin.md.
//
// Trashing keeps today's exact hard-delete teardown (drop the books row, cascade its
// children, clean the polymorphic tables) but MOVES the item's files into the library's
// hidden <source>/.trash/<token>/ folder instead of fs.rmSync-ing them. The scanner
// ignores all dot-folders, so trashed files are never re-indexed, and the move is an
// instant same-volume rename. A trashed_items row snapshots everything needed to restore
// (origin path) or purge (source root + trash path) the item later.
//
// The unit moved is the book's OWN entry, keyed off books.folder_path — which is the
// book's folder for audiobooks but the single file for ebooks (one file = one book, many
// ebooks sharing one directory). Moving the whole folder would take an ebook's siblings
// with it; moving the folder_path entry does not.
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { db } from "../../../db.js";
import { validateLibrarySource } from "./library-source.js";
import { pathIsInside, normaliseRelativePath } from "./storage-roots.js";
import { thumbnailStorageKey, thumbnailAbsolutePath } from "./thumbnail.js";
import { deleteSharesForResource } from "./share-access.js";
import { deleteCollectionItemsForResource } from "../../collections/cleanup.js";
import { rescanSingleBook } from "../audiobook/scanner.js";
import { enqueueEbookScan, processEbookScanQueue } from "../ebook/scanner.js";
import { enqueueGalleryScan, processGalleryScanQueue } from "../gallery/scanner.js";
import { faceCropKeysForItem, removeFaceCropFiles } from "../gallery/faces/crop-files.js";

const TRASH_DIR = ".trash";
const TRASH_RETENTION_KEY = "trash_retention_days";
const DEFAULT_RETENTION_DAYS = 30;

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
  trashed_by: string | null;
  trashed_at: string;
}

interface TrashBookRow {
  id: string;
  folder_path: string;
  library_id: string;
  library_name: string;
  library_type: string;
  source_path: string;
  title: string;
  cover_storage_key: string | null;
  file_count: number;
  size_bytes: number;
}

export class TrashError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "TrashError";
    this.statusCode = statusCode;
  }
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

// The book's catalogued files (audio + documents), used for the root-grouped
// (folder_path = ".") branch where the book owns individual files, not a folder.
function catalogedRelativePaths(bookId: string): string[] {
  const rows = db.prepare(`
    SELECT relative_path FROM audio_files WHERE item_id = ?
    UNION
    SELECT relative_path FROM document_files WHERE item_id = ?
  `).all(bookId, bookId) as { relative_path: string }[];
  return rows.map((row) => row.relative_path);
}

// Move the book's on-disk entry from the live tree into <root>/.trash/<token>/, keeping
// each file at its original source-relative path so a restore is a clean inverse.
// folder_path !== "." → move the single entry (audiobook folder or ebook file) wholesale.
// folder_path === "." → move each catalogued file individually (root-grouped books).
function moveEntryIntoTrash(root: string, token: string, row: TrashBookRow): void {
  const trashAbs = path.join(root, TRASH_DIR, token);

  if (row.folder_path === ".") {
    for (const relativePath of catalogedRelativePaths(row.id)) {
      const from = path.resolve(root, relativePath);
      if (!pathIsInside(from, root) || from === root || !fs.existsSync(from)) continue;
      const to = path.join(trashAbs, relativePath);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
    }
    return;
  }

  const from = path.resolve(root, row.folder_path);
  if (!pathIsInside(from, root) || from === root) {
    throw new TrashError("Refusing to move an item outside the library folder.", 500);
  }
  if (!fs.existsSync(from)) return; // already gone from disk; the DB teardown still runs
  const to = path.join(trashAbs, row.folder_path);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}

// Pick a free relative path under root, deduping "Name (2).ext" style (extension kept for
// files, none for directories) — mirrors the upload path's collision handling.
function dedupeRelativePath(root: string, relativePath: string, isDirectory: boolean): string {
  if (!fs.existsSync(path.resolve(root, relativePath))) return relativePath;
  const dir = path.posix.dirname(relativePath);
  const base = path.posix.basename(relativePath);
  const ext = isDirectory ? "" : path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let counter = 2; ; counter += 1) {
    const candidate = normaliseRelativePath(dir === "." ? `${stem} (${counter})${ext}` : `${dir}/${stem} (${counter})${ext}`);
    if (!fs.existsSync(path.resolve(root, candidate))) return candidate;
  }
}

// Inverse of moveEntryIntoTrash: move everything back out of the token dir to its original
// source-relative path. Returns the origin path actually restored to (deduped if the
// original location is occupied again). dedupe=false is used for trash rollback, where the
// just-vacated path is guaranteed free and must be restored exactly.
function moveEntryOutOfTrash(root: string, item: { origin_path: string; trash_path: string }, dedupe: boolean): string {
  const trashAbs = path.resolve(root, item.trash_path);

  if (item.origin_path === ".") {
    // Root-grouped: move each file under the token dir back to its relative path.
    const moveTree = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) { moveTree(abs); continue; }
        const relative = normaliseRelativePath(path.relative(trashAbs, abs));
        const target = dedupe ? dedupeRelativePath(root, relative, false) : relative;
        const to = path.resolve(root, target);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(abs, to);
      }
    };
    if (fs.existsSync(trashAbs)) moveTree(trashAbs);
    return ".";
  }

  const from = path.join(trashAbs, item.origin_path);
  const isDirectory = fs.existsSync(from) && fs.statSync(from).isDirectory();
  const target = dedupe ? dedupeRelativePath(root, item.origin_path, isDirectory) : item.origin_path;
  const to = path.resolve(root, target);
  if (!pathIsInside(to, root) || to === root) {
    throw new TrashError("Refusing to restore an item outside the library folder.", 500);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.existsSync(from)) fs.renameSync(from, to);
  return target;
}

// Remove the empty token dir (and an emptied .trash) after a move out.
function pruneEmptyTrashDir(root: string, trashPath: string): void {
  try {
    const trashAbs = path.resolve(root, trashPath);
    fs.rmSync(trashAbs, { recursive: true, force: true });
    const trashRoot = path.join(root, TRASH_DIR);
    if (fs.existsSync(trashRoot) && fs.readdirSync(trashRoot).length === 0) {
      fs.rmdirSync(trashRoot);
    }
  } catch {
    // best-effort housekeeping; a leftover empty dir is harmless (scanner skips it)
  }
}

// Cover thumbnails (kept outside the source dir). Removed on trash — they regenerate when
// a restored item is re-catalogued. Best-effort; a missing thumbnail store never blocks.
function deleteBookCovers(libraryId: string, bookId: string, coverStorageKey: string | null): void {
  const keys = new Set([
    thumbnailStorageKey(libraryId, bookId, `${bookId}-cover.webp`),
    thumbnailStorageKey(libraryId, bookId, `${bookId}-cover-large.webp`)
  ]);
  if (coverStorageKey) keys.add(coverStorageKey);
  for (const key of keys) {
    try { fs.rmSync(thumbnailAbsolutePath(key), { force: true }); } catch { /* ignore */ }
  }
}

// DB teardown — identical to the old hard delete. FK cascades clear audio_files/metadata/
// item_people/documents/progress/bookmarks/saves; the polymorphic tables (taggables, shares,
// collections) have no FK and are cleaned explicitly. shares/collections are namespaced by
// the library type; taggables use 'library_item' for every type.
function deleteBookRecord(bookId: string, libraryType: string): void {
  db.prepare("DELETE FROM taggables WHERE entity_type = 'library_item' AND entity_id = ?").run(bookId);
  deleteSharesForResource(libraryType, bookId);
  deleteCollectionItemsForResource(libraryType, bookId);
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
export function trashBook(bookId: string, userId: string): TrashResult {
  const row = loadBookForTrash(bookId);
  if (!row) throw new TrashError("Item not found.", 404);

  let root: string;
  try {
    root = validateLibrarySource(row.source_path);
  } catch (err) {
    throw new TrashError(err instanceof Error ? err.message : "Library source folder is unavailable.", 400);
  }

  const token = nanoid(12);
  const trashPath = normaliseRelativePath(path.join(TRASH_DIR, token));

  // Face-crop thumbnails cascade away as DB rows with the item but live on as files —
  // snapshot their keys now (the teardown deletes the rows) and remove the files once
  // the teardown commits. They regenerate on a restore, like covers do.
  const faceCropKeys = row.library_type === "gallery" ? faceCropKeysForItem(row.id) : [];

  moveEntryIntoTrash(root, token, row);

  try {
    db.transaction(() => {
      deleteBookCovers(row.library_id, row.id, row.cover_storage_key);
      deleteBookRecord(row.id, row.library_type);
      db.prepare(`
        INSERT INTO trashed_items
          (id, library_id, library_type, library_name, source_path, title, origin_path, trash_path, file_count, size_bytes, trashed_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        nanoid(16), row.library_id, row.library_type, row.library_name, row.source_path,
        row.title, row.folder_path, trashPath, row.file_count, row.size_bytes, userId
      );
    })();
  } catch (err) {
    // Teardown failed and nothing was committed — put the files back so the book stays live.
    try { moveEntryOutOfTrash(root, { origin_path: row.folder_path, trash_path: trashPath }, false); } catch { /* ignore */ }
    pruneEmptyTrashDir(root, trashPath);
    throw new TrashError(err instanceof Error ? err.message : "Could not move the item to the Recycle Bin.", 500);
  }

  removeFaceCropFiles(faceCropKeys);
  return { id: bookId, title: row.title, libraryName: row.library_name, fileCount: row.file_count };
}

// Restore a trashed item: move its files back (deduping the path if it's been reused) and
// re-catalogue from disk. Per-user progress/bookmarks/shares from before are not resurrected
// — the item comes back as if freshly added (matches what a hard delete + re-add would do).
export async function restoreTrashedItem(id: string): Promise<TrashResult> {
  const item = getTrashedItem(id);
  if (!item) throw new TrashError("Item not found.", 404);

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
  pruneEmptyTrashDir(root, item.trash_path);

  if (item.library_type === "audiobook") {
    // rescanSingleBook needs a row to scan — revive a stale one at this path or insert fresh,
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
    try { await rescanSingleBook(bookId); } catch { /* files are back; a library rescan will finish it */ }
  } else if (item.library_type === "gallery") {
    // gallery: a library scan re-discovers the restored asset by its path.
    enqueueGalleryScan(item.library_id);
    void processGalleryScanQueue();
  } else {
    // ebook (and future types): the library scan re-discovers the restored file by its path.
    enqueueEbookScan(item.library_id);
    void processEbookScanQueue();
  }

  db.prepare("DELETE FROM trashed_items WHERE id = ?").run(id);
  return { id, title: item.title, libraryName: item.library_name, fileCount: item.file_count };
}

// Best-effort removal of a token dir's files under its (snapshotted) source root, guarded so
// it can only ever touch <source>/.trash/<token>. fs.rmSync(force) is a no-op when the path
// is already gone (e.g. the source drive is offline), so this never throws on a missing path.
function removeTrashFiles(item: TrashedItem): void {
  const root = path.resolve(item.source_path);
  const abs = path.resolve(root, item.trash_path);
  if (pathIsInside(abs, root) && abs !== root) {
    fs.rmSync(abs, { recursive: true, force: true });
    const trashRoot = path.join(root, TRASH_DIR);
    try {
      if (fs.existsSync(trashRoot) && fs.readdirSync(trashRoot).length === 0) fs.rmdirSync(trashRoot);
    } catch { /* ignore */ }
  }
}

// Permanently delete one trashed item — the real, irreversible removal. Unconditional:
// removes the files (if reachable) and always drops the row so the bin can't wedge.
export function purgeTrashedItem(id: string): TrashedItem | null {
  const item = getTrashedItem(id);
  if (!item) return null;
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

  const faceCropKeys = row.library_type === "gallery" ? faceCropKeysForItem(row.id) : [];
  db.transaction(() => {
    deleteBookCovers(row.library_id, row.id, row.cover_storage_key);
    deleteBookRecord(row.id, row.library_type);
  })();
  removeFaceCropFiles(faceCropKeys);
  return true;
}

export function getTrashRetentionDays(): number {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(TRASH_RETENTION_KEY) as
    | { value: string }
    | undefined;
  if (!row) return DEFAULT_RETENTION_DAYS;
  const parsed = Number.parseInt(row.value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RETENTION_DAYS; // 0 = never auto-purge
}

// Auto-purge everything past the retention window. Items whose source volume is currently
// offline are skipped (so their files aren't orphaned) and retried on the next sweep.
export function purgeExpiredTrash(): number {
  const days = getTrashRetentionDays();
  if (days <= 0) return 0;
  const expired = db.prepare(
    "SELECT * FROM trashed_items WHERE datetime(trashed_at) <= datetime('now', ?)"
  ).all(`-${days} days`) as TrashedItem[];
  let purged = 0;
  for (const item of expired) {
    if (!fs.existsSync(path.resolve(item.source_path))) continue;
    try {
      removeTrashFiles(item);
      db.prepare("DELETE FROM trashed_items WHERE id = ?").run(item.id);
      purged += 1;
    } catch {
      // leave the row in place; the next sweep retries
    }
  }
  return purged;
}

// Empty the bin — every item, or just one library's. Returns the count purged.
export function emptyTrash(libraryId?: string): number {
  const rows = (libraryId
    ? db.prepare("SELECT id FROM trashed_items WHERE library_id = ?").all(libraryId)
    : db.prepare("SELECT id FROM trashed_items").all()) as { id: string }[];
  let purged = 0;
  for (const row of rows) {
    if (purgeTrashedItem(row.id)) purged += 1;
  }
  return purged;
}

// Periodic sweeper, mirroring startAudiobookScanWorker: runs shortly after boot, then every
// six hours. Returns a stop function for the plugin's onClose hook.
export function startTrashPurgeWorker(): () => void {
  const timer = setInterval(() => {
    try { purgeExpiredTrash(); } catch { /* swallow; retried next tick */ }
  }, 6 * 60 * 60 * 1000);
  timer.unref?.();
  const kickoff = setTimeout(() => {
    try { purgeExpiredTrash(); } catch { /* ignore */ }
  }, 30 * 1000);
  kickoff.unref?.();
  return () => { clearInterval(timer); clearTimeout(kickoff); };
}
