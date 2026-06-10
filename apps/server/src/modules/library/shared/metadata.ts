import fs from "node:fs";
import path from "node:path";
import { config } from "../../../config.js";
import { pathIsInside, normaliseRelativePath } from "./storage-roots.js";

function metadataStorageKey(bookId: string) {
  const shard = bookId.slice(0, 4).padEnd(4, "0");
  return normaliseRelativePath(path.join(shard.slice(0, 2), shard.slice(2, 4), `${bookId}.json`));
}

function metadataRoot() {
  return config.metadataPath ? path.resolve(config.metadataPath) : null;
}

function metadataAbsolutePath(storageKey: string) {
  const root = metadataRoot();
  if (!root) {
    return null;
  }

  const absolutePath = path.resolve(root, storageKey);
  if (!pathIsInside(absolutePath, root)) {
    throw new Error("Invalid metadata storage key.");
  }

  return absolutePath;
}

export function writeMetadataExport(bookId: string, data: Record<string, unknown>) {
  const storageKey = metadataStorageKey(bookId);
  const absolutePath = metadataAbsolutePath(storageKey);
  if (!absolutePath) {
    return;
  }

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, JSON.stringify(data, null, 2), "utf8");
}
