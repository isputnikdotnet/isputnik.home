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
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { db } from "../../../db.js";
import { parsePolicy } from "../../../core/permissions.js";
import { validateLibrarySource } from "./library-source.js";
import { pathIsInside, normaliseRelativePath, findStorageRootForPath } from "./storage-roots.js";
import { thumbnailStorageKey, thumbnailAbsolutePath } from "./thumbnail.js";
import { deleteSharesForResource } from "./share-access.js";
import { deleteCollectionItemsForResource } from "../../collections/cleanup.js";
import { rescanSingleBook } from "../audiobook/scanner.js";
import { enqueueEbookScan, processEbookScanQueue } from "../ebook/scanner.js";
import { enqueueGalleryScan, processGalleryScanQueue } from "../gallery/scanner.js";
import { faceCropKeysForItem, removeFaceCropFiles } from "../gallery/faces/crop-files.js";
import { lockCovering } from "./folder-locks.js";

const TRASH_DIR = ".trash";

/** Where a library's deleted files sit by default: inside the library's own folder, so
 *  deleting is a rename within one filesystem rather than a copy across shares — which
 *  also means one bin per library, not one for the install. Only the default; an
 *  install-wide folder can be chosen on the Storage page (see getTrashRootSetting). */
export const trashFolderFor = (sourcePath: string): string => path.join(sourcePath, TRASH_DIR);
const TRASH_RETENTION_KEY = "trash_retention_days";
const DEFAULT_RETENTION_DAYS = 30;
const TRASH_ROOT_KEY = "trash_root_path";

/** The install-wide bin folder, or null for the per-library default.
 *
 *  Why offer it at all: other software walking the same share indexes `.trash` — Immich's
 *  external libraries add every file in an import path, and its own docs call the exclusion
 *  globs unreliable — so a month of deleted photos keeps showing up as live in whatever else
 *  reads that folder. Moving the bin out of the library tree is the only fix that doesn't
 *  depend on another tool's ignore rules. */
export function getTrashRootSetting(): string | null {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(TRASH_ROOT_KEY) as
    | { value: string }
    | undefined;
  const value = row?.value.trim();
  return value ? value : null;
}

/** Is there anything in the bin at all? The location can only change while there is not:
 *  a bin split across two places is a bin nobody can reason about, and the page that names
 *  where the files are would be naming only half of them. */
export function binIsEmpty(): boolean {
  return (db.prepare("SELECT COUNT(*) AS n FROM trashed_items").get() as { n: number }).n === 0;
}

/** Vet a candidate bin folder. Same containment rule as a library source — it must sit in
 *  a configured storage container — plus the rules that are specific to this: it cannot be
 *  inside a library (the scanner would catalogue deleted files straight back in) and cannot
 *  contain one (emptying the bin would then be pointed at live files). */
export function validateTrashRootPath(candidate: string): string {
  const resolved = path.resolve(candidate);
  if (!path.isAbsolute(resolved)) {
    throw new TrashError("Use an absolute server path for the Recycle Bin folder.");
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new TrashError(`That folder is missing or not accessible: ${resolved}`);
  }
  if (!stat.isDirectory()) throw new TrashError("The Recycle Bin location must be a folder.");

  const real = fs.realpathSync(resolved);
  if (!findStorageRootForPath(real)) {
    throw new TrashError("Choose a folder inside a configured Digital Library container.");
  }

  const libraries = db.prepare("SELECT name, source_path FROM libraries").all() as
    { name: string; source_path: string }[];
  for (const library of libraries) {
    const source = path.resolve(library.source_path);
    if (pathIsInside(real, source)) {
      throw new TrashError(
        `That folder is inside the library "${library.name}", so deleted files would be scanned straight back in. Choose one outside every library.`
      );
    }
    if (pathIsInside(source, real)) {
      throw new TrashError(
        `The library "${library.name}" is inside that folder. The Recycle Bin must not contain a library.`
      );
    }
  }

  return real;
}

export function setTrashRootSetting(rootPath: string | null, userId: string): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_by, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(TRASH_ROOT_KEY, rootPath ?? "", userId);
}

/** What a row's trash_path is relative to. NULL trash_root = the library's own folder,
 *  which is what every row written before the setting existed means. */
const binRootFor = (item: { source_path: string; trash_root?: string | null }): string =>
  path.resolve(item.trash_root || item.source_path);

/** The folder holding this row's item directory — `<source>/.trash`, or `<bin>/<library>`.
 *  Shown on the Recycle Bin page: "restore it from the app" is no help when the app is
 *  down, or when the question is which disk the space is still on. */
export function binFolderFor(item: { source_path: string; trash_root?: string | null; trash_path: string }): string {
  return path.dirname(path.resolve(binRootFor(item), item.trash_path));
}

/** Move a file or folder, falling back to copy-then-delete across volumes.
 *
 *  rename() cannot cross a filesystem boundary (EXDEV), and an install-wide bin is very
 *  likely on a different disk from some library. The fallback reads and rewrites every
 *  byte, which is why the Storage page says a bin on other storage makes deleting slower
 *  instead of instant. */
function moveEntry(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
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

// Move the book's on-disk entry from the live tree into its bin directory, keeping each
// file at its original source-relative path so a restore is a clean inverse. `trashAbs`
// is that directory, resolved by the caller — it is inside the library for the default
// bin and somewhere else entirely for an install-wide one.
// folder_path !== "." → move the single entry (audiobook folder or ebook file) wholesale.
// folder_path === "." → move each catalogued file individually (root-grouped books).
function moveEntryIntoTrash(root: string, trashAbs: string, row: TrashBookRow): void {
  if (row.folder_path === ".") {
    for (const relativePath of catalogedRelativePaths(row.id)) {
      const from = path.resolve(root, relativePath);
      if (!pathIsInside(from, root) || from === root || !fs.existsSync(from)) continue;
      const to = path.join(trashAbs, relativePath);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      moveEntry(from, to);
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
  moveEntry(from, to);
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
function moveEntryOutOfTrash(
  root: string,
  item: { origin_path: string; trash_path: string; source_path?: string; trash_root?: string | null },
  dedupe: boolean
): string {
  // The bin the row actually went into, which is the library itself only by default.
  const trashAbs = path.resolve(item.trash_root || root, item.trash_path);

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
        moveEntry(abs, to);
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
  if (fs.existsSync(from)) moveEntry(from, to);
  return target;
}

// Remove the empty token dir, and the folder that held it if that is now empty too.
// The parent is derived from trash_path rather than assumed: `.trash` for the default
// bin, the library's own folder under an install-wide one. The bin root itself is never
// removed — it is a folder someone chose, not one this created.
function pruneEmptyTrashDir(root: string, item: { trash_path: string; trash_root?: string | null }): void {
  try {
    const base = path.resolve(item.trash_root || root);
    const trashAbs = path.resolve(base, item.trash_path);
    fs.rmSync(trashAbs, { recursive: true, force: true });
    const container = path.dirname(trashAbs);
    if (container !== base && fs.existsSync(container) && fs.readdirSync(container).length === 0) {
      fs.rmdirSync(container);
    }
  } catch {
    // best-effort housekeeping; a leftover empty dir is harmless (scanner skips it)
  }
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
  const trashPath = normaliseRelativePath(
    trashRoot ? path.join(row.library_id, token) : path.join(TRASH_DIR, token)
  );
  const trashAbs = path.resolve(trashRoot ?? root, trashPath);

  // Face-crop thumbnails cascade away as DB rows with the item but live on as files —
  // snapshot their keys now (the teardown deletes the rows) and remove the files once
  // the teardown commits. They regenerate on a restore, like covers do.
  const faceCropKeys = row.library_type === "gallery" ? faceCropKeysForItem(row.id) : [];

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

  removeFaceCropFiles(faceCropKeys);
  return { id: bookId, title: row.title, libraryName: row.library_name, fileCount: row.file_count };
}

// Restore a trashed item: move its files back (deduping the path if it's been reused) and
// re-catalogue from disk. Per-user progress/bookmarks/shares from before are not resurrected
// — the item comes back as if freshly added (matches what a hard delete + re-add would do).
/** Kick the library scan that re-discovers a restored file. Public so a bulk restore
 *  can call it once per library instead of once per item. */
export function scanForRestored(libraryType: string, libraryId: string): void {
  if (libraryType === "gallery") {
    enqueueGalleryScan(libraryId);
    void processGalleryScanQueue();
  } else if (libraryType !== "audiobook") {
    // ebook, and future types that catalogue from a path.
    enqueueEbookScan(libraryId);
    void processEbookScanQueue();
  }
}

/** `deferScan` leaves the re-discovery scan to the caller — see scanForRestored.
 *  Audiobooks ignore it: they re-catalogue their own single item, which is cheap
 *  and is not a library-wide walk. */
export async function restoreTrashedItem(id: string, deferScan = false): Promise<TrashResult> {
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
  pruneEmptyTrashDir(root, item);

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
function removeTrashFiles(item: TrashedItem): void {
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

/** Why an item was removed. Two levels only, deliberately: the bin's own setting is the
 *  default, and duplicate cleanup gets one override. Room for more, but a general
 *  per-source policy system is more machinery than two answers need. */
export type TrashSource = "manual" | "duplicate_cleanup";

const CLEANUP_RETENTION_KEY = "trash_retention_days_duplicate_cleanup";

/** How long a cleanup's removals are kept, or null to follow the bin's own setting.
 *  Stored as a string so "unset" and "0 = keep for ever" stay distinguishable — the
 *  difference between "I never chose" and "I chose never to purge". */
export function getCleanupRetentionDays(): number | null {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(CLEANUP_RETENTION_KEY) as
    | { value: string }
    | undefined;
  if (!row || row.value === "") return null;
  const parsed = Number.parseInt(row.value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function setCleanupRetentionDays(days: number | null): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(CLEANUP_RETENTION_KEY, days == null ? "" : String(days));
}

/** The moment this item will be purged, decided ONCE, now. Null = keep until the bin is
 *  emptied by hand. */
export function expiryFor(source: TrashSource, at = new Date()): string | null {
  const days = source === "duplicate_cleanup"
    ? getCleanupRetentionDays() ?? getTrashRetentionDays()
    : getTrashRetentionDays();
  if (days <= 0) return null;
  return new Date(at.getTime() + days * 86_400_000).toISOString();
}

export function getTrashRetentionDays(): number {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(TRASH_RETENTION_KEY) as
    | { value: string }
    | undefined;
  if (!row) return DEFAULT_RETENTION_DAYS;
  const parsed = Number.parseInt(row.value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RETENTION_DAYS; // 0 = never auto-purge
}

export function setTrashRetentionDays(days: number): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(TRASH_RETENTION_KEY, String(days));
}

// Auto-purge everything past the retention window. Items whose source volume is currently
// offline are skipped (so their files aren't orphaned) and retried on the next sweep —
// hence two counts: how many were due, and how many actually went.
export function purgeExpiredTrash(): { purged: number; eligible: number } {
  // Each row carries its own date, written when it was trashed. Changing the setting
  // now therefore governs only what is deleted from now on — it cannot reach back and
  // shorten a promise already made.
  const expired = db.prepare(
    "SELECT * FROM trashed_items WHERE expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now')"
  ).all() as TrashedItem[];
  let purged = 0;
  for (const item of expired) {
    if (!fs.existsSync(binRootFor(item))) continue;
    try {
      removeTrashFiles(item);
      db.prepare("DELETE FROM trashed_items WHERE id = ?").run(item.id);
      purged += 1;
    } catch {
      // leave the row in place; the next sweep retries
    }
  }
  return { purged, eligible: expired.length };
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
