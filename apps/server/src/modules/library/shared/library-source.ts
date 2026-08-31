import fs from "node:fs";
import path from "node:path";
import { findStorageRootForPath } from "./storage-roots.js";
import { getConfiguredThumbnailPath } from "./thumbnail.js";

// A library's configured source folder can't be used: missing, not a directory,
// not readable, or outside every configured container. These are permanent
// configuration problems, not transient failures — the scan queue fails the job
// immediately rather than retrying for minutes while the library sits on "scanning".
export class LibrarySourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibrarySourceError";
  }
}

export function validateLibrarySource(sourcePath: string) {
  const resolved = path.resolve(sourcePath);

  if (!path.isAbsolute(resolved)) {
    throw new LibrarySourceError("Use an absolute server path for the library source.");
  }

  // Covers both a missing folder and one we can't read (permissions, unmounted NAS).
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new LibrarySourceError(`Library source folder is missing or not accessible: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new LibrarySourceError(`Library source path is not a folder: ${resolved}`);
  }

  const realSource = fs.realpathSync(resolved);
  const allowedRoot = findStorageRootForPath(realSource);
  if (!allowedRoot) {
    throw new LibrarySourceError("Choose a folder inside a configured Digital Library container.");
  }

  const realThumbnailRoot = fs.realpathSync(getConfiguredThumbnailPath());
  if (realSource === realThumbnailRoot || realSource.startsWith(`${realThumbnailRoot}${path.sep}`)) {
    throw new LibrarySourceError("Library source path cannot be inside thumbnail storage.");
  }

  return realSource;
}

/**
 * Whether a library's source folder can actually be WRITTEN to, which
 * validateLibrarySource deliberately does not tell you — it proves the folder exists and
 * sits inside an allowed storage root, and a read-only mount passes both.
 *
 * The check is a real probe rather than fs.access(W_OK): on Windows W_OK reports nothing
 * useful, and on a network/overlay mount the permission bits can disagree with what a
 * write actually does. A temp file is created and removed; the name is dot-prefixed so a
 * scanner would skip it even if a crash stranded one.
 */
export function sourceIsWritable(sourcePath: string): { ok: true } | { ok: false; reason: string } {
  let root: string;
  try {
    root = validateLibrarySource(sourcePath);
  } catch (err) {
    return { ok: false, reason: err instanceof LibrarySourceError ? err.message : "The library folder is not reachable." };
  }
  const probe = path.join(root, `.write-probe-${process.pid}-${Date.now().toString(36)}`);
  try {
    fs.writeFileSync(probe, "");
    return { ok: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason: code === "EROFS" || code === "EACCES" || code === "EPERM"
        ? "This library's folder is read-only. On Unraid, set its Media Storage path to Read/Write."
        : `Can't write to this library's folder: ${err instanceof Error ? err.message : String(err)}`
    };
  } finally {
    try { fs.rmSync(probe, { force: true }); } catch { /* best-effort */ }
  }
}
