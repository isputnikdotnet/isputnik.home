// App storage's shared pieces — docs/system-data-plan.md, phase 3. The setting and
// resolvers are core/app-storage.ts; the switch, the page's view and the moves are
// app-storage-service.ts. This file holds what both of those and the routes share:
// the error, the gallery library rows, the folder check.
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { db } from "../../db.js";
import { pathIsInside } from "./shared/storage-roots.js";
import { TrashError } from "./shared/trash-settings.js";
import type { LibraryRow, StorageRootRow } from "../../db/rows.js";

export class AppStorageError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "AppStorageError";
  }
}

export type GalleryLibraryRow = Pick<LibraryRow, "id" | "name" | "source_path" | "policy_json" | "scan_status" | "role">;

export const samePath = (a: string | null | undefined, b: string | null | undefined): boolean => {
  if (!a || !b) return false;
  const norm = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
};

export function galleryLibraries(): GalleryLibraryRow[] {
  return db.prepare("SELECT id, name, source_path, policy_json, scan_status, role FROM libraries WHERE type = 'gallery' ORDER BY name COLLATE NOCASE")
    .all() as GalleryLibraryRow[];
}

export function libraryAt(sourcePath: string | null): GalleryLibraryRow | null {
  if (!sourcePath) return null;
  return galleryLibraries().find((row) => samePath(row.source_path, sourcePath)) ?? null;
}

export function libraryWithRole(role: "inbox" | "app-files"): GalleryLibraryRow | null {
  return galleryLibraries().find((row) => row.role === role) ?? null;
}

export function itemCount(libraryId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM library_items WHERE library_id = ? AND deleted_at IS NULL").get(libraryId) as { n: number }).n;
}

export function dirHasEntries(dir: string | null): boolean {
  if (!dir) return false;
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/** Vet a custom App storage folder (decision 16): absolute, exists or can be made,
 *  writable, not a container itself, not inside any library, and holding no
 *  library but the app's own system libraries. It need not be inside a container. */
export function validateAppStorageFolder(candidate: string): string {
  const trimmed = candidate.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) throw new AppStorageError("Use an absolute server path for App storage.");
  const resolved = path.resolve(trimmed);
  try {
    fs.mkdirSync(resolved, { recursive: true });
  } catch {
    throw new AppStorageError(`That folder does not exist and cannot be created: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) throw new AppStorageError("App storage must be a folder.");
  const probe = path.join(resolved, `.isputnik-write-test-${nanoid(8)}`);
  try {
    fs.writeFileSync(probe, "");
    fs.rmSync(probe, { force: true });
  } catch {
    throw new AppStorageError(`The app cannot write in that folder: ${resolved}`);
  }
  const real = fs.realpathSync(resolved);
  const roots = db.prepare("SELECT name, path FROM storage_roots").all() as Pick<StorageRootRow, "name" | "path">[];
  const container = roots.find((root) => samePath(root.path, real));
  if (container) {
    throw new AppStorageError(`That folder is the container "${container.name}". Choose a folder inside it, or one of its own, for App storage.`);
  }
  const libraries = db.prepare("SELECT name, source_path, role FROM libraries").all() as Pick<LibraryRow, "name" | "source_path" | "role">[];
  for (const library of libraries) {
    const source = path.resolve(library.source_path);
    if (pathIsInside(real, source)) {
      throw new AppStorageError(`That folder is inside the library "${library.name}". Choose one outside every library.`);
    }
    if (!library.role && pathIsInside(source, real)) {
      throw new AppStorageError(`The library "${library.name}" is inside that folder. App storage must not contain a library.`);
    }
  }
  return real;
}

const WALK_LIMIT = 250_000;
const STAT_BATCH = 64;

export interface FolderStats { files: number; bytes: number; complete: boolean }

/** Files and bytes under `dir`, stopping at WALK_LIMIT files; `complete` says
 *  whether it stopped. Asynchronous on purpose: a thumbnail store on a NAS array
 *  holds hundreds of thousands of files, and walking it with the sync calls froze
 *  the whole server for as long as the walk took, every time the Storage page was
 *  opened (4.6.0 on Unraid: every request stalled and the page said the server
 *  was not responding). Stats run a batch at a time so the walk yields between. */
export async function countFolder(dir: string | null): Promise<FolderStats> {
  const out: FolderStats = { files: 0, bytes: 0, complete: true };
  if (!dir) return out;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(current, { withFileTypes: true }); } catch { continue; }
    const files: string[] = [];
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile()) files.push(abs);
    }
    for (let i = 0; i < files.length; i += STAT_BATCH) {
      const sizes = await Promise.all(files.slice(i, i + STAT_BATCH).map((file) =>
        fs.promises.stat(file).then((stat) => stat.size, () => null)));
      for (const size of sizes) {
        if (size == null) continue;
        out.bytes += size;
        out.files += 1;
        if (out.files >= WALK_LIMIT) { out.complete = false; return out; }
      }
    }
  }
  return out;
}

// How long a count stands before the next page view counts again. Sizes of these
// folders change slowly; a page open every few seconds must not walk the disk each time.
const FOLDER_STATS_TTL_MS = 10 * 60 * 1000;
const folderStatsCache = new Map<string, { stats: FolderStats | null; at: number; counting: boolean }>();

/** The last count of `dir` without waiting for one: null until the first count
 *  finishes. A count starts in the background when there is none yet or the last
 *  one is older than FOLDER_STATS_TTL_MS, so a page read never touches the disk. */
export function cachedFolderStats(dir: string | null): FolderStats | null {
  if (!dir) return { files: 0, bytes: 0, complete: true };
  const key = path.resolve(dir);
  const entry = folderStatsCache.get(key);
  const stale = !entry || Date.now() - entry.at > FOLDER_STATS_TTL_MS;
  if (stale && !entry?.counting) {
    const next = { stats: entry?.stats ?? null, at: entry?.at ?? 0, counting: true };
    folderStatsCache.set(key, next);
    void countFolder(key)
      .then((stats) => folderStatsCache.set(key, { stats, at: Date.now(), counting: false }))
      .catch(() => folderStatsCache.set(key, { stats: next.stats, at: Date.now(), counting: false }));
  }
  return entry?.stats ?? null;
}

/** Forget a folder's count, after the app moved files into or out of it. */
export function forgetFolderStats(dir: string | null): void {
  if (dir) folderStatsCache.delete(path.resolve(dir));
}

/** Whether any file sits anywhere under `dir`: stops at the first one found. */
export function hasAnyFile(dir: string | null): boolean {
  if (!dir) return false;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
      else if (entry.isFile()) return true;
    }
  }
  return false;
}

export function statusOf(err: unknown): number {
  if (err instanceof AppStorageError) return err.statusCode;
  if (err instanceof TrashError) return err.statusCode;
  return 400;
}
