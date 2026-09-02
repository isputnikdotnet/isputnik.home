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
  "SCAN_GALLERY_FACES"
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
    `SELECT id FROM jobs WHERE status = 'running' AND type IN (${inLibraryJobTypes}) ORDER BY datetime(started_at) LIMIT 1`
  ).get(...LIBRARY_JOB_TYPES) as { id: string } | undefined;
  const waiting = db.prepare(
    `SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending' AND type IN (${inLibraryJobTypes})`
  ).get(...LIBRARY_JOB_TYPES) as { n: number };
  return { runningJobId: running?.id ?? null, waiting: waiting.n };
}
