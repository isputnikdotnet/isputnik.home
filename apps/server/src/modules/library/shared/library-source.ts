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
