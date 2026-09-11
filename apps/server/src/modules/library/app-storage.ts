// App storage's rooms — docs/app-storage-plan.md, phase 1. The setting itself is
// core/app-storage.ts; this is what the Storage page shows for each room, and the
// switches that move a room between "use App storage", "its own place" and "off".
//
// Every switch is one room. Choosing the App storage folder records a path and
// nothing else; changing it later carries each room that uses it along, or
// leaves the room where it is, as the admin chose for that room.
//
// This file holds what the rest share — the error, the library rows, the folder
// check. The rooms' state is app-storage-rooms.ts, the switches
// app-storage-switch.ts, and the folder itself app-storage-path.ts.
import fs from "node:fs";
import path from "node:path";
import { db } from "../../db.js";
import { parsePolicy } from "../../core/permissions.js";
import {
  APP_ROOM_FOLDERS,
  LEGACY_ROOM_FOLDERS,
  isInsideAppStorage,
  resolveAppLocation
} from "../../core/app-storage.js";
import { findStorageRootForPath, pathIsInside } from "./shared/storage-roots.js";
import { TrashError } from "./shared/trash-settings.js";

export class AppStorageError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "AppStorageError";
  }
}

export interface GalleryLibraryRow {
  id: string;
  name: string;
  source_path: string;
  policy_json: string;
  scan_status: string;
}

export const samePath = (a: string | null | undefined, b: string | null | undefined): boolean =>
  Boolean(a && b) && path.resolve(a!) === path.resolve(b!);

export function galleryLibraries(): GalleryLibraryRow[] {
  return db.prepare("SELECT id, name, source_path, policy_json, scan_status FROM libraries WHERE type = 'gallery' ORDER BY name COLLATE NOCASE")
    .all() as GalleryLibraryRow[];
}

export function inboxLibraries(): GalleryLibraryRow[] {
  return galleryLibraries().filter((row) => parsePolicy(row.policy_json).inbox === true);
}

export function libraryAt(sourcePath: string | null): GalleryLibraryRow | null {
  if (!sourcePath) return null;
  return galleryLibraries().find((row) => samePath(row.source_path, sourcePath)) ?? null;
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

// ── The folder itself ───────────────────────────────────────────────────────

/** Vet a candidate App storage folder the way a library source is vetted: it must
 *  exist, sit inside an approved container (but not BE one — its rooms would sit
 *  beside libraries), and be outside every library. It may contain the libraries
 *  its own rooms made, and nothing else. */
export function validateAppStoragePath(candidate: string, opts: { allowRoomLibraries?: boolean } = {}): string {
  const resolved = path.resolve(candidate);
  if (!path.isAbsolute(resolved)) throw new AppStorageError("Use an absolute server path for App storage.");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new AppStorageError(`That folder is missing or not accessible: ${resolved}`);
  }
  if (!stat.isDirectory()) throw new AppStorageError("App storage must be a folder.");
  const real = fs.realpathSync(resolved);
  const root = findStorageRootForPath(real);
  if (!root) throw new AppStorageError("Choose a folder inside a configured Digital Library container.");
  if (path.resolve(root.path) === real) {
    throw new AppStorageError("Choose a folder inside the container, not the container itself: the app makes its own folders in it.");
  }
  const roomPaths = new Set([...Object.values(APP_ROOM_FOLDERS), ...Object.values(LEGACY_ROOM_FOLDERS)].map((folder) => path.join(real, folder)));
  const libraries = db.prepare("SELECT name, source_path FROM libraries").all() as { name: string; source_path: string }[];
  for (const library of libraries) {
    const source = path.resolve(library.source_path);
    if (pathIsInside(real, source)) {
      throw new AppStorageError(`That folder is inside the library "${library.name}". Choose one outside every library.`);
    }
    if (pathIsInside(source, real) && !(opts.allowRoomLibraries && roomPaths.has(source))) {
      throw new AppStorageError(`The library "${library.name}" is inside that folder. App storage must not contain a library.`);
    }
  }
  return real;
}

export function statusOf(err: unknown): number {
  if (err instanceof AppStorageError) return err.statusCode;
  if (err instanceof TrashError) return err.statusCode;
  return 400;
}

/** True when a path resolves into App storage — for the pages that say
 *  "made in App storage" beside a library. */
export { isInsideAppStorage, resolveAppLocation };
