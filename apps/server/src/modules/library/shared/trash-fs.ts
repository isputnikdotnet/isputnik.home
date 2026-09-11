// Moving an item's files into and out of its bin directory.
import fs from "node:fs";
import path from "node:path";
import { db } from "../../../db.js";
import { pathIsInside, normaliseRelativePath } from "./storage-roots.js";
import { TrashError } from "./trash-settings.js";

/** Move a file or folder, falling back to copy-then-delete across volumes.
 *
 *  rename() cannot cross a filesystem boundary (EXDEV), and an install-wide bin is very
 *  likely on a different disk from some library. The fallback reads and rewrites every
 *  byte, which is why the Storage page says a bin on other storage makes deleting slower
 *  instead of instant. */
export function moveEntry(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

export interface TrashBookRow {
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
export function moveEntryIntoTrash(root: string, trashAbs: string, row: TrashBookRow): void {
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
export function moveEntryOutOfTrash(
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
export function pruneEmptyTrashDir(root: string, item: { trash_path: string; trash_root?: string | null }): void {
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
