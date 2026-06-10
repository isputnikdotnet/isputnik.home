import fs from "node:fs";
import path from "node:path";
import { findStorageRootForPath } from "./storage-roots.js";
import { getConfiguredThumbnailPath } from "./thumbnail.js";

export function validateLibrarySource(sourcePath: string) {
  const resolved = path.resolve(sourcePath);
  const thumbnailPath = getConfiguredThumbnailPath();

  if (!path.isAbsolute(resolved)) {
    throw new Error("Use an absolute server path for the library source.");
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error("Library source path must be an existing directory.");
  }

  const realSource = fs.realpathSync(resolved);
  const allowedRoot = findStorageRootForPath(realSource);
  if (!allowedRoot) {
    throw new Error("Choose a folder inside a configured Digital Library container.");
  }

  const realThumbnailRoot = fs.realpathSync(thumbnailPath);
  if (realSource === realThumbnailRoot || realSource.startsWith(`${realThumbnailRoot}${path.sep}`)) {
    throw new Error("Library source path cannot be inside thumbnail storage.");
  }

  return realSource;
}
