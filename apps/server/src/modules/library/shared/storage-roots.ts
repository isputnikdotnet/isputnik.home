import fs from "node:fs";
import path from "node:path";
import { db } from "../../../db.js";
import type { StorageRootRow as DbStorageRootRow } from "../../../db/rows.js";

export interface StorageRootRow extends Pick<DbStorageRootRow, "id" | "name" | "path" | "created_at" | "updated_at"> {
  library_count: number;
}

export function pathIsInside(candidatePath: string, rootPath: string) {
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${path.sep}`);
}

export function normaliseRelativePath(value: string) {
  return value.split(path.sep).join("/");
}

export function validateStorageRootPath(rootPath: string) {
  const resolved = path.resolve(rootPath);

  if (!path.isAbsolute(resolved)) {
    throw new Error("Use an absolute server path for the storage container.");
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error("Storage container path must be an existing directory.");
  }

  fs.accessSync(resolved, fs.constants.R_OK);
  return fs.realpathSync(resolved);
}

export function findStorageRootForPath(sourcePath: string) {
  const roots = db.prepare("SELECT id, path FROM storage_roots").all() as Pick<DbStorageRootRow, "id" | "path">[];
  return roots.find((root) => pathIsInside(sourcePath, root.path));
}

export function relativePathWithinRoot(rootPath: string, requestedRelativePath: string) {
  const candidate = path.resolve(rootPath, requestedRelativePath || ".");
  const realCandidate = fs.realpathSync(candidate);
  if (!pathIsInside(realCandidate, rootPath)) {
    throw new Error("Selected folder is outside the storage container.");
  }

  if (!fs.statSync(realCandidate).isDirectory()) {
    throw new Error("Selected path must be a directory.");
  }

  return realCandidate;
}

export function publicStorageRoot(row: StorageRootRow) {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    libraryCount: row.library_count
  };
}
