// The duplicate scan worker: takes the fingerprint pass off the jobs queue and, once
// the digests are in place, the cleanup job's own snapshot.
//
// It lives apart from items.ts because a cleanup job's scan is items.ts's hashing pass
// followed by that job's snapshot, so the worker has to reach jobs.ts and job-scan.ts —
// and both of those build on items.ts. Kept in there, it made the four a cycle.
import { db } from "../../../../db.js";
import { libraryJobRunning } from "../../shared/scan-lock.js";
import { requeueInterruptedJobs } from "../../shared/job-recovery.js";
import { jobProgressWriter } from "../../shared/job-progress.js";
import {
  DUPLICATE_SCAN_JOB_TYPE,
  hashDuplicateCandidates,
  type DuplicateScanPayload,
  type LibraryScope
} from "./items.js";
import { getJob, setJobStatus, setJobScanProgress } from "./jobs.js";
import { runJobScan } from "./job-scan.js";
import { inboxNearVariants } from "./inbox-variants.js";
import { findInboxRescans, rescanCandidates, type RescanMatch } from "./inbox-rescans.js";

// ── Phase 2, when the scan belongs to a cleanup job ─────────────────────────

/** Mark a cleanup as stopped, when the pass it was waiting on can no longer deliver.
 *  Guarded on 'scanning' so it can't overwrite a verdict something else already
 *  reached — runJobScan sets 'failed' itself when the snapshot throws. */
function failCleanupJob(cleanupJobId: string | null, message: string): void {
  if (!cleanupJobId) return;
  const cleanup = getJob(cleanupJobId);
  if (!cleanup || cleanup.status !== "scanning") return;
  setJobStatus(cleanupJobId, cleanup.ownerUserId, "failed", message);
}

/** Take the cleanup's snapshot now the digests are in place. Never throws: the hashing
 *  pass succeeded and that work is worth recording whatever happens here, so a refusal
 *  is reported on the CLEANUP rather than by failing the queue entry. */
function runCleanupSnapshot(
  cleanupJobId: string | null,
  nearVariants?: Map<string, string[]>,
  rescans?: RescanMatch[]
): Record<string, unknown> {
  const cleanup = cleanupJobId ? getJob(cleanupJobId) : null;
  // Deleted or cancelled while its scan sat in the queue. The digests are still worth
  // having, so this is not an error — there is simply nothing left to snapshot.
  if (!cleanup || !cleanupJobId) return { cleanupJobId, skipped: "the cleanup was gone by the time its scan finished" };

  const outcome = runJobScan(cleanupJobId, cleanup.ownerUserId, { nearVariants, rescans });
  if (outcome.ok) return { cleanupJobId, ...outcome.summary };
  failCleanupJob(cleanupJobId, outcome.detail ?? outcome.refused);
  return { cleanupJobId, refused: outcome.refused };
}

function writeResult(jobId: string, result: Record<string, unknown>): void {
  const row = db.prepare("SELECT payload FROM jobs WHERE id = ?").get(jobId) as { payload: string } | undefined;
  let payload: Record<string, unknown> = {};
  try { payload = row ? JSON.parse(row.payload) : {}; } catch { /* start fresh on a bad payload */ }
  db.prepare("UPDATE jobs SET payload = ? WHERE id = ?").run(JSON.stringify({ ...payload, result }), jobId);
}

let queueRunning = false;

export async function processDuplicateScanQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;
  try {
    // A scan interrupted by a restart: re-queue it (it recomputes from scratch) —
    // bounded by its attempts, so a scan that keeps killing the process stops.
    requeueInterruptedJobs(DUPLICATE_SCAN_JOB_TYPE);

    for (;;) {
      // Yield to catalog/face scans — this is background housekeeping.
      if (libraryJobRunning()) break;

      const job = db.prepare(`
        SELECT id, payload FROM jobs
        WHERE type = ? AND status = 'pending' AND run_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        ORDER BY run_at ASC LIMIT 1
      `).get(DUPLICATE_SCAN_JOB_TYPE) as { id: string; payload: string } | undefined;
      if (!job) break;

      const claim = db.prepare(`
        UPDATE jobs SET status = 'running', attempts = attempts + 1,
          locked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_by = ?
        WHERE id = ? AND status = 'pending'
      `).run(process.pid.toString(), job.id);
      if (claim.changes === 0) continue;

      let payload: DuplicateScanPayload = {};
      try { payload = JSON.parse(job.payload) as DuplicateScanPayload; } catch { /* scan everything */ }
      const scope: LibraryScope = payload.libraryIds ?? null;
      // Null only for a queue row written by a version that still had install-wide
      // scans; runCleanupSnapshot answers that with "nothing to snapshot".
      const cleanupJobId = payload.cleanupJobId ?? null;

      const writeProgress = jobProgressWriter(job.id, { libraryId: null });
      // A cleanup job shows this as a progress bar on its card, so it needs the percentage
      // on duplicate_jobs too — but only when the rounded value actually moves. Writing per
      // file would be one UPDATE per candidate, and a big library has hundreds of thousands.
      let lastPercent = -1;
      const onProgress = cleanupJobId
        ? (processed: number, total: number) => {
          writeProgress(processed, total);
          const percent = total === 0 ? 100 : Math.round((processed / total) * 100);
          if (percent !== lastPercent) { lastPercent = percent; setJobScanProgress(cleanupJobId, percent); }
        }
        : writeProgress;

      try {
        const pass = await hashDuplicateCandidates(onProgress, scope);
        // A Photo Inbox check also hashes its incoming photos turned three ways, so a
        // print fed in sideways still finds its upright twin (inbox-variants.ts). Done
        // here because it reads files, and the snapshot below must not.
        const cleanup = cleanupJobId ? getJob(cleanupJobId) : null;
        const inboxLibraryId = cleanup?.inboxLibraryId ?? null;
        const nearVariants = inboxLibraryId ? await inboxNearVariants(inboxLibraryId) : undefined;
        // And the second look at what the fingerprint alone can't place — the same
        // print scanned twice (inbox-rescans.ts). Reads previews, so it belongs here
        // beside the variants rather than in the snapshot.
        const rescans = inboxLibraryId && cleanup ? await findInboxRescans(
          rescanCandidates([inboxLibraryId]).map((photo) => ({ ...photo, variants: nearVariants?.get(photo.itemId) })),
          rescanCandidates(cleanup.libraries
            .filter((library) => library.included && !library.missing && library.libraryId !== inboxLibraryId)
            .map((library) => library.libraryId))
        ) : undefined;
        // Every pass belongs to a cleanup. There used to be a second branch here that
        // rebuilt the install-wide cache the older pages read; both are gone.
        writeResult(job.id, { ...pass, ...runCleanupSnapshot(cleanupJobId, nearVariants, rescans) });
        db.prepare("UPDATE jobs SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL WHERE id = ?")
          .run(job.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : "The duplicate scan failed.";
        const attempts = db.prepare("SELECT attempts, max_attempts FROM jobs WHERE id = ?").get(job.id) as { attempts: number; max_attempts: number };
        if (attempts.attempts < attempts.max_attempts) {
          db.prepare("UPDATE jobs SET status = 'pending', run_at = ?, locked_at = NULL, locked_by = NULL, error = ? WHERE id = ?")
            .run(new Date(Date.now() + 5000).toISOString(), message, job.id);
        } else {
          db.prepare("UPDATE jobs SET status = 'failed', failed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL, error = ? WHERE id = ?")
            .run(message, job.id);
          // Out of retries. Say so on the cleanup, or it sits in 'scanning' for ever
          // waiting on a pass that is never going to run.
          failCleanupJob(cleanupJobId, message);
        }
      }
    }
  } finally {
    queueRunning = false;
  }
}

export function startDuplicateScanWorker(): () => void {
  const timer = setInterval(() => { void processDuplicateScanQueue().catch(() => { /* logged per-job */ }); }, 2000);
  return () => clearInterval(timer);
}
