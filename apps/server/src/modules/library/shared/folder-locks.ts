import { db } from "../../../db.js";

// Folder locks: an admin's "nothing under here may be deleted from the app",
// cross-type because every library item carries a folder_path relative to its
// library source (a gallery item's is the file's own relative path, a book's is
// its folder or file). A lock covers its whole subtree; enforcement is an
// existence check in trashBook() — any covering lock blocks, so there is no
// most-specific-wins resolution to get wrong. Locking "" (the whole library) is
// the library policy's job (allowDelete/external), never a row here.

export interface FolderLock {
  folderPath: string;
  lockedBy: string | null;
  lockedByName: string | null;
  lockedAt: string;
}

// A lock path is a plain library-relative folder path: forward slashes, no
// leading/trailing slashes, no "." / ".." segments, never empty. Returns null
// when the input can't be read as one.
export function normaliseLockPath(input: string): string | null {
  const cleaned = input.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "").trim();
  if (!cleaned || cleaned.length > 1024) return null;
  const segments = cleaned.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return cleaned;
}

export function listFolderLocks(libraryId: string): FolderLock[] {
  const rows = db.prepare(`
    SELECT library_folder_locks.folder_path, library_folder_locks.locked_by,
           library_folder_locks.locked_at, users.display_name AS locked_by_name
    FROM library_folder_locks
    LEFT JOIN users ON users.id = library_folder_locks.locked_by
    WHERE library_folder_locks.library_id = ?
    ORDER BY library_folder_locks.folder_path
  `).all(libraryId) as { folder_path: string; locked_by: string | null; locked_at: string; locked_by_name: string | null }[];
  return rows.map((row) => ({
    folderPath: row.folder_path,
    lockedBy: row.locked_by,
    lockedByName: row.locked_by_name,
    lockedAt: row.locked_at
  }));
}

// Idempotent: locking a locked folder or unlocking an unlocked one is a no-op.
// Returns whether a row actually changed.
export function setFolderLock(libraryId: string, folderPath: string, locked: boolean, userId: string): boolean {
  if (locked) {
    const result = db.prepare(`
      INSERT INTO library_folder_locks (library_id, folder_path, locked_by)
      VALUES (?, ?, ?)
      ON CONFLICT (library_id, folder_path) DO NOTHING
    `).run(libraryId, folderPath, userId);
    return result.changes > 0;
  }
  const result = db.prepare("DELETE FROM library_folder_locks WHERE library_id = ? AND folder_path = ?")
    .run(libraryId, folderPath);
  return result.changes > 0;
}

function covers(lock: string, relPath: string): boolean {
  return relPath === lock || relPath.startsWith(lock + "/");
}

function lockPaths(libraryId: string): string[] {
  return (db.prepare("SELECT folder_path FROM library_folder_locks WHERE library_id = ?")
    .all(libraryId) as { folder_path: string }[]).map((row) => row.folder_path);
}

// Is this item path (or folder) under a lock? Returns the covering lock's path
// for the refusal message, or null. Prefix matching happens in JS, not SQL LIKE
// — folder names may contain % and _.
export function lockCovering(libraryId: string, relPath: string): string | null {
  return lockPaths(libraryId).find((lock) => covers(lock, relPath)) ?? null;
}

// Does a lock touch this folder's subtree at all — covering it OR sitting inside
// it? A folder that contains a locked subfolder can't be cleared out either.
// "" means the library root, which every lock sits inside.
export function lockIntersecting(libraryId: string, folderPath: string): string | null {
  return lockPaths(libraryId)
    .find((lock) => folderPath === "" || covers(lock, folderPath) || covers(folderPath, lock)) ?? null;
}

// Batch load for scan-time use: libraryId -> its lock paths.
export function locksByLibrary(libraryIds: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const id of libraryIds) {
    const paths = lockPaths(id);
    if (paths.length > 0) map.set(id, paths);
  }
  return map;
}

// Every lock in the install, one query — for scoring passes that touch rows from
// libraries they never enumerated.
export function allFolderLocks(): Map<string, string[]> {
  const rows = db.prepare("SELECT library_id, folder_path FROM library_folder_locks")
    .all() as { library_id: string; folder_path: string }[];
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const bucket = map.get(row.library_id);
    if (bucket) bucket.push(row.folder_path); else map.set(row.library_id, [row.folder_path]);
  }
  return map;
}

// The scan-time predicates over a batch-loaded map (no per-file queries).
export function lockCoveredIn(locks: string[] | undefined, relPath: string): boolean {
  return locks !== undefined && locks.some((lock) => covers(lock, relPath));
}

export function lockIntersectsIn(locks: string[] | undefined, folderPath: string): boolean {
  if (locks === undefined || locks.length === 0) return false;
  return folderPath === "" || locks.some((lock) => covers(lock, folderPath) || covers(folderPath, lock));
}
