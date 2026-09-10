// The bin move — docs/app-storage-plan.md, decision 10.
//
// Changing the Recycle Bin's location used to be allowed only while the bin
// was empty. Now it moves what is in the bin instead: the setting flips first
// (so anything deleted from this moment lands in the new place), then the
// storage move task (storage-move.ts) carries every row whose files are still
// elsewhere over to the new location, one item at a time. It can do that
// because each trashed_items row records where its own files are (trash_root,
// null for the library's own .trash), so a half-finished move is not a broken
// bin — every row still points at real files, and restore and purge read the
// row, not the setting.
//
// Progress is not stored: it IS the count of rows whose trash_root differs
// from the current location. This file keeps the row-level move and the
// status shape the Recycle Bin page reads; the task itself is the shared one.
import fs from "node:fs";
import path from "node:path";
import { db } from "../../../db.js";
import { pathIsInside } from "./storage-roots.js";
import { getTrashRootSetting, moveEntry, trashPathFor, type TrashedItem } from "./trash.js";
import { cancelStorageMove, enqueueStorageMove, storageMoveStatus, waitForStorageMoves } from "./storage-move.js";

export interface TrashMoveFailure {
  id: string;
  title: string;
  libraryName: string;
  error: string;
}

export interface TrashMoveStatus {
  running: boolean;
  /** Rows still to move (recomputed from the table every time). */
  pending: number;
  /** Rows moved by the running move, or by the last one. */
  moved: number;
  /** The location being moved to: a folder, or null for each library's own .trash. */
  target: string | null;
  failed: TrashMoveFailure[];
  startedAt: string | null;
}

/** Rows whose files are not at the current location. Written before or during a
 *  move, or by an older version that changed the setting while the bin was empty
 *  (in which case there are none). */
export function pendingTrashMoveRows(): TrashedItem[] {
  const current = getTrashRootSetting();
  return db.prepare("SELECT * FROM trashed_items WHERE COALESCE(trash_root, '') != ? ORDER BY trashed_at")
    .all(current ?? "") as TrashedItem[];
}

export function trashMoveStatus(): TrashMoveStatus {
  const status = storageMoveStatus("trash");
  return {
    running: status.running,
    pending: pendingTrashMoveRows().length,
    moved: status.done,
    target: getTrashRootSetting(),
    failed: status.failed.map((f) => ({ id: f.name, title: f.title ?? f.name, libraryName: f.libraryName ?? "", error: f.error })),
    startedAt: status.startedAt
  };
}

/** Move one row's files from where they are to where the bin now is, and rewrite
 *  the row for the new layout. Throws on a filesystem problem; the row is only
 *  rewritten once the files are safely across. */
export function moveTrashedItemTo(item: TrashedItem, target: string | null): void {
  const fromBase = path.resolve(item.trash_root || item.source_path);
  const fromAbs = path.resolve(fromBase, item.trash_path);
  if (!pathIsInside(fromAbs, fromBase) || fromAbs === fromBase) {
    throw new Error("Refusing to move an item outside its bin folder.");
  }
  if (!fs.existsSync(fromAbs)) {
    throw new Error(`Its files are not where the bin says they are (${fromAbs}).`);
  }

  const token = path.posix.basename(item.trash_path);
  const toPath = trashPathFor(item.library_id, token, target);
  const toBase = path.resolve(target ?? item.source_path);
  const toAbs = path.resolve(toBase, toPath);
  if (toAbs === fromAbs) {
    db.prepare("UPDATE trashed_items SET trash_root = ?, trash_path = ? WHERE id = ?").run(target, toPath, item.id);
    return;
  }
  if (fs.existsSync(toAbs)) {
    throw new Error(`Something is already at ${toAbs}.`);
  }

  fs.mkdirSync(path.dirname(toAbs), { recursive: true });
  moveEntry(fromAbs, toAbs);
  db.prepare("UPDATE trashed_items SET trash_root = ?, trash_path = ? WHERE id = ?").run(target, toPath, item.id);

  // The folder that held the token dir (`.trash`, or `<bin>/<library>`) goes when
  // it is empty, as pruning does after a restore. Never the bin root itself.
  try {
    const container = path.dirname(fromAbs);
    if (container !== fromBase && fs.existsSync(container) && fs.readdirSync(container).length === 0) {
      fs.rmdirSync(container);
    }
  } catch {
    /* best-effort housekeeping */
  }
}

/** Queue carrying the bin's contents to the current location. A no-op while a
 *  move is already queued or running, or when nothing needs moving. Returns the
 *  status as it stands when the call returns (the move runs as a task). */
export function startTrashMove(userId: string | null = null): TrashMoveStatus {
  enqueueStorageMove({ kind: "trash", room: "trash", label: "Recycle Bin", from: null, to: getTrashRootSetting(), actorUserId: userId });
  return trashMoveStatus();
}

/** Stop after the item in hand. Every row is left correct: the ones moved are at
 *  the new location, the rest where they were, and each says which. */
export function cancelTrashMove(): TrashMoveStatus {
  cancelStorageMove("trash");
  return trashMoveStatus();
}

/** Failed rows are retried by starting again: a new task recomputes what is
 *  pending, failures included. */
export function resetTrashMoveFailures(): void {
  /* nothing to forget — the next start is a new task */
}

/** Test hook: run the move to the end. */
export async function waitForTrashMove(): Promise<TrashMoveStatus> {
  await waitForStorageMoves();
  return trashMoveStatus();
}
