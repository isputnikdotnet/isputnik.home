// The thumbnail folder move — docs/app-storage-plan.md, phase 3.
//
// When the thumbnail room changes, the store can be gigabytes, so it is carried
// over one top-level entry at a time (a library's bucket, the people bucket, a
// render bucket) by the storage move task (storage-move.ts). The setting has
// already flipped when that starts, so new thumbnails land in the new folder at
// once, and an entry a scan has meanwhile recreated there is merged into rather
// than refused. This file keeps the status shape the Storage page reads and the
// entry mover the backups carry uses; the task itself is the shared one.
import fs from "node:fs";
import path from "node:path";
import { cancelStorageMove, enqueueStorageMove, storageMoveStatus, waitForStorageMoves } from "./storage-move.js";

export interface FolderMoveStatus {
  running: boolean;
  from: string | null;
  to: string | null;
  /** Top-level entries carried over by the running move, or by the last one. */
  done: number;
  /** Top-level entries still in the old folder. */
  pending: number;
  failed: { name: string; error: string }[];
}

export function folderMoveStatus(): FolderMoveStatus {
  const status = storageMoveStatus("thumbnails");
  return {
    running: status.running,
    from: status.from,
    to: status.to,
    done: status.done,
    pending: status.pending,
    failed: status.failed.map((f) => ({ name: f.name, error: f.error }))
  };
}

/** Carry one top-level entry across. Rename when the volumes allow; copy then
 *  delete when they do not; merge into an entry that already exists at the
 *  destination, keeping the destination's copy of any file both hold. Used for
 *  the backups carried on a folder change; the task has a verified copy of its own. */
export function moveEntryAcross(from: string, to: string, name: string): void {
  const source = path.join(from, name);
  const target = path.join(to, name);
  fs.mkdirSync(to, { recursive: true });
  if (!fs.existsSync(target)) {
    try {
      fs.renameSync(source, target);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    }
  }
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: false });
  } else if (!fs.existsSync(target)) {
    fs.copyFileSync(source, target);
  }
  fs.rmSync(source, { recursive: true, force: true });
}

/** Queue carrying everything in `from` to `to`. A no-op while a move is queued
 *  or running, or when there is nothing in `from`. */
export function startFolderMove(from: string, to: string, userId: string | null = null): FolderMoveStatus {
  if (path.resolve(from) !== path.resolve(to)) {
    enqueueStorageMove({ kind: "thumbnails", room: "thumbnails", label: "Thumbnails", from, to, actorUserId: userId });
  }
  return folderMoveStatus();
}

export function cancelFolderMove(): FolderMoveStatus {
  cancelStorageMove("thumbnails");
  return folderMoveStatus();
}

/** Test hook: run the move to the end. */
export async function waitForFolderMove(): Promise<FolderMoveStatus> {
  await waitForStorageMoves();
  return folderMoveStatus();
}
