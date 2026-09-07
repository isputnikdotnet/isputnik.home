import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { db } from "../../../db.js";
import { config } from "../../../config.js";
import { pathIsInside, normaliseRelativePath } from "./storage-roots.js";

// libvips keeps recently-read files in its own cache, and on Windows a cached
// file stays OPEN: anything sharp has read by path cannot be overwritten or
// deleted until the cache lets go of it. That turns ordinary work into silent
// failures — a preview that the copy check has looked at cannot be regenerated
// by the next scan (generateGalleryThumbnails catches the EBUSY and returns
// null, so the item quietly keeps a stale thumbnail), a library's thumbnails
// cannot be swept, a photo cannot be moved out of the way of its replacement.
//
// The cache buys nothing here: every file is decoded once, for one set of
// thumbnails, and never asked for again. Off it goes, process-wide, before any
// of this module's callers reach sharp. (faces/arcface.ts already turned it off
// for its own reasons; this makes it the rule rather than a side effect of
// having scanned a face.)
sharp.cache(false);

export const thumbnailPathSettingKey = "library.thumbnail_path";

/** Run image renders ONE AT A TIME, never as a Promise.all.
 *
 *  Two sharp pipelines reading the same source at the same time is not a
 *  performance question — it is a process-level hazard. When the source cannot be
 *  decoded (a truncated file, a text file with a .jpg name, an embedded cover that
 *  is not an image) libvips' error path is not safe against itself: the two
 *  failures race and Windows takes the process down on the spot with
 *  0xC0000409 / STATUS_STACK_BUFFER_OVERRUN. No exception, no stderr, nothing in
 *  the event log — the process is simply gone.
 *
 *  That is what killed one vitest worker every ~15 full-suite runs for months,
 *  losing a whole test file's results each time (test/helpers/crash-probe.ts is
 *  what finally caught it in the act). In production the same pair would take a
 *  library scan down with it, and a scan of a few thousand photos only needs one
 *  bad file to try it. A single failing pipeline is fine; it is the pair that
 *  kills. Reproduced outside vitest at 1-2 deaths per 8 processes x 300 rounds,
 *  and never once in 7,200 rounds over a readable image.
 *
 *  Serialising costs nothing: libvips already threads a single pipeline, so a
 *  12MP photo measures the same either way (101ms in parallel, 105ms in turn).
 *
 *  The queue is process-wide, not per call. Two renders racing is the hazard
 *  whether they come from one call or two — and they do come from two: the
 *  audiobook scanner works through four books at once, any of which may hold a
 *  cover that will not decode. A render is short, so the queue costs waiting that
 *  libvips would have made them do anyway.
 *
 *  Scope: the renders that meet a file for the FIRST time. Face crops and slideshow
 *  frames work from pictures the library has already decoded once, so they are not
 *  queued here — if that ever changes, they belong in it. */
let renderQueue: Promise<unknown> = Promise.resolve();

export function renderInTurn(renders: Array<() => Promise<unknown>>): Promise<void> {
  const run = renderQueue.then(async () => {
    for (const render of renders) await render();
  });
  // The chain must survive a failed render, or one unreadable file would stop
  // every later one from ever starting.
  renderQueue = run.catch(() => { /* the caller gets the rejection below */ });
  return run;
}

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

// The image extensions the cover route serves. Restricting to these stops the
// route being used to stream a non-thumbnail asset that lives in the same store
// (e.g. a rendered slideshow .mp4, whose own endpoint gates it per viewer).
const COVER_EXTENSIONS = new Set([".webp", ".jpg", ".jpeg", ".png"]);

// Resolve a cover storage key to its absolute path AND the top-level bucket it
// actually lands in — derived from the RESOLVED path, never the raw request
// string. An encoded-slash or ".." key (Fastify decodes %2f into the wildcard
// param) collapses on disk into a library bucket; deriving the bucket from the
// raw first segment let such a key dodge the access check while the read used the
// collapsed path. Returns null for a non-image key or one that escapes the store.
export function resolveCoverKey(storageKey: string): { absolutePath: string; bucket: string } | null {
  if (!COVER_EXTENSIONS.has(path.extname(storageKey).toLowerCase())) return null;
  let root: string;
  try {
    root = getConfiguredThumbnailPath();
  } catch {
    return null;
  }
  const absolutePath = path.resolve(root, storageKey);
  if (!pathIsInside(absolutePath, root)) return null;
  const bucket = path.relative(root, absolutePath).split(path.sep)[0] ?? "";
  return { absolutePath, bucket };
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
// cross-library buckets and never match this shape. Exported so the cover route can
// tell a library-scoped key (which needs a library-access check) from a shared one.
export const LIBRARY_BUCKET_RE = /^[A-Za-z0-9_-]{16}$/;

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
