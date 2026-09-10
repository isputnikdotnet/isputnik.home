// The bin move — docs/app-storage-plan.md, decision 10.
//
// Changing the Recycle Bin's location used to be allowed only while the bin
// was empty. Now it moves what is in the bin instead: the setting flips first
// (so anything deleted from this moment lands in the new place), then this job
// carries every row whose files are still elsewhere over to the new location,
// one item at a time. It can do that because each trashed_items row records
// where its own files are (trash_root, null for the library's own .trash), so
// a half-finished move is not a broken bin — every row still points at real
// files, and restore and purge read the row, not the setting.
//
// Progress is not stored: it IS the count of rows whose trash_root differs
// from the current location. A marker in app_settings says a move was under
// way, so a restart resumes it rather than leaving the rows where they were.
import fs from "node:fs";
import path from "node:path";
import { db } from "../../../db.js";
import { pathIsInside } from "./storage-roots.js";
import { getTrashRootSetting, moveEntry, setMovingTrashedItem, trashPathFor, type TrashedItem } from "./trash.js";

const MOVE_MARKER_KEY = "trash_move_in_progress";

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
  /** Rows moved since this move started. */
  moved: number;
  /** The location being moved to: a folder, or null for each library's own .trash. */
  target: string | null;
  failed: TrashMoveFailure[];
  startedAt: string | null;
}

let running = false;
let cancelRequested = false;
let moved = 0;
let startedAt: string | null = null;
let failed: TrashMoveFailure[] = [];

/** Rows whose files are not at the current location. Written before or during a
 *  move, or by an older version that changed the setting while the bin was empty
 *  (in which case there are none). */
export function pendingTrashMoveRows(): TrashedItem[] {
  const current = getTrashRootSetting();
  return db.prepare("SELECT * FROM trashed_items WHERE COALESCE(trash_root, '') != ? ORDER BY trashed_at")
    .all(current ?? "") as TrashedItem[];
}

export function trashMoveStatus(): TrashMoveStatus {
  return {
    running,
    pending: pendingTrashMoveRows().length,
    moved,
    target: getTrashRootSetting(),
    failed,
    startedAt
  };
}

function setMarker(on: boolean): void {
  if (on) {
    db.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, '1', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at`
    ).run(MOVE_MARKER_KEY);
  } else {
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(MOVE_MARKER_KEY);
  }
}

function markerSet(): boolean {
  return Boolean(db.prepare("SELECT 1 FROM app_settings WHERE key = ?").get(MOVE_MARKER_KEY));
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

async function run(): Promise<void> {
  try {
    for (;;) {
      if (cancelRequested) break;
      const target = getTrashRootSetting();
      const failedIds = new Set(failed.map((f) => f.id));
      const next = pendingTrashMoveRows().find((row) => !failedIds.has(row.id));
      if (!next) break;
      setMovingTrashedItem(next.id);
      try {
        moveTrashedItemTo(next, target);
        moved += 1;
      } catch (err) {
        failed.push({
          id: next.id,
          title: next.title,
          libraryName: next.library_name,
          error: err instanceof Error ? err.message : String(err)
        });
      } finally {
        setMovingTrashedItem(null);
      }
      // Give the event loop a turn between items: a bin of thousands must not hold
      // every request until it is done.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    running = false;
    cancelRequested = false;
    setMarker(false);
  }
}

/** Start carrying the bin's contents to the current location. A no-op while a
 *  move is already running, or when nothing needs moving. Returns the status
 *  as it stands when the call returns (the move itself runs in the background). */
export function startTrashMove(): TrashMoveStatus {
  if (!running && pendingTrashMoveRows().length > 0) {
    running = true;
    cancelRequested = false;
    moved = 0;
    failed = [];
    startedAt = new Date().toISOString();
    setMarker(true);
    void run();
  }
  return trashMoveStatus();
}

/** Stop after the item in hand. Every row is left correct: the ones moved are at
 *  the new location, the rest where they were, and each says which. */
export function cancelTrashMove(): TrashMoveStatus {
  if (running) cancelRequested = true;
  return trashMoveStatus();
}

/** Failed rows are retried by starting again; forgetting them is what lets the
 *  next start try them. */
export function resetTrashMoveFailures(): void {
  failed = [];
}

/** Called once at startup: a move that a restart interrupted picks up where it
 *  left off, since the rows it had not reached still say they are elsewhere. */
export function resumeTrashMoveOnStartup(): boolean {
  if (!markerSet()) return false;
  if (pendingTrashMoveRows().length === 0) {
    setMarker(false);
    return false;
  }
  startTrashMove();
  return true;
}

/** Test hook: wait for the running move to finish. */
export async function waitForTrashMove(): Promise<TrashMoveStatus> {
  while (running) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  return trashMoveStatus();
}
