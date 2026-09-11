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
// from the current location. This file keeps the status shape the Recycle Bin
// page reads; the task itself is the shared one, and the row-level move it runs
// (pendingTrashMoveRows, moveTrashedItemTo) lives with it in storage-move.ts, so
// the two files import in one direction only.
import { getTrashRootSetting } from "./trash-settings.js";
import {
  cancelStorageMove,
  enqueueStorageMove,
  pendingTrashMoveRows,
  storageMoveStatus,
  waitForStorageMoves
} from "./storage-move.js";

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

/** Queue carrying the bin's contents to the current location. A no-op while a
 *  move is already queued or running, or when nothing needs moving. `from` is
 *  the location the bin had until now (null for each library's own .trash): the
 *  rows say where their own files are, but the originals Replace file set aside
 *  under `replaced/` have no rows, and are carried from there. Returns the
 *  status as it stands when the call returns (the move runs as a task). */
export function startTrashMove(userId: string | null = null, from: string | null = null): TrashMoveStatus {
  enqueueStorageMove({ kind: "trash", room: "trash", label: "Recycle Bin", from, to: getTrashRootSetting(), actorUserId: userId });
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
