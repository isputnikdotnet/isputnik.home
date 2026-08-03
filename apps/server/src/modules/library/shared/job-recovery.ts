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
import { db } from "../../../db.js";

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
