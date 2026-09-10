// A folder move that runs in the background — docs/app-storage-plan.md, phase 3.
//
// Used for the thumbnail store when its room changes: the store can be gigabytes,
// so it is carried over one top-level entry at a time (a library's bucket, the
// people bucket, a render bucket), yielding to the event loop between entries. The
// setting has already flipped when this starts, so new thumbnails land in the new
// folder at once and an entry that a scan has meanwhile recreated there is merged
// into rather than refused. A marker in app_settings remembers an unfinished move
// across a restart.
import fs from "node:fs";
import path from "node:path";
import { db } from "../../../db.js";

const MARKER_KEY = "folder_move_in_progress";

export interface FolderMoveStatus {
  running: boolean;
  from: string | null;
  to: string | null;
  /** Top-level entries carried over since the move started. */
  done: number;
  /** Top-level entries still in the old folder. */
  pending: number;
  failed: { name: string; error: string }[];
}

let running = false;
let cancelRequested = false;
let current: { from: string; to: string } | null = null;
let done = 0;
let failed: { name: string; error: string }[] = [];

function pendingEntries(from: string): string[] {
  try {
    return fs.readdirSync(from).filter((name) => !name.startsWith(".upload-"));
  } catch {
    return [];
  }
}

export function folderMoveStatus(): FolderMoveStatus {
  return {
    running,
    from: current?.from ?? null,
    to: current?.to ?? null,
    done,
    pending: current ? pendingEntries(current.from).filter((name) => !failed.some((f) => f.name === name)).length : 0,
    failed
  };
}

/** Carry one top-level entry across. Rename when the volumes allow; copy then
 *  delete when they do not; merge into an entry that already exists at the
 *  destination (a scan may have written there since the setting flipped),
 *  keeping the destination's copy of any file both hold. */
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

async function run(): Promise<void> {
  try {
    while (current && !cancelRequested) {
      const next = pendingEntries(current.from).find((name) => !failed.some((f) => f.name === name));
      if (!next) break;
      try {
        moveEntryAcross(current.from, current.to, next);
        done += 1;
      } catch (err) {
        failed.push({ name: next, error: err instanceof Error ? err.message : String(err) });
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    running = false;
    cancelRequested = false;
    if (current && failed.length === 0 && pendingEntries(current.from).length === 0) {
      try { fs.rmdirSync(current.from); } catch { /* someone else's folder, or not empty */ }
    }
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(MARKER_KEY);
  }
}

/** Start carrying everything in `from` to `to`. A no-op while a move runs. */
export function startFolderMove(from: string, to: string): FolderMoveStatus {
  if (running) return folderMoveStatus();
  if (path.resolve(from) === path.resolve(to) || !fs.existsSync(from)) return folderMoveStatus();
  current = { from: path.resolve(from), to: path.resolve(to) };
  done = 0;
  failed = [];
  if (pendingEntries(current.from).length === 0) return folderMoveStatus();
  running = true;
  cancelRequested = false;
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(MARKER_KEY, JSON.stringify(current));
  void run();
  return folderMoveStatus();
}

export function cancelFolderMove(): FolderMoveStatus {
  if (running) cancelRequested = true;
  return folderMoveStatus();
}

/** Called once at startup: an unfinished move carries on from where it was. */
export function resumeFolderMoveOnStartup(): boolean {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(MARKER_KEY) as { value: string } | undefined;
  if (!row) return false;
  try {
    const saved = JSON.parse(row.value) as { from: string; to: string };
    if (saved.from && saved.to && fs.existsSync(saved.from)) {
      startFolderMove(saved.from, saved.to);
      return running;
    }
  } catch {
    /* a marker that no longer parses is dropped below */
  }
  db.prepare("DELETE FROM app_settings WHERE key = ?").run(MARKER_KEY);
  return false;
}

/** Test hook. */
export async function waitForFolderMove(): Promise<FolderMoveStatus> {
  while (running) await new Promise<void>((resolve) => setTimeout(resolve, 5));
  return folderMoveStatus();
}
