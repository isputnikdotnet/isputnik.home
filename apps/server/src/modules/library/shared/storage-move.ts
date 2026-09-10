// The storage move — one task for every room of App storage.
//
// The Recycle Bin move (docs/app-storage-plan.md, decision 10) set the shape:
// the setting flips first, then a background job carries what is still in the
// old place over, one unit at a time, resumable after a restart, cancellable,
// with each failure kept by name. This file is that shape lifted onto the jobs
// table, so a move is a task like a scan: it shows on the Tasks page with
// progress and an ETA, it can be cancelled there, it is timed, and a restart
// re-queues it through the same recovery as every other job. The bin and the
// thumbnails are two kinds of it; renders and music, the Photo Inbox and the
// Made in the app library are the other three.
//
// What makes it safe:
//   - Same volume: a rename. Instant at any size, and atomic, so there is no
//     size at which it stops being safe.
//   - Different volumes: never a synchronous copy. Files are copied one by one,
//     each checked by size against its source before the source is removed; a
//     directory is checked file by file the same way. A mismatch keeps the
//     source and lists the entry as failed.
//   - A library keeps pointing at its old folder until the last file is
//     verified, then the path flips in one step and the old folder goes. The
//     library is never half here and half there.
//   - One move runs at a time, and never beside a scan: the type is one of the
//     library job types the scan lock counts.
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { db, logActivity } from "../../../db.js";
import type { AppRoom } from "../../../core/app-storage.js";
import { jobProgressWriter } from "./job-progress.js";
import { requeueInterruptedJobs } from "./job-recovery.js";
import { libraryJobRunning } from "./scan-lock.js";
import { getTrashRootSetting, setMovingTrashedItem } from "./trash.js";
import { moveTrashedItemTo, pendingTrashMoveRows } from "./trash-move.js";
import { RENDER_BUCKETS } from "./thumbnail.js";

export const STORAGE_MOVE_JOB_TYPE = "MOVE_STORAGE";

export type StorageMoveKind = "trash" | "thumbnails" | "renders" | "library";

export interface StorageMoveFailure {
  /** The unit that failed: an entry name, or a bin item's id. */
  name: string;
  error: string;
  /** Bin items carry what the Recycle Bin page shows. */
  title?: string;
  libraryName?: string;
}

export interface StorageMoveResult {
  moved: number;
  failed: StorageMoveFailure[];
  cancelled: boolean;
  durationMs: number;
}

export interface StorageMovePayload {
  kind: StorageMoveKind;
  /** The Storage page row this move belongs to. */
  room: AppRoom;
  /** What the log and the Tasks page call it: "Recycle Bin", a library's name. */
  label: string;
  /** The bin's `from` is null (rows say where they are) and its `to` is null for
   *  each library's own .trash. */
  from: string | null;
  to: string | null;
  libraryId?: string;
  actorUserId?: string | null;
  progress?: { processed: number; total: number; startedAt: string; etaSeconds: number | null; updatedAt: string };
  result?: StorageMoveResult;
}

export interface StorageMoveStatus {
  /** A job is queued or running. */
  running: boolean;
  jobId: string | null;
  kind: StorageMoveKind | null;
  label: string | null;
  from: string | null;
  to: string | null;
  /** Units carried by the running job so far. */
  done: number;
  /** Units the running job still has to carry. */
  pending: number;
  /** What the last finished move could not carry — shown until the next move starts. */
  failed: StorageMoveFailure[];
  startedAt: string | null;
}

interface JobRow { id: string; status: string; payload: string; started_at: string | null; created_at: string }

class StorageMoveError extends Error {
  constructor(message: string, readonly statusCode = 409) {
    super(message);
    this.name = "StorageMoveError";
  }
}

const samePath = (a: string | null | undefined, b: string | null | undefined): boolean =>
  Boolean(a && b) && path.resolve(a!) === path.resolve(b!);

// ── Enqueue, status, cancel ─────────────────────────────────────────────────

function recentJobs(): (JobRow & { data: StorageMovePayload })[] {
  const rows = db.prepare(
    "SELECT id, status, payload, started_at, created_at FROM jobs WHERE type = ? ORDER BY created_at DESC LIMIT 40"
  ).all(STORAGE_MOVE_JOB_TYPE) as JobRow[];
  const out: (JobRow & { data: StorageMovePayload })[] = [];
  for (const row of rows) {
    try { out.push({ ...row, data: JSON.parse(row.payload) as StorageMovePayload }); } catch { /* not ours to read */ }
  }
  return out;
}

function activeJob(room: AppRoom): (JobRow & { data: StorageMovePayload }) | null {
  return recentJobs().find((job) => job.data.room === room && (job.status === "pending" || job.status === "running")) ?? null;
}

/** True while any storage move is queued or running — App storage itself must
 *  not change under one. */
export function anyStorageMoveActive(): boolean {
  return recentJobs().some((job) => job.status === "pending" || job.status === "running");
}

/** What a move for `room` would still have to carry, counted live. */
function pendingUnits(data: StorageMovePayload): number {
  switch (data.kind) {
    case "trash":
      return pendingTrashMoveRows().length + replacedUnits(data.from, getTrashRootSetting()).length;
    case "thumbnails":
    case "renders":
    case "library":
      return data.from ? listUnits(data).length : 0;
  }
}

export function storageMoveStatus(room: AppRoom): StorageMoveStatus {
  const jobs = recentJobs().filter((job) => job.data.room === room);
  const active = jobs.find((job) => job.status === "pending" || job.status === "running") ?? null;
  if (active) {
    const done = active.data.progress?.processed ?? 0;
    return {
      running: true,
      jobId: active.id,
      kind: active.data.kind,
      label: active.data.label,
      from: active.data.from,
      to: active.data.to,
      done,
      pending: pendingUnits(active.data),
      failed: [],
      startedAt: active.started_at
    };
  }
  const last = jobs[0] ?? null;
  return {
    running: false,
    jobId: last?.id ?? null,
    kind: last?.data.kind ?? null,
    label: last?.data.label ?? null,
    from: last?.data.from ?? null,
    to: last?.data.to ?? null,
    done: last?.data.result?.moved ?? 0,
    pending: 0,
    failed: last?.data.result?.failed ?? [],
    startedAt: last?.started_at ?? null
  };
}

/** Refuse a move whose target already holds something other than an empty
 *  folder, before anything is queued. Merging kinds (thumbnails, renders) may
 *  land in a folder that has entries; a library may not. */
export function assertMoveTargetFree(to: string, what: string): void {
  if (!fs.existsSync(to)) return;
  let entries: string[] | null = null;
  try { entries = fs.readdirSync(to); } catch { entries = null; }
  if (!entries || entries.length > 0) {
    throw new StorageMoveError(`A folder already exists at ${to}. Move it aside first, then move ${what}.`, 409);
  }
}

/** Queue a move. A move already queued or running for the same room is returned
 *  instead of a second one. Nothing to carry means no job at all. */
export function enqueueStorageMove(input: Omit<StorageMovePayload, "progress" | "result">): StorageMoveStatus {
  const existing = activeJob(input.room);
  if (existing) return storageMoveStatus(input.room);
  if (input.kind !== "library" && pendingUnits(input) === 0) return storageMoveStatus(input.room);
  if (input.kind === "library" && (!input.from || !input.to || samePath(input.from, input.to))) return storageMoveStatus(input.room);
  const payload: StorageMovePayload = { ...input };
  db.prepare("INSERT INTO jobs (id, type, payload, status, max_attempts) VALUES (?, ?, ?, 'pending', 3)")
    .run(nanoid(16), STORAGE_MOVE_JOB_TYPE, JSON.stringify(payload), );
  return storageMoveStatus(input.room);
}

/** Stop the move for a room after the unit in hand. Every unit already carried
 *  stays carried; a library that has not flipped yet stays where it was. */
export function cancelStorageMove(room: AppRoom): StorageMoveStatus {
  const job = activeJob(room);
  if (job) {
    db.prepare(`
      UPDATE jobs SET status = 'failed', failed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL, error = 'Cancelled by user'
      WHERE id = ? AND status IN ('pending', 'running')
    `).run(job.id);
  }
  return storageMoveStatus(room);
}

/** Queue the last move for a room again — the way its failures are retried. */
export function retryStorageMove(room: AppRoom, userId: string | null): StorageMoveStatus {
  const last = recentJobs().find((job) => job.data.room === room);
  if (!last) return storageMoveStatus(room);
  const { progress: _p, result: _r, ...rest } = last.data;
  return enqueueStorageMove({ ...rest, actorUserId: userId });
}

// ── The units ───────────────────────────────────────────────────────────────

/** Top-level entries still in `from` for the folder kinds. */
function listUnits(data: StorageMovePayload): string[] {
  if (!data.from || !fs.existsSync(data.from)) return [];
  let names: string[];
  try { names = fs.readdirSync(data.from); } catch { return []; }
  switch (data.kind) {
    case "thumbnails":
      return names.filter((name) => !name.startsWith(".upload-"));
    case "renders":
      return names.filter((name) => (RENDER_BUCKETS as readonly string[]).includes(name));
    case "library":
      return names;
    default:
      return [];
  }
}

/** Copy one file and check it arrived whole. A target file of the same size is
 *  accepted as already there (a resumed move, or a scan that wrote it meanwhile). */
function copyFileVerified(source: string, target: string): void {
  const size = fs.statSync(source).size;
  if (fs.existsSync(target)) {
    if (fs.statSync(target).size === size) return;
    fs.rmSync(target, { force: true });
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  const arrived = fs.statSync(target).size;
  if (arrived !== size) {
    fs.rmSync(target, { force: true });
    throw new Error(`${path.basename(source)} arrived as ${arrived} bytes, not ${size}.`);
  }
}

/** Copy a file or a whole tree, file by file, each verified. Returns how many
 *  files it checked. Nothing is deleted here. */
export function copyTreeVerified(source: string, target: string): number {
  const stat = fs.statSync(source);
  if (!stat.isDirectory()) {
    copyFileVerified(source, target);
    return 1;
  }
  fs.mkdirSync(target, { recursive: true });
  let files = 0;
  for (const name of fs.readdirSync(source)) {
    files += copyTreeVerified(path.join(source, name), path.join(target, name));
  }
  return files;
}

/** Carry one top-level entry across: rename when the volumes allow, else copy
 *  it verified and remove the source only then. Merges into an entry that already
 *  exists at the destination, keeping the destination's copy of any file both
 *  hold at the same size. */
export function carryEntry(from: string, to: string, name: string): void {
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
  copyTreeVerified(source, target);
  fs.rmSync(source, { recursive: true, force: true });
}

/** The originals Replace file set aside, `replaced/<library>/<item>/…`, live
 *  beside the bin — under the install-wide root, or under each library's own
 *  .trash — and have no rows. One unit is one `<library>/<item>` folder, listed
 *  from where the bin was (`from`, null for per-library) and bound for where it
 *  is now (`to`, null likewise). A library that no longer exists keeps its folder
 *  where it is when the destination would be its own .trash. */
interface ReplacedUnit { name: string; sourceParent: string; targetParent: string }

const LIBRARY_TRASH_DIR = ".trash";

function replacedUnits(from: string | null, to: string | null): ReplacedUnit[] {
  const libraries = db.prepare("SELECT id, source_path FROM libraries").all() as { id: string; source_path: string }[];
  const sourceOf = new Map(libraries.map((row) => [row.id, row.source_path]));
  const roots: string[] = from
    ? [path.join(from, "replaced")]
    : libraries.map((row) => path.join(row.source_path, LIBRARY_TRASH_DIR, "replaced"));
  const units: ReplacedUnit[] = [];
  for (const root of roots) {
    let libraryIds: string[];
    try { libraryIds = fs.readdirSync(root); } catch { continue; }
    for (const libraryId of libraryIds) {
      const sourceParent = path.join(root, libraryId);
      let items: string[];
      try { items = fs.readdirSync(sourceParent); } catch { continue; }
      const targetBase = to ? path.join(to, "replaced") : (sourceOf.has(libraryId) ? path.join(sourceOf.get(libraryId)!, LIBRARY_TRASH_DIR, "replaced") : null);
      if (!targetBase) continue;
      const targetParent = path.join(targetBase, libraryId);
      if (samePath(sourceParent, targetParent)) continue;
      for (const item of items) units.push({ name: `${libraryId}/${item}`, sourceParent, targetParent });
    }
  }
  return units;
}

/** Remove `dir` and its parents up to (and including) `stopAt` while they are
 *  empty — the `replaced/<library>` chain, then the old bin root itself. */
function pruneEmptyUpTo(dir: string, stopAt: string): void {
  let current = path.resolve(dir);
  const stop = path.resolve(stopAt);
  for (;;) {
    try {
      if (fs.readdirSync(current).length > 0) return;
      fs.rmdirSync(current);
    } catch {
      return;
    }
    if (current === stop) return;
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

// ── Running one job ─────────────────────────────────────────────────────────

function jobStillRunning(jobId: string): boolean {
  const row = db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string } | undefined;
  return row?.status === "running";
}

function pointLibraryAt(libraryId: string, source: string): void {
  db.prepare("UPDATE libraries SET source_path = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(source, libraryId);
  db.prepare("UPDATE trashed_items SET source_path = ? WHERE library_id = ?").run(source, libraryId);
}

async function yieldTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Carry every unit of one job. Returns the result; throws only for a problem
 *  with the job itself (a library that vanished), never for a unit. */
async function runMove(jobId: string, data: StorageMovePayload): Promise<StorageMoveResult> {
  const started = Date.now();
  const failed: StorageMoveFailure[] = [];
  let moved = 0;
  let cancelled = false;
  const progress = jobProgressWriter(jobId, data);

  if (data.kind === "trash") {
    const failedIds = new Set<string>();
    for (;;) {
      if (!jobStillRunning(jobId)) { cancelled = true; break; }
      const target = getTrashRootSetting();
      const next = pendingTrashMoveRows().find((row) => !failedIds.has(row.id));
      if (!next) break;
      setMovingTrashedItem(next.id);
      try {
        moveTrashedItemTo(next, target);
        moved += 1;
      } catch (err) {
        failedIds.add(next.id);
        failed.push({ name: next.id, title: next.title, libraryName: next.library_name, error: err instanceof Error ? err.message : String(err) });
      } finally {
        setMovingTrashedItem(null);
      }
      progress(moved + failed.length, moved + failed.length + pendingTrashMoveRows().filter((row) => !failedIds.has(row.id)).length);
      await yieldTurn();
    }
    // Then the originals Replace file set aside, which have no rows: each
    // `<library>/<item>` folder is carried whole, and the emptied chain up to
    // the old root goes with it. A folder that fails stays, listed by name.
    if (!cancelled) {
      const target = getTrashRootSetting();
      const failedNames = new Set<string>();
      for (;;) {
        if (!jobStillRunning(jobId)) { cancelled = true; break; }
        const next = replacedUnits(data.from, target).find((unit) => !failedNames.has(unit.name));
        if (!next) break;
        try {
          carryEntry(next.sourceParent, next.targetParent, path.basename(next.name));
          // The emptied `replaced/<library>` and `replaced` go. The old root
          // itself is left standing; a library's own emptied .trash goes, as it
          // does when the last row leaves it.
          pruneEmptyUpTo(next.sourceParent, data.from ? path.join(data.from, "replaced") : path.dirname(path.dirname(next.sourceParent)));
          moved += 1;
        } catch (err) {
          failedNames.add(next.name);
          failed.push({ name: `replaced/${next.name}`, error: err instanceof Error ? err.message : String(err) });
        }
        progress(moved + failed.length, moved + failed.length + replacedUnits(data.from, target).filter((unit) => !failedNames.has(unit.name)).length);
        await yieldTurn();
      }
    }
    return { moved, failed, cancelled, durationMs: Date.now() - started };
  }

  if (!data.from || !data.to) return { moved, failed, cancelled, durationMs: Date.now() - started };
  const from = path.resolve(data.from);
  const to = path.resolve(data.to);

  if (data.kind === "library") {
    const libraryId = data.libraryId!;
    const library = db.prepare("SELECT id, source_path FROM libraries WHERE id = ?").get(libraryId) as { id: string; source_path: string } | undefined;
    if (!library) throw new Error("The library is gone.");
    if (samePath(library.source_path, to)) return { moved, failed, cancelled, durationMs: Date.now() - started };
    if (!fs.existsSync(from)) throw new Error(`The library's folder is missing: ${from}`);

    // The whole folder in one rename when the volumes allow: instant, atomic,
    // and the flip follows at once.
    if (fs.existsSync(to)) {
      const entries = fs.readdirSync(to);
      if (entries.length === 0) fs.rmdirSync(to);
    }
    if (!fs.existsSync(to)) {
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(from, to);
        pointLibraryAt(libraryId, to);
        progress(1, 1);
        return { moved: 1, failed, cancelled, durationMs: Date.now() - started };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      }
    }

    // Across volumes: copy every entry verified while the library still points
    // at the old folder; flip only when everything is across; then the old
    // folder goes. A cancel or a failure leaves the library where it was.
    const units = listUnits(data);
    let index = 0;
    for (const name of units) {
      if (!jobStillRunning(jobId)) { cancelled = true; break; }
      try {
        copyTreeVerified(path.join(from, name), path.join(to, name));
        moved += 1;
      } catch (err) {
        failed.push({ name, error: err instanceof Error ? err.message : String(err) });
      }
      index += 1;
      progress(index, units.length);
      await yieldTurn();
    }
    if (!cancelled && failed.length === 0) {
      pointLibraryAt(libraryId, to);
      fs.rmSync(from, { recursive: true, force: true });
    } else if (cancelled) {
      fs.rmSync(to, { recursive: true, force: true });
    }
    return { moved, failed, cancelled, durationMs: Date.now() - started };
  }

  // thumbnails, renders: entries carried one by one into a folder that is
  // already the live one (the setting flipped first), merging into what a scan
  // may have written there since.
  const failedNames = new Set<string>();
  for (;;) {
    if (!jobStillRunning(jobId)) { cancelled = true; break; }
    const next = listUnits(data).find((name) => !failedNames.has(name));
    if (!next) break;
    try {
      carryEntry(from, to, next);
      moved += 1;
    } catch (err) {
      failedNames.add(next);
      failed.push({ name: next, error: err instanceof Error ? err.message : String(err) });
    }
    progress(moved + failed.length, moved + failed.length + listUnits(data).filter((name) => !failedNames.has(name)).length);
    await yieldTurn();
  }
  if (!cancelled && failed.length === 0 && data.kind === "thumbnails") {
    try { fs.rmdirSync(from); } catch { /* someone else's folder, or not empty */ }
  }
  return { moved, failed, cancelled, durationMs: Date.now() - started };
}

// ── The worker ──────────────────────────────────────────────────────────────

let queueRunning = false;

function describe(data: StorageMovePayload): string {
  if (data.kind === "trash") return `the Recycle Bin to ${data.to ?? "each library's own .trash"}`;
  return `${data.label} from ${data.from} to ${data.to}`;
}

export async function processStorageMoveQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;
  try {
    requeueInterruptedJobs(STORAGE_MOVE_JOB_TYPE);
    for (;;) {
      // Never beside a scan: a library being read while its files move is the
      // one thing this must not allow.
      if (libraryJobRunning()) break;
      const job = db.prepare(`
        SELECT id, payload FROM jobs
        WHERE type = ? AND status = 'pending' AND datetime(run_at) <= datetime('now')
        ORDER BY datetime(created_at) ASC LIMIT 1
      `).get(STORAGE_MOVE_JOB_TYPE) as { id: string; payload: string } | undefined;
      if (!job) break;
      const claim = db.prepare(`
        UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_by = ?
        WHERE id = ? AND status = 'pending'
      `).run(process.pid.toString(), job.id);
      if (claim.changes === 0) continue;

      const data = JSON.parse(job.payload) as StorageMovePayload;
      logActivity({
        event: "storage.move.started",
        actorUserId: data.actorUserId ?? null,
        targetType: "storage",
        targetId: data.room,
        detail: `Moving ${describe(data)}.`
      });
      try {
        const result = await runMove(job.id, data);
        const seconds = Math.max(1, Math.round(result.durationMs / 1000));
        const failures = result.failed.length > 0
          ? ` ${result.failed.length} could not be moved: ${result.failed.slice(0, 5).map((f) => `${f.title ?? f.name} (${f.error})`).join("; ")}${result.failed.length > 5 ? "; …" : ""}.`
          : "";
        if (result.cancelled) {
          // The cancel already marked the job failed; the log says what it left.
          db.prepare("UPDATE jobs SET payload = ? WHERE id = ?").run(JSON.stringify({ ...data, result }), job.id);
          logActivity({
            event: "storage.move.cancelled",
            actorUserId: data.actorUserId ?? null,
            targetType: "storage",
            targetId: data.room,
            detail: `Stopped moving ${describe(data)} after ${result.moved} carried; the rest stays where it was.${failures}`
          });
        } else if (result.failed.length > 0) {
          db.prepare(`
            UPDATE jobs SET status = 'failed', payload = ?, failed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL, error = ?
            WHERE id = ?
          `).run(JSON.stringify({ ...data, result }), `${result.failed.length} of ${result.moved + result.failed.length} could not be moved`, job.id);
          logActivity({
            event: "storage.move.failed",
            actorUserId: data.actorUserId ?? null,
            targetType: "storage",
            targetId: data.room,
            detail: `Moved ${describe(data)}: ${result.moved} carried in ${seconds}s.${failures}`
          });
        } else {
          db.prepare(`
            UPDATE jobs SET status = 'completed', payload = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL
            WHERE id = ?
          `).run(JSON.stringify({ ...data, result }), job.id);
          logActivity({
            event: "storage.move.completed",
            actorUserId: data.actorUserId ?? null,
            targetType: "storage",
            targetId: data.room,
            detail: `Moved ${describe(data)}: ${result.moved} carried and verified in ${seconds}s.`
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Storage move failed";
        db.prepare(`
          UPDATE jobs SET status = 'failed', failed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL, error = ?
          WHERE id = ?
        `).run(message, job.id);
        logActivity({
          event: "storage.move.failed",
          actorUserId: data.actorUserId ?? null,
          targetType: "storage",
          targetId: data.room,
          detail: `Could not move ${describe(data)}: ${message}`
        });
      }
    }
  } finally {
    queueRunning = false;
  }
}

export function startStorageMoveWorker(): () => void {
  const timer = setInterval(() => { void processStorageMoveQueue(); }, 2000);
  return () => clearInterval(timer);
}

/** Test hook: run the queue until no move is queued or running. */
export async function waitForStorageMoves(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    await processStorageMoveQueue();
    if (!anyStorageMoveActive()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("a storage move never finished");
}
