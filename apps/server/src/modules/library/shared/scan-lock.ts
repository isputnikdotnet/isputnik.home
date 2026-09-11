import { db } from "../../../db.js";

// Heavy library work — catalog scans and face recognition — is limited to ONE
// running job at a time server-wide, regardless of media type. Every scan worker
// calls libraryJobRunning() before claiming its next queued job; while any other
// library job is mid-run, the rest simply stay 'pending' and the 2-second pollers
// pick them up once the running job finishes. Claims happen synchronously right
// after this check (better-sqlite3, single process), so two workers cannot slip
// past it at the same time.
export const LIBRARY_JOB_TYPES = [
  "SCAN_AUDIOBOOK_LIBRARY",
  "SCAN_EBOOK_LIBRARY",
  "SCAN_GALLERY_LIBRARY",
  "SCAN_GALLERY_FACES",
  // A storage move (storage-move.ts) carries library folders: no scan may read
  // a library while its files are on their way.
  "MOVE_STORAGE"
];

const inLibraryJobTypes = LIBRARY_JOB_TYPES.map(() => "?").join(", ");

export function libraryJobRunning(): boolean {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM jobs WHERE status = 'running' AND type IN (${inLibraryJobTypes})`
  ).get(...LIBRARY_JOB_TYPES) as { n: number };
  return row.n > 0;
}

/**
 * Which job currently holds the one-at-a-time lock, and how many are stuck behind
 * it. The Tasks page needs the answer as a sentence — a queue that isn't moving
 * looks like a broken queue unless the page says what everything is waiting on.
 */
export function libraryQueueState(): { runningJobId: string | null; waiting: number } {
  const running = db.prepare(
    `SELECT id FROM jobs WHERE status = 'running' AND type IN (${inLibraryJobTypes}) ORDER BY started_at LIMIT 1`
  ).get(...LIBRARY_JOB_TYPES) as { id: string } | undefined;
  const waiting = db.prepare(
    `SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending' AND type IN (${inLibraryJobTypes})`
  ).get(...LIBRARY_JOB_TYPES) as { n: number };
  return { runningJobId: running?.id ?? null, waiting: waiting.n };
}

// Queue a catalog scan for every library of one media type; each module's scan
// worker (2s poller) picks the jobs up. Libraries mid-scan are skipped rather
// than double-queued. What each type's nightly "Scan … libraries" job runs.
export function enqueueLibraryScans(type: string, noun: string, enqueue: (libraryId: string) => unknown): string {
  // Skip this run if a library or face task is already running — the heavy jobs run
  // strictly one at a time, and stacking another night's scans on top of an
  // unfinished one just backs up the queue. It runs again at the next scheduled time.
  if (libraryJobRunning()) return `Skipped — a library or face task is already running; will retry at the next scheduled time.`;
  const libraries = db.prepare("SELECT id, scan_status FROM libraries WHERE type = ?").all(type) as { id: string; scan_status: string }[];
  if (libraries.length === 0) return `No ${noun} libraries exist — nothing to scan.`;
  const idle = libraries.filter((library) => library.scan_status !== "scanning");
  for (const library of idle) enqueue(library.id);
  const skipped = libraries.length - idle.length;
  return `Queued a scan for ${idle.length} librar${idle.length === 1 ? "y" : "ies"}` +
    `${skipped > 0 ? ` (${skipped} already scanning)` : ""} — new and changed files are cataloged in the background.`;
}
