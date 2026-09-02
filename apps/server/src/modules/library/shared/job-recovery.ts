// Recovering the jobs a restart interrupted.
//
// Every worker starts by putting its own 'running' jobs back to 'pending': a job was
// claimed, the process died, and nothing else will ever finish it. That is right for
// the ordinary case — a restart during a scan — and catastrophic for one job: the one
// whose own weight is what killed the process.
//
// A slideshow render that exhausts the container's memory takes the server down with
// it. Docker restarts it, the worker sees a 'running' render, re-queues it, and the
// same render kills the box again — a loop that survives restarts and never consults
// the attempt limit, because the crash path that would have consulted it never ran.
// (That is exactly what 2.11.4 shipped into: the render finally worked, so it was
// finally heavy enough to be killed.)
//
// So resurrection is bounded here by the same `max_attempts` an ordinary failure
// respects. A job that has already used its attempts is failed instead of retried,
// and handed back to the caller so the feature it belongs to can say so.
import { db, logActivity } from "../../../db.js";

export interface AbandonedJob {
  id: string;
  payload: string;
  attempts: number;
}

const INTERRUPTED_MESSAGE =
  "Interrupted before it could finish, more than once — the server may have run out of memory. It won't be retried automatically.";

export interface RecoveryResult {
  /** Jobs put back in the queue for another go. */
  requeued: number;
  /** Jobs that had already used their attempts, now failed. */
  abandoned: AbandonedJob[];
}

// Call once at the top of a worker's queue loop, before claiming anything.
export function requeueInterruptedJobs(jobType: string, message = INTERRUPTED_MESSAGE): RecoveryResult {
  const running = db.prepare(
    "SELECT id, payload, attempts, max_attempts FROM jobs WHERE type = ? AND status = 'running'"
  ).all(jobType) as { id: string; payload: string; attempts: number; max_attempts: number }[];
  if (running.length === 0) return { requeued: 0, abandoned: [] };

  const abandoned: AbandonedJob[] = [];
  let requeued = 0;

  const requeue = db.prepare(
    "UPDATE jobs SET status = 'pending', locked_at = NULL, locked_by = NULL, error = NULL WHERE id = ?"
  );
  const giveUp = db.prepare(`
    UPDATE jobs SET status = 'failed', failed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      locked_at = NULL, locked_by = NULL, error = ? WHERE id = ?
  `);

  db.transaction(() => {
    for (const job of running) {
      // The claim already counted this attempt, so a job on its last attempt has
      // attempts === max_attempts and must not come back.
      if (job.attempts < job.max_attempts) {
        requeue.run(job.id);
        requeued += 1;
      } else {
        giveUp.run(message, job.id);
        abandoned.push({ id: job.id, payload: job.payload, attempts: job.attempts });
      }
    }
  })();

  if (abandoned.length > 0) {
    console.warn(
      `${jobType}: giving up on ${abandoned.length} job(s) that were interrupted after using every attempt `
      + "— they will not be retried. If the server keeps restarting, this is what was killing it."
    );
  }
  return { requeued, abandoned };
}

// ---------------------------------------------------------------------------
// Keeping libraries.scan_status honest
//
// A catalog scan sets its library to 'scanning' when it is queued and back to
// 'idle'/'error' when the job ends. Two paths used to skip that last step and
// leave the library claiming to scan forever:
//
//   1. requeueInterruptedJobs() giving up on a job that used every attempt — it
//      fails the job, and every caller but the slideshow renderer threw the
//      `abandoned` list away.
//   2. Anything that removes the job afterwards — "Clean task history" prunes
//      completed/failed rows beyond the newest 100 — leaving no task to explain
//      the state.
//
// Stranded that way, the library shows the browse page's "Scanning…" notice with
// nothing on the Tasks page and nothing in the log, and — worse than cosmetic —
// the nightly scheduled scan skips it, because enqueueLibraryScans() only queues
// libraries whose scan_status is not 'scanning'. It never scans again.

/** The scan job types that own a library's scan_status. Face jobs don't set it. */
const LIBRARY_SCAN_JOB_TYPES = [
  "SCAN_AUDIOBOOK_LIBRARY",
  "SCAN_EBOOK_LIBRARY",
  "SCAN_GALLERY_LIBRARY"
];

export const INTERRUPTED_SCAN_REASON =
  "was interrupted every time it ran, so it will not be retried automatically";
export const ORPHANED_SCAN_REASON =
  "was left marked as running with no task behind it";

export interface UnstuckLibrary {
  id: string;
  name: string;
  type: string;
}

// Release one library from 'scanning' when its scan will never finish. 'error'
// rather than 'idle' on purpose: it is visible on the Libraries page as a badge,
// and — unlike 'scanning' — the nightly scheduler queues it again.
export function markScanAbandoned(libraryId: string, reason: string): UnstuckLibrary | null {
  const library = db.prepare("SELECT id, name, type FROM libraries WHERE id = ?").get(libraryId) as UnstuckLibrary | undefined;
  if (!library) return null;
  const changed = db.prepare(
    "UPDATE libraries SET scan_status = 'error', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND scan_status = 'scanning'"
  ).run(libraryId);
  if (changed.changes === 0) return null;
  logActivity({
    event: "library.scan_abandoned",
    targetType: "library",
    targetId: library.id,
    detail: `Scan of "${library.name}" ${reason} — the library is no longer marked as scanning. Run a rescan to try again.`
  });
  return library;
}

// Safety net for (2) above: any library still claiming to scan with no queued or
// running scan job behind it. Called once per boot, after the workers have had
// their pass at requeueing what a restart interrupted — a job left 'running' by a
// dead process still counts as active here, so this never races the requeue.
export function reconcileOrphanedScans(): UnstuckLibrary[] {
  const placeholders = LIBRARY_SCAN_JOB_TYPES.map(() => "?").join(", ");
  const orphans = db.prepare(`
    SELECT id FROM libraries
    WHERE scan_status = 'scanning'
      AND NOT EXISTS (
        SELECT 1 FROM jobs
        WHERE jobs.status IN ('running', 'pending')
          AND jobs.type IN (${placeholders})
          AND json_extract(jobs.payload, '$.libraryId') = libraries.id
      )
  `).all(...LIBRARY_SCAN_JOB_TYPES) as { id: string }[];

  const unstuck: UnstuckLibrary[] = [];
  for (const orphan of orphans) {
    const library = markScanAbandoned(orphan.id, ORPHANED_SCAN_REASON);
    if (library) unstuck.push(library);
  }
  return unstuck;
}

// Shared tail for a scan worker's recovery pass: whatever requeueInterruptedJobs
// gave up on, release its library too.
export function releaseAbandonedScanLibraries(abandoned: AbandonedJob[]): void {
  for (const job of abandoned) {
    try {
      const { libraryId } = JSON.parse(job.payload) as { libraryId?: string };
      if (libraryId) markScanAbandoned(libraryId, INTERRUPTED_SCAN_REASON);
    } catch { /* unreadable payload: reconcileOrphanedScans catches it next boot */ }
  }
}
