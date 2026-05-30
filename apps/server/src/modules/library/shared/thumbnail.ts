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
