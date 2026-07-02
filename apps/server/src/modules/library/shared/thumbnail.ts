import fs from "node:fs";
import path from "node:path";
import { db } from "../../../db.js";
import { config } from "../../../config.js";
import { pathIsInside, normaliseRelativePath } from "./storage-roots.js";

export const thumbnailPathSettingKey = "library.thumbnail_path";

export function configuredThumbnailPathValue() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(thumbnailPathSettingKey) as { value: string } | undefined;
  return row?.value || config.thumbnailPath || "";
}

export function validateThumbnailPath(thumbnailPath: string) {
  const resolved = path.resolve(thumbnailPath);

  if (!path.isAbsolute(resolved)) {
    throw new Error("Use an absolute server path for thumbnail storage.");
  }

  fs.mkdirSync(resolved, { recursive: true });
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error("Thumbnail path must be a directory.");
  }

  fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK);
  return fs.realpathSync(resolved);
}

export function getConfiguredThumbnailPath() {
  const thumbnailPath = configuredThumbnailPathValue();
  if (!thumbnailPath) {
    throw new Error("Configure thumbnail storage before creating a library.");
  }

  return validateThumbnailPath(thumbnailPath);
}

export function thumbnailStorageKey(bucket: string, resourceId: string, fileName: string) {
  const shard = resourceId.slice(0, 4).padEnd(4, "0");
  return normaliseRelativePath(path.join(bucket, shard.slice(0, 2), shard.slice(2, 4), fileName));
}

export function thumbnailAbsolutePath(storageKey: string) {
  const root = getConfiguredThumbnailPath();
  const absolutePath = path.resolve(root, storageKey);
  if (!pathIsInside(absolutePath, root)) {
    throw new Error("Invalid thumbnail storage key.");
  }

  return absolutePath;
}

// Delete every generated thumbnail file for one library. Item covers/previews,
// series covers and gallery face crops are all stored under the library's bucket
// directory (thumbnailStorageKey(libraryId, …)), so removing that directory is the
// complete cleanup; the DB rows referencing the keys cascade away with the library.
// Best-effort: an unconfigured store or a missing directory is not an error.
export function removeThumbnailsForLibrary(libraryId: string): void {
  if (!libraryId) return;
  let root: string;
  try { root = getConfiguredThumbnailPath(); } catch { return; }
  const bucket = path.resolve(root, libraryId);
  // pathIsInside treats the root itself as inside, so also refuse bucket === root.
  if (bucket === root || !pathIsInside(bucket, root)) return;
  try { fs.rmSync(bucket, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// A top-level directory in the thumbnail store is a per-library bucket exactly when
// its name is a library id (nanoid(16)); "people" and "categories" are the shared
// cross-library buckets and never match this shape.
const LIBRARY_BUCKET_RE = /^[A-Za-z0-9_-]{16}$/;

// True when the directory tree holds nothing but generated .webp thumbnails.
// Anything else (a stray file, a symlink) disqualifies the bucket from sweeping.
function containsOnlyWebp(dir: string): boolean {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!containsOnlyWebp(path.join(dir, entry.name))) return false;
    } else if (!entry.isFile() || !entry.name.endsWith(".webp")) {
      return false;
    }
  }
  return true;
}

// Remove per-library thumbnail buckets whose library no longer exists — the mop-up
// for files orphaned by library deletes from before removeThumbnailsForLibrary ran
// on delete. Deleting directories warrants extra caution, so a candidate must look
// like a library id, must not belong to a live library, and must contain nothing
// but .webp files. Returns the number of buckets removed.
export function sweepOrphanLibraryThumbnails(): number {
  let root: string;
  try { root = getConfiguredThumbnailPath(); } catch { return 0; }
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return 0; }
  const liveIds = new Set(
    (db.prepare("SELECT id FROM libraries").all() as { id: string }[]).map((r) => r.id)
  );
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !LIBRARY_BUCKET_RE.test(entry.name) || liveIds.has(entry.name)) continue;
    const bucket = path.join(root, entry.name);
    if (!containsOnlyWebp(bucket)) continue;
    try { fs.rmSync(bucket, { recursive: true, force: true }); removed += 1; } catch { /* best-effort */ }
  }
  return removed;
}
