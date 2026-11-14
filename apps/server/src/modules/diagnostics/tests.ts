// This server's tests on Diagnostics › iSputnik (docs/diagnostics-pages-plan.md,
// phase 4): each runs only when an admin presses it, one at a time, and changes
// nothing.
//
// - Check folders: for each library this server reads (not a video library,
//   whose folder is the video container's), how long the folder takes to answer
//   — twice, since a sleeping disk answers the first time slowly — and how fast
//   its largest file near the top reads.
// - Verify the last backup: modules/backups/verify.ts.
// - Speed to this device is measured by the browser (GET /api/speed-test) and
//   only recorded here, so it has a place in Recent runs.
//
// The last result of each, and the last few runs, are kept in app_settings.
import fs from "node:fs";
import path from "node:path";
import { db } from "../../db.js";
import { log } from "../../core/logger.js";
import { isPreUpgradeCopy, listBackupFiles } from "../backups/run.js";
import { verifyBackup, type BackupVerification } from "../backups/verify.js";

export type TestKind = "folders" | "backup" | "speed";

export interface FolderResult {
  libraryId: string;
  name: string;
  type: string;
  /** How long the folder took to answer, the first time and the second. */
  firstMs: number | null;
  secondMs: number | null;
  /** The first answer took long enough that a disk was likely asleep. */
  asleep: boolean;
  /** A read of its largest file near the top; null when it holds none big enough. */
  read: { bytes: number; seconds: number; mbitPerSecond: number } | null;
  verdict: "ok" | "slow" | "missing";
  error: string | null;
}

export interface FolderCheck {
  at: string;
  libraries: FolderResult[];
  ms: number;
}

export interface SpeedResult {
  at: string;
  downloadMbps: number;
  replyMs: number;
  bytes: number;
}

export interface TestRun {
  kind: TestKind;
  at: string;
  ok: boolean;
  /** A few facts to word the run by: the page does the wording. */
  facts: Record<string, string | number | null>;
}

export interface TestsState {
  running: { kind: Exclude<TestKind, "speed">; startedAt: string; step: string | null } | null;
  folders: FolderCheck | null;
  backup: BackupVerification | null;
  speed: SpeedResult | null;
  runs: TestRun[];
}

const KEY = "diagnostics.tests";
const RUNS_KEPT = 10;
/** A first answer slower than this was a disk waking up. */
const ASLEEP_MS = 1500;
/** Longer than this and the folder is slow to answer, whatever the reason. */
const SLOW_MS = 3000;
/** How long a library gets in all before it is given up on. */
const LIBRARY_TIMEOUT_MS = 30_000;
/** How much of one file is read to time it, and what is too small to time. */
const READ_BYTES = 64 * 1024 * 1024;
const MIN_FILE_BYTES = 4 * 1024 * 1024;
/** How far the walk for a file to read goes: entries looked at, and folder depth. */
const WALK_ENTRIES = 1500;
const WALK_DEPTH = 3;

let running: TestsState["running"] = null;
let current: Promise<void> | null = null;

type Stored = Omit<TestsState, "running">;
const EMPTY: Stored = { folders: null, backup: null, speed: null, runs: [] };

function read(): Stored {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(KEY) as { value: string } | undefined;
  try {
    return row ? { ...EMPTY, ...(JSON.parse(row.value) as Partial<Stored>) } : { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}

function write(value: Stored): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(KEY, JSON.stringify(value));
}

function remember(patch: Partial<Stored>, run: TestRun): void {
  const stored = read();
  write({ ...stored, ...patch, runs: [run, ...stored.runs].slice(0, RUNS_KEPT) });
}

export function testsState(): TestsState {
  return { running, ...read() };
}

const timed = async <T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> => {
  const started = performance.now();
  const value = await work();
  return { value, ms: Math.round(performance.now() - started) };
};

/** The largest file near the top of a folder, walked a little at a time. */
async function largestFile(root: string): Promise<{ file: string; size: number } | null> {
  let best: { file: string; size: number } | null = null;
  let seen = 0;
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (queue.length && seen < WALK_ENTRIES) {
    const { dir, depth } = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen > WALK_ENTRIES) break;
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < WALK_DEPTH) queue.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile()) {
        try {
          const { size } = await fs.promises.stat(full);
          if (size >= MIN_FILE_BYTES && (!best || size > best.size)) best = { file: full, size };
        } catch {
          // Gone, or not ours to read.
        }
      }
    }
  }
  return best;
}

/** How fast a file reads: up to READ_BYTES of it, a megabyte at a time. */
async function readSpeed(file: string): Promise<FolderResult["read"]> {
  const handle = await fs.promises.open(file, "r");
  const chunk = Buffer.alloc(1024 * 1024);
  let bytes = 0;
  const started = performance.now();
  try {
    while (bytes < READ_BYTES) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, bytes);
      if (bytesRead === 0) break;
      bytes += bytesRead;
    }
  } finally {
    await handle.close();
  }
  const seconds = Math.max(0.001, (performance.now() - started) / 1000);
  return { bytes, seconds: Math.round(seconds * 1000) / 1000, mbitPerSecond: Math.round(((bytes * 8) / 1_000_000 / seconds) * 10) / 10 };
}

async function checkLibrary(row: { id: string; name: string; type: string; source_path: string }): Promise<FolderResult> {
  const base: FolderResult = { libraryId: row.id, name: row.name, type: row.type, firstMs: null, secondMs: null, asleep: false, read: null, verdict: "missing", error: null };
  try {
    const first = await timed(() => fs.promises.stat(row.source_path));
    if (!first.value.isDirectory()) return { ...base, error: "not a folder" };
    const second = await timed(() => fs.promises.stat(row.source_path));
    const sample = await largestFile(row.source_path);
    const reading = sample ? await readSpeed(sample.file) : null;
    const slow = Math.min(first.ms, second.ms) > SLOW_MS;
    return { ...base, firstMs: first.ms, secondMs: second.ms, asleep: first.ms > ASLEEP_MS && second.ms < first.ms / 4, read: reading, verdict: slow ? "slow" : "ok" };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

export async function checkFolders(onStep: (name: string) => void = () => undefined): Promise<FolderCheck> {
  const started = performance.now();
  const rows = (db.prepare("SELECT id, name, type, source_path FROM libraries ORDER BY name").all() as { id: string; name: string; type: string; source_path: string }[])
    .filter((row) => row.type !== "video" && path.isAbsolute(row.source_path));
  const libraries: FolderResult[] = [];
  // One at a time: two reads at once would time each other, not the disks.
  for (const row of rows) {
    onStep(row.name);
    const gaveUp: FolderResult = { libraryId: row.id, name: row.name, type: row.type, firstMs: null, secondMs: null, asleep: false, read: null, verdict: "slow", error: "didn't answer in 30 seconds" };
    libraries.push(await withTimeout(checkLibrary(row), LIBRARY_TIMEOUT_MS, gaveUp));
  }
  return { at: new Date().toISOString(), libraries, ms: Math.round(performance.now() - started) };
}

/** Starts a test in the background; false when one is already running. */
export function startTest(kind: Exclude<TestKind, "speed">): boolean {
  if (running) return false;
  running = { kind, startedAt: new Date().toISOString(), step: null };
  const step = (text: string) => { if (running) running.step = text; };
  current = (async () => {
    try {
      if (kind === "folders") {
        const result = await checkFolders(step);
        const bad = result.libraries.filter((library) => library.verdict !== "ok");
        remember({ folders: result }, { kind, at: result.at, ok: bad.length === 0, facts: { libraries: result.libraries.length, problems: bad.length, first: bad[0]?.name ?? null } });
      } else {
        const newest = listBackupFiles().find((file) => !isPreUpgradeCopy(file.name));
        if (!newest) {
          remember({}, { kind, at: new Date().toISOString(), ok: false, facts: { none: 1 } });
          return;
        }
        step(newest.name);
        const result = await verifyBackup(newest, (files) => step(`${newest.name}: ${files}`));
        remember({ backup: result }, { kind, at: new Date().toISOString(), ok: result.ok, facts: { createdAt: newest.createdAt, files: result.files } });
      }
    } catch (err) {
      log.warn({ err, kind }, "a diagnostics test failed");
    } finally {
      running = null;
      current = null;
    }
  })();
  return true;
}

export function recordSpeed(result: Omit<SpeedResult, "at">): SpeedResult {
  const speed: SpeedResult = { at: new Date().toISOString(), ...result };
  remember({ speed }, { kind: "speed", at: speed.at, ok: true, facts: { downloadMbps: speed.downloadMbps, replyMs: speed.replyMs } });
  return speed;
}

/** Tests: wait for the running test to finish. */
export function testSettled(): Promise<void> {
  return current ?? Promise.resolve();
}
