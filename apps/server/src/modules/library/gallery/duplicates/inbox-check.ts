// Starting and reading the Photo Inbox check — docs/photo-inbox-proposal.md,
// phase 2. A check is an ordinary cleanup job with the Inbox named (jobs.ts,
// `inboxLibraryId`); this module is what queues one when a delivery lands and
// what the Inbox page reads to say "12 new, 3 look like copies".
//
// Two constraints shape it. There is ONE active cleanup install-wide (the partial
// unique index on duplicate_jobs), so a check that would collide with someone's
// cleanup is simply not started — the page says so and offers to try later. And
// a job needs an owner: the admin who triggered it when there is one, otherwise
// the admin who created the Inbox library.
import { db } from "../../../../db.js";
import { isPhotoInboxLibrary } from "../inbox-flag.js";
import { activeJob, createJob, galleryLibraryOptions, refreshInboxScope, type DuplicateJob } from "./jobs.js";
import { startJobScan } from "./job-scan.js";
import { processDuplicateScanQueue } from "./items.js";

export type InboxCheckStart =
  | { queued: true; jobId: string }
  | { queued: false; reason: "not_inbox" | "empty" | "running" | "busy" | "refused"; jobId?: string; detail?: string };

/** Queue a check of one Inbox against the rest of the collection. Re-runs the
 *  Inbox's own check when one is waiting in review; never touches anyone else's
 *  cleanup. Safe to call on every delivery — it answers rather than throws. */
export function queueInboxCheck(inboxLibraryId: string, userId?: string): InboxCheckStart {
  if (!isPhotoInboxLibrary(inboxLibraryId)) return { queued: false, reason: "not_inbox" };

  const waiting = (db.prepare(
    "SELECT COUNT(*) AS n FROM library_items WHERE library_id = ? AND deleted_at IS NULL AND status = 'ready'"
  ).get(inboxLibraryId) as { n: number }).n;
  if (waiting === 0) return { queued: false, reason: "empty" };

  const current = activeJob();
  if (current) {
    if (current.inboxLibraryId !== inboxLibraryId) return { queued: false, reason: "busy", jobId: current.id };
    if (current.status === "scanning" || current.status === "processing") {
      return { queued: false, reason: "running", jobId: current.id };
    }
    // The Inbox's own check, put down in review or never run: scan again so the
    // new delivery joins it. Its dismissals survive; its review marks do not — and
    // it is re-pointed at today's libraries, not the ones that existed when it was
    // first started.
    refreshInboxScope(current.id);
    const restarted = startJobScan(current.id, current.ownerUserId);
    if (!restarted.ok) return { queued: false, reason: "refused", jobId: current.id, detail: restarted.refused };
    void processDuplicateScanQueue().catch(() => { /* logged per-job */ });
    return { queued: true, jobId: current.id };
  }

  const owner = userId ?? (db.prepare("SELECT created_by FROM libraries WHERE id = ?").get(inboxLibraryId) as
    | { created_by: string }
    | undefined)?.created_by;
  if (!owner) return { queued: false, reason: "refused", detail: "no owner" };

  // Every other library is where a twin may be; the Inbox itself is added by the
  // job model, being the candidates.
  const others = galleryLibraryOptions().filter((library) => !library.inbox).map((library) => library.id);
  const created = createJob({
    ownerUserId: owner,
    libraryIds: [...others, inboxLibraryId],
    duplicateType: "inbox",
    inboxLibraryId,
    mediaType: "both"
  });
  if (!created.ok) return { queued: false, reason: "refused", detail: created.refused };
  const started = startJobScan(created.job.id, owner);
  if (!started.ok) return { queued: false, reason: "refused", jobId: created.job.id, detail: started.refused };
  void processDuplicateScanQueue().catch(() => { /* logged per-job */ });
  return { queued: true, jobId: created.job.id };
}

export interface InboxCheckView {
  jobId: string;
  status: DuplicateJob["status"];
  scanProgress: number;
  statusDetail: string | null;
  /** Sets the check found, and how many are still to be decided. */
  results: number;
  remaining: number;
  ownerUserId: string;
  isOwner: boolean;
  scanCompletedAt: string | null;
}

/** What the Inbox page shows about its check: the job when it is this Inbox's,
 *  or the fact that another cleanup holds the one slot. */
export function inboxCheckView(inboxLibraryId: string, userId: string): { check: InboxCheckView | null; blockedBy: "other_job" | null } {
  const current = activeJob();
  if (!current) return { check: null, blockedBy: null };
  if (current.inboxLibraryId !== inboxLibraryId) return { check: null, blockedBy: "other_job" };
  return {
    check: {
      jobId: current.id,
      status: current.status,
      scanProgress: current.scanProgress,
      statusDetail: current.statusDetail,
      results: current.totals.results,
      remaining: current.totals.remaining,
      ownerUserId: current.ownerUserId,
      isOwner: current.ownerUserId === userId,
      scanCompletedAt: current.scanCompletedAt
    },
    blockedBy: null
  };
}
