// System data on the Storage page — docs/system-data-plan.md, phase 2.
//
// The setting and its resolvers are core/system-data.ts; this is what the page
// shows (the folder, the database, thumbnails, backups, metadata, disk space)
// and the three changes it offers: the folder itself, and thumbnails or backups
// on their own. Every change that leaves files behind carries them over as a
// storage move task (storage-move.ts), queued after the setting flips.
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { config } from "../../config.js";
import { db, logActivity } from "../../db.js";
import {
  diskSpace,
  getSystemDataPath,
  resolveBackupPath,
  resolveMetadataPath,
  sameDisk,
  saveBackupPathSetting,
  saveSystemDataPath,
  suggestedSystemDataPath,
  SYSTEM_DATA_FOLDERS,
  systemDataFolder,
  type BackupPathSource,
  type MetadataPathSource
} from "../../core/system-data.js";
import {
  thumbnailPathSettingKey,
  thumbnailPathSource,
  validateThumbnailPath,
  type ThumbnailPathSource
} from "./shared/thumbnail.js";
import {
  anyStorageMoveActive,
  cancelStorageMove,
  enqueueStorageMove,
  retryStorageMove,
  storageMoveStatus,
  type StorageMoveStatus
} from "./shared/storage-move.js";
import { startFolderMove } from "./shared/folder-move.js";
import { folderStats, type FolderStats } from "./app-storage-contents.js";
import { pathIsInside } from "./shared/storage-roots.js";
import { NAME_PATTERN } from "../backups/run.js";
import type { LibraryRow, StorageRootRow } from "../../db/rows.js";

export class SystemDataError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "SystemDataError";
  }
}

export type SystemDataMoveRoom = "thumbnails" | "backups" | "metadata";

export interface SystemDataView {
  /** The folder chosen, or null until an admin picks one. */
  path: string | null;
  /** What the picker offers: the folder next to the database's own. */
  suggested: string;
  /** Why the chosen folder cannot be used right now, "" when it is fine. */
  problem: string;
  database: string;
  /** Free and total bytes on the disk of the folder (or of the suggestion, while unset). */
  space: { free: number; total: number } | null;
  thumbnails: {
    path: string | null;
    source: ThumbnailPathSource | null;
    problem: string;
    stats: FolderStats;
    move: StorageMoveStatus;
  };
  backups: {
    path: string;
    source: BackupPathSource;
    count: number;
    bytes: number;
    /** Backups on the database's disk die with it; the row says so. */
    sameDiskAsDatabase: boolean;
    move: StorageMoveStatus;
  };
  metadata: { path: string | null; source: MetadataPathSource | null; move: StorageMoveStatus };
  /** A storage move is queued or running somewhere: the folder must not change under it. */
  moving: boolean;
}

const samePath = (a: string | null | undefined, b: string | null | undefined): boolean =>
  Boolean(a && b) && path.resolve(a!) === path.resolve(b!);

/** Why a folder cannot be used, in a sentence rather than as an fs error code. A
 *  folder that is merely missing is not a problem: it is made on demand. */
export function folderProblem(folder: string): string {
  if (!path.isAbsolute(folder)) return "Use an absolute server path.";
  try {
    if (!fs.statSync(folder).isDirectory()) return "That path is a file, not a folder.";
    fs.accessSync(folder, fs.constants.R_OK | fs.constants.W_OK);
    return "";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") return "The app cannot read and write in that folder.";
    try {
      fs.mkdirSync(folder, { recursive: true });
      return "";
    } catch {
      return "That folder does not exist and cannot be created.";
    }
  }
}

/** Make the folder if need be, prove the app can write in it, and hand back its
 *  real path. `what` names it in the errors ("System data", "Backups"). */
function writableFolder(candidate: string, what: string): string {
  const trimmed = candidate.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) throw new SystemDataError(`Use an absolute server path for ${what}.`);
  const resolved = path.resolve(trimmed);
  try {
    fs.mkdirSync(resolved, { recursive: true });
  } catch {
    throw new SystemDataError(`That folder does not exist and cannot be created: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) throw new SystemDataError(`${what} must be a folder.`);
  const probe = path.join(resolved, `.isputnik-write-test-${nanoid(8)}`);
  try {
    fs.writeFileSync(probe, "");
    fs.rmSync(probe, { force: true });
  } catch {
    throw new SystemDataError(`The app cannot write in that folder: ${resolved}`);
  }
  return fs.realpathSync(resolved);
}

/** Outside every library (a scan would catalogue thumbnails and backups), and
 *  containing none but the app's own system libraries. */
function assertOutsideLibraries(real: string, what: string): void {
  const libraries = db.prepare("SELECT name, source_path, role FROM libraries").all() as Pick<LibraryRow, "name" | "source_path" | "role">[];
  for (const library of libraries) {
    const source = path.resolve(library.source_path);
    if (pathIsInside(real, source)) {
      throw new SystemDataError(`That folder is inside the library "${library.name}". Choose one outside every library for ${what}.`);
    }
    if (!library.role && pathIsInside(source, real)) {
      throw new SystemDataError(`The library "${library.name}" is inside that folder. ${what} must not contain a library.`);
    }
  }
}

/** Vet a candidate system data folder (decision 16): absolute, exists or can be
 *  made, writable, outside every library, and not a container itself. It does not
 *  have to be inside a container: containers approve folders people browse. */
export function validateSystemDataPath(candidate: string): string {
  const real = writableFolder(candidate, "system data");
  const roots = db.prepare("SELECT name, path FROM storage_roots").all() as Pick<StorageRootRow, "name" | "path">[];
  const container = roots.find((root) => samePath(root.path, real));
  if (container) {
    throw new SystemDataError(`That folder is the container "${container.name}". Choose a folder of its own for system data.`);
  }
  assertOutsideLibraries(real, "system data");
  return real;
}

function backupFiles(dir: string): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!NAME_PATTERN.test(name)) continue;
      count += 1;
      try { bytes += fs.statSync(path.join(dir, name)).size; } catch { /* gone meanwhile */ }
    }
  } catch {
    /* no folder yet */
  }
  return { count, bytes };
}

export function systemDataView(): SystemDataView {
  const chosen = getSystemDataPath();
  const suggested = suggestedSystemDataPath();
  const thumbs = thumbnailPathSource();
  const backups = resolveBackupPath();
  const metadata = resolveMetadataPath();
  const backupStats = backupFiles(backups.path);
  return {
    path: chosen,
    suggested,
    problem: chosen ? folderProblem(chosen) : "",
    database: path.resolve(config.dbPath),
    space: diskSpace(chosen ?? suggested),
    thumbnails: {
      path: thumbs?.path ?? null,
      source: thumbs?.source ?? null,
      problem: thumbs ? folderProblem(thumbs.path) : "",
      stats: folderStats(thumbs?.path ?? null),
      move: storageMoveStatus("thumbnails")
    },
    backups: {
      path: backups.path,
      source: backups.source,
      count: backupStats.count,
      bytes: backupStats.bytes,
      sameDiskAsDatabase: sameDisk(backups.path, path.dirname(path.resolve(config.dbPath))),
      move: storageMoveStatus("backups")
    },
    metadata: { path: metadata?.path ?? null, source: metadata?.source ?? null, move: storageMoveStatus("metadata") },
    moving: anyStorageMoveActive()
  };
}

/** Choose system data, or change it. Thumbnails, backups and metadata that follow
 *  system data (no folder of their own, no environment variable) are carried to
 *  the new folder as storage move tasks; the ones with a place of their own stay
 *  where they are. The database never moves. */
export function setSystemDataPath(candidate: string, userId: string, ip = ""): SystemDataView {
  const wanted = validateSystemDataPath(candidate);
  const before = getSystemDataPath();
  if (samePath(before, wanted)) return systemDataView();
  if (before && anyStorageMoveActive()) {
    throw new SystemDataError("A storage move is running right now. Wait for it to finish, or cancel it on the Tasks page, before changing system data.", 409);
  }

  // Who follows system data, decided before the setting flips.
  const followers = {
    thumbnails: thumbnailPathSource()?.source === "system",
    backups: resolveBackupPath().source === "system",
    metadata: resolveMetadataPath()?.source === "system"
  };

  saveSystemDataPath(wanted, userId);
  for (const folder of Object.values(SYSTEM_DATA_FOLDERS)) {
    try { fs.mkdirSync(path.join(wanted, folder), { recursive: true }); } catch { /* reported by the row */ }
  }

  if (before) {
    const from = (folder: keyof typeof SYSTEM_DATA_FOLDERS) => systemDataFolder(folder, before)!;
    const to = (folder: keyof typeof SYSTEM_DATA_FOLDERS) => systemDataFolder(folder, wanted)!;
    if (followers.thumbnails) startFolderMove(from("thumbnails"), to("thumbnails"), userId);
    if (followers.backups) {
      enqueueStorageMove({ kind: "backups", room: "backups", label: "Backups", from: from("backups"), to: to("backups"), actorUserId: userId });
    }
    if (followers.metadata) {
      enqueueStorageMove({ kind: "metadata", room: "metadata", label: "Metadata", from: from("metadata"), to: to("metadata"), actorUserId: userId });
    }
  }

  logActivity({
    event: "config.updated",
    actorUserId: userId,
    targetType: "setting",
    targetId: "system_data",
    detail: before
      ? `System data moved from ${before} to ${wanted}; carrying ${[followers.thumbnails && "thumbnails", followers.backups && "backups", followers.metadata && "metadata"].filter(Boolean).join(", ") || "nothing"} along.`
      : `System data set to ${wanted}.`,
    ipAddress: ip || undefined
  });
  return systemDataView();
}

/** Give thumbnails a folder of their own, or (null) send them back to system data.
 *  What is in the old folder follows as a move task. */
export function setThumbnailFolder(candidate: string | null, userId: string, ip = ""): SystemDataView {
  if (storageMoveStatus("thumbnails").running) {
    throw new SystemDataError("The thumbnails are being moved right now. Wait for that to finish, or cancel it, before changing the folder again.", 409);
  }
  const before = thumbnailPathSource()?.path ?? null;
  let after: string;
  if (candidate?.trim()) {
    const real = writableFolder(candidate, "thumbnails");
    assertOutsideLibraries(real, "thumbnails");
    after = validateThumbnailPath(real);
    db.prepare(
      `INSERT INTO app_settings (key, value, updated_by, updated_at)
       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    ).run(thumbnailPathSettingKey, after, userId);
  } else {
    const fallback = config.thumbnailPath || systemDataFolder("thumbnails");
    if (!fallback) throw new SystemDataError("Choose system data first: without it, thumbnails would have nowhere to go.", 409);
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(thumbnailPathSettingKey);
    after = validateThumbnailPath(fallback);
  }
  if (before && !samePath(before, after)) startFolderMove(before, after, userId);
  logActivity({
    event: "config.updated",
    actorUserId: userId,
    targetType: "setting",
    targetId: thumbnailPathSettingKey,
    detail: `Thumbnails: ${candidate?.trim() ? `a folder of their own, ${after}` : `back to ${after}`}${before && !samePath(before, after) ? `; carrying them over from ${before}` : ""}.`,
    ipAddress: ip || undefined
  });
  return systemDataView();
}

/** Give backups a folder of their own, or (null) send them back to BACKUP_PATH or
 *  system data. The backups already made follow as a move task. */
export function setBackupFolder(candidate: string | null, userId: string, ip = ""): SystemDataView {
  if (storageMoveStatus("backups").running) {
    throw new SystemDataError("The backups are being moved right now. Wait for that to finish, or cancel it, before changing the folder again.", 409);
  }
  const before = resolveBackupPath().path;
  let wanted: string | null = null;
  if (candidate?.trim()) {
    wanted = writableFolder(candidate, "backups");
    assertOutsideLibraries(wanted, "backups");
  }
  saveBackupPathSetting(wanted, userId);
  const after = resolveBackupPath().path;
  fs.mkdirSync(after, { recursive: true });
  if (!samePath(before, after)) {
    enqueueStorageMove({ kind: "backups", room: "backups", label: "Backups", from: before, to: after, actorUserId: userId });
  }
  logActivity({
    event: "config.updated",
    actorUserId: userId,
    targetType: "setting",
    targetId: "backup_path",
    detail: `Backups: ${wanted ? `a folder of their own, ${wanted}` : `back to ${after}`}${!samePath(before, after) ? `; carrying them over from ${before}` : ""}.`,
    ipAddress: ip || undefined
  });
  return systemDataView();
}

export function retrySystemDataMove(room: SystemDataMoveRoom, userId: string): SystemDataView {
  retryStorageMove(room, userId);
  return systemDataView();
}

export function cancelSystemDataMove(room: SystemDataMoveRoom): SystemDataView {
  cancelStorageMove(room);
  return systemDataView();
}
