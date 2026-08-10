// Admin API for duplicate cleanup jobs (jobs.ts). Admin-only throughout,
// like the older duplicate routes: a cleanup spans libraries, so deciding which copy
// survives is a whole-install decision.
//
// Two levels of permission sit on top of that, and they are not the same:
//
//   * The OWNER works the job — scope, preferences, review, deletion.
//   * Any admin may RETIRE it — complete, cancel, delete, hand it over — because a
//     lock nobody can break is a lock that strands the install when the person who
//     started the cleanup doesn't come back.
//
// Nothing here deletes a photo. The scan (phase 2) and the removal (phase 4) are
// separate; this is the job's own paperwork.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { logActivity } from "../../../../db.js";
import { parseBody } from "../../../../core/shared.js";
import {
  activeJob,
  cancelJob,
  completeJob,
  createJob,
  deleteJob,
  galleryLibraryOptions,
  getJob,
  jobFolderOptions,
  reassignJob,
  recentJobs,
  setJobFolderPreferences,
  updateJobScope,
  type DuplicateJob,
  type JobOutcome,
  type JobRefusal
} from "./jobs.js";
import {
  countJobResults, listJobResults, startJobScan, sweepPreview, type ResultFilter
} from "./job-scan.js";
import { applyPreferences, dismissResult, markResult, setMemberRole, type RoleRefusal } from "./job-review.js";
import { checkResult, resolveJobResult, sweepJobResults } from "./job-resolve.js";
import { processDuplicateScanQueue } from "./items.js";

// One refusal vocabulary, so a caller never has to read prose to tell "someone else
// owns this" from "this job is past the point of changing".
const REFUSALS: Record<JobRefusal, { code: number; error: string }> = {
  already_active: {
    code: 409,
    error: "A duplicate cleanup is already in progress. Finish, cancel or delete it before starting another."
  },
  not_found: { code: 404, error: "No such cleanup job." },
  not_owner: { code: 403, error: "This cleanup belongs to someone else." },
  locked: {
    code: 409,
    error: "The scan has already run, so the libraries and scan type can't be changed. Start a new cleanup to change them."
  },
  no_libraries: { code: 400, error: "Choose at least one photo library to compare." },
  not_reviewable: { code: 409, error: "This cleanup is already finished." },
  scan_failed: { code: 500, error: "The scan couldn't finish." }
};

// The detail is appended to the message rather than left in a field of its own. A
// scan that broke on something specific — a column, a file, a library — used to
// answer with a generic sentence and hide the useful half where nothing showed it.
// Returns the reply so a handler can `return refuse(...)`: an async handler that
// answers has to hand the reply back to Fastify, and delegating the send to a
// helper does not change that. See core/compression.ts.
function refuse(reply: FastifyReply, refused: JobRefusal, detail?: string) {
  const answer = REFUSALS[refused];
  const spoken = detail && refused === "scan_failed" ? `${answer.error} ${detail}` : answer.error;
  return reply.code(answer.code).send({ error: spoken, detail: detail ?? null });
}

/** The page-level payload: the active job (whoever owns it), what the wizard may
 *  choose from, and the finished jobs behind it. One round trip, like the older
 *  duplicate payload — the page assigns it straight onto its state. */
function jobsPayload(userId: string) {
  const active = activeJob();
  return {
    activeJob: active,
    /** Whether the caller may act, computed here so the client never has to
     *  re-derive a permission rule and get it subtly different. */
    isOwner: active ? active.ownerUserId === userId : false,
    libraries: galleryLibraryOptions(),

    history: recentJobs()
  };
}

const send = (
  reply: FastifyReply,
  outcome: JobOutcome<DuplicateJob | { id: string }>,
  userId: string
) => {
  if (!outcome.ok) return refuse(reply, outcome.refused, outcome.detail);
  return reply.send(jobsPayload(userId));
};

const scopeSchema = z.object({
  libraryIds: z.array(z.string().min(1).max(64)).max(200).optional(),
  duplicateType: z.enum(["folders", "files"]).optional(),
  mediaType: z.enum(["photo", "video", "both"]).optional(),
  // Where a half-finished draft reopens. The wizard has four steps: libraries,
  // what to compare, folder instructions, summary.
  currentStep: z.number().int().min(1).max(4).optional()
});

const createSchema = scopeSchema.extend({
  libraryIds: z.array(z.string().min(1).max(64)).min(1).max(200)
});

const preferencesSchema = z.object({
  folders: z.array(z.object({
    libraryId: z.string().min(1).max(64),
    folderPath: z.string().max(4096),
    mode: z.enum(["keep", "clear"])
  })).max(2000)
});

export async function galleryDuplicateJobRoutesPlugin(app: FastifyInstance) {
  app.get("/api/library/gallery/duplicate-jobs", { preHandler: app.requireAdmin }, async (request, reply) => {
    return reply.send(jobsPayload(request.user!.id));
  });

  // The vocabulary for a job's folder instructions. Static path, so it is matched before
  // /:id — and it takes the libraries as a query rather than reading them off a job,
  // because the wizard asks while the job is still being drafted.
  const folderOptionsSchema = z.object({ libraryIds: z.string().min(1).max(8192) });

  app.get("/api/library/gallery/duplicate-jobs/folder-options", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(folderOptionsSchema, request.query);
    if (parsed.error) { return reply.send({ folders: [] }); }
    const ids = parsed.data.libraryIds.split(",").map((id) => id.trim()).filter(Boolean).slice(0, 200);
    return reply.send({ folders: jobFolderOptions(ids) });
  });

  app.get("/api/library/gallery/duplicate-jobs/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = getJob(id);
    if (!job) { return refuse(reply, "not_found"); }
    return reply.send({ job, isOwner: job.ownerUserId === request.user!.id });
  });

  app.post("/api/library/gallery/duplicate-jobs", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(createSchema, request.body ?? {});
    if (parsed.error) { return reply.code(400).send({ error: "Invalid request", details: parsed.error }); }

    const outcome = createJob({ ownerUserId: request.user!.id, ...parsed.data });
    if (!outcome.ok) { return refuse(reply, outcome.refused, outcome.detail); }

    logActivity({
      event: "library.gallery.duplicate_job_created",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: null,
      detail: `Started a duplicate cleanup over ${outcome.job.libraries.length} photo librar${outcome.job.libraries.length === 1 ? "y" : "ies"}.`,
      ipAddress: request.ip
    });
    return reply.code(201).send(jobsPayload(request.user!.id));
  });

  app.patch("/api/library/gallery/duplicate-jobs/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = parseBody(scopeSchema, request.body ?? {});
    if (parsed.error) { return reply.code(400).send({ error: "Invalid request", details: parsed.error }); }
    return send(reply, updateJobScope(id, request.user!.id, parsed.data), request.user!.id);
  });

  app.post("/api/library/gallery/duplicate-jobs/:id/preferences", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = parseBody(preferencesSchema, request.body ?? {});
    if (parsed.error) { return reply.code(400).send({ error: "Invalid request", details: parsed.error }); }
    return send(reply, setJobFolderPreferences(id, request.user!.id, parsed.data.folders), request.user!.id);
  });

  // Start the job's scan and answer at once, with the job left in 'scanning'.
  //
  // It used to run inline, which was true while the only work was the snapshot — that
  // reads no files. It now fingerprints the job's libraries first, which does read
  // files and can take a long time on a library nobody has scanned before, so the page
  // follows scan_progress instead of holding a request open. Nudge the worker so it
  // starts without waiting for its next poll.
  app.post("/api/library/gallery/duplicate-jobs/:id/scan", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const outcome = startJobScan(id, request.user!.id);
    if (!outcome.ok) { return refuse(reply, outcome.refused, outcome.detail); }
    logActivity({
      event: "library.gallery.duplicate_job_scanned",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: null,
      detail: "Started the scan for a duplicate cleanup.",
      ipAddress: request.ip
    });
    void processDuplicateScanQueue().catch(() => { /* logged per-job */ });
    return reply.send(jobsPayload(request.user!.id));
  });

  // One page of the snapshot. Anyone who may see the job may read its results; only
  // the owner may act on them.
  const resultsSchema = z.object({
    page: z.coerce.number().int().min(1).max(100000).optional(),
    perPage: z.coerce.number().int().min(1).max(200).optional(),
    q: z.string().max(200).optional(),
    type: z.enum(["photo_set", "folder_set", "contained", "overlap"]).optional(),
    tier: z.enum(["exact", "near"]).optional(),
    review: z.enum(["unreviewed", "reviewed", "skipped"]).optional(),
    library: z.string().max(64).optional()
  });
  app.get("/api/library/gallery/duplicate-jobs/:id/results", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = getJob(id);
    if (!job) { return refuse(reply, "not_found"); }
    const parsed = parseBody(resultsSchema, request.query ?? {});
    if (parsed.error) { return reply.code(400).send({ error: "Invalid request", details: parsed.error }); }

    const filter: ResultFilter = {
      search: parsed.data.q,
      type: parsed.data.type,
      tier: parsed.data.tier,
      review: parsed.data.review,
      libraryId: parsed.data.library || undefined
    };
    const perPage = parsed.data.perPage ?? 25;
    const total = countJobResults(id, filter);
    // Clamp rather than correct in state, so a list that shrank under a deletion
    // can't strand the view past its end.
    const pages = Math.max(1, Math.ceil(total / perPage));
    const page = Math.min(parsed.data.page ?? 1, pages);
    return reply.send({
      results: listJobResults(id, perPage, (page - 1) * perPage, filter),
      total,
      allResults: countJobResults(id),
      // Sent with the page rather than fetched separately, so the number the sweep's
      // confirm promises always belongs to the filters actually on screen.
      sweep: sweepPreview(id, filter),
      page,
      perPage,
      isOwner: job.ownerUserId === request.user!.id
    });
  });

  // Clear every byte-identical set the given filters leave on screen. Same filters as
  // the listing above — the button clears what a person can see, not everything a scan
  // found. Never near-identical: sweepableResultIds forces the exact tier.
  app.post("/api/library/gallery/duplicate-jobs/:id/results/sweep", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = parseBody(resultsSchema, request.query ?? {});
    if (parsed.error) { return reply.code(400).send({ error: "Invalid request", details: parsed.error }); }

    const outcome = sweepJobResults(id, request.user!.id, {
      search: parsed.data.q,
      type: parsed.data.type,
      tier: parsed.data.tier,
      review: parsed.data.review,
      libraryId: parsed.data.library || undefined
    });
    if (!outcome.ok) { return refuse(reply, outcome.refused, outcome.detail); }

    logActivity({
      event: "library.gallery.duplicate_job_swept",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: null,
      detail: `Duplicate cleanup sweep: moved ${outcome.job.deleted} identical cop${outcome.job.deleted === 1 ? "y" : "ies"} to the Recycle Bin across ${outcome.job.results} set${outcome.job.results === 1 ? "" : "s"}.`,
      ipAddress: request.ip
    });
    return reply.send({ ...outcome.job, ...jobsPayload(request.user!.id) });
  });

  // "Not in this cleanup" — a note on the job, not a decision about the photos.
  const markSchema = z.object({ mark: z.enum(["unreviewed", "reviewed", "skipped"]) });
  app.post("/api/library/gallery/duplicate-jobs/:id/results/:resultId/mark", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id, resultId } = request.params as { id: string; resultId: string };
    const parsed = parseBody(markSchema, request.body ?? {});
    if (parsed.error) { return reply.code(400).send({ error: "Invalid request", details: parsed.error }); }
    const outcome = markResult(id, request.user!.id, resultId, parsed.data.mark);
    if (!outcome.ok) { return refuse(reply, outcome.refused, outcome.detail); }
    return reply.send(outcome.job);
  });

  // Overrule the scan about ONE copy: keep this one after all, or let that one go.
  //
  // The only part of a snapshot a person edits directly. Everything else that changes a
  // keeper goes through apply-preferences, which re-runs the scan — right for an
  // instruction the scan can act on, wrong here, because a re-run would compute the
  // same keeper again and discard the disagreement.
  const roleSchema = z.object({ role: z.enum(["keep", "delete"]) });

  // Each refusal names the copy's situation, since each has a different remedy. Every
  // one of them is "this copy was never yours to decide" or "your page is stale" —
  // there is deliberately no refusal for the SHAPE of the answer. Keeping all of them,
  // one of them or none of them are all things a person may mean.
  const ROLE_REFUSALS: Record<RoleRefusal, { code: number; error: string }> = {
    not_a_photo_set: {
      code: 409,
      error: "This card is about whole folders, so single copies can't be picked out of it."
    },
    no_such_member: { code: 404, error: "That copy is no longer part of this set." },
    member_protected: {
      code: 409,
      error: "That copy is in a protected library, so it was never going to be deleted."
    },
    member_gone: { code: 409, error: "That copy has already been moved to the Recycle Bin." }
  };

  app.post(
    "/api/library/gallery/duplicate-jobs/:id/results/:resultId/members/:memberId/role",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const { id, resultId, memberId } = request.params as { id: string; resultId: string; memberId: string };
      const parsed = parseBody(roleSchema, request.body ?? {});
      if (parsed.error) { return reply.code(400).send({ error: "Invalid request", details: parsed.error }); }

      const outcome = setMemberRole(id, request.user!.id, resultId, memberId, parsed.data.role);
      if (!outcome.ok) {
        const own = ROLE_REFUSALS[outcome.refused as RoleRefusal];
        if (own) { return reply.code(own.code).send({ error: own.error }); }
        return refuse(reply, outcome.refused as JobRefusal, "detail" in outcome ? outcome.detail : undefined);
      }

      // Answers with the ONE card that changed, not the page.
      //
      // Reclaimable bytes are part of the results ordering, so re-reading the page here
      // would re-sort it: the card someone just clicked slides off to wherever its new
      // total puts it, the page scrolls nowhere, and a different set is suddenly under
      // the cursor. The client patches this row in place instead. The job totals and the
      // sweep figure come along because both are on screen and both just moved.
      const scope = parseBody(resultsSchema, request.query ?? {});
      const filter: ResultFilter = scope.error ? {} : {
        search: scope.data.q,
        type: scope.data.type,
        tier: scope.data.tier,
        review: scope.data.review,
        libraryId: scope.data.library || undefined
      };
      return reply.send({
        member: outcome.job,
        result: listJobResults(id, 1, 0, { resultId })[0] ?? null,
        sweep: sweepPreview(id, filter),
        job: getJob(id)
      });
    }
  );

  // "These are not duplicates" — the standing record every future scan honours. A
  // different statement from the mark above, and the page says so.
  app.post("/api/library/gallery/duplicate-jobs/:id/results/:resultId/dismiss", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id, resultId } = request.params as { id: string; resultId: string };
    const outcome = dismissResult(id, request.user!.id, resultId);
    if (!outcome.ok) { return refuse(reply, outcome.refused, outcome.detail); }
    logActivity({
      event: "library.gallery.duplicate_job_dismissed",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: null,
      detail: "Marked a duplicate cleanup result as not duplicates; future scans won't pair them again.",
      ipAddress: request.ip
    });
    return reply.send(outcome.job);
  });

  // What the snapshot promised, against the library as it stands. Safe to call at
  // any time — it writes nothing to a photo, only brings each member's own status up
  // to date so the page can show what has moved on since the scan.
  app.get("/api/library/gallery/duplicate-jobs/:id/results/:resultId/check", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id, resultId } = request.params as { id: string; resultId: string };
    const outcome = checkResult(id, resultId);
    if (!outcome) { return refuse(reply, "not_found"); }
    return reply.send(outcome);
  });

  // Delete one result's doomed copies. All-or-nothing on the re-check: if anything
  // has changed since the scan, nothing is removed and the reply says what.
  app.post("/api/library/gallery/duplicate-jobs/:id/results/:resultId/resolve", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id, resultId } = request.params as { id: string; resultId: string };
    const outcome = resolveJobResult(id, request.user!.id, resultId);
    if (!outcome.ok) {
      if (outcome.refused === "stale") {
        return reply.code(409).send({
          error: "Some of these photos have changed since the scan, so nothing was deleted. Re-scan and look again.",
          check: outcome.check
        });
      }
      if (outcome.refused === "nothing_to_do") {
        return reply.code(409).send({ error: "There is nothing left to remove here." });
      }
      return refuse(reply, outcome.refused, "detail" in outcome ? outcome.detail : undefined);
    }
    return reply.send({ ...outcome.job, job: getJob(id) });
  });

  // Recompute the job's results under its current folder instructions. Review marks
  // go with them — they were made about a different proposal.
  app.post("/api/library/gallery/duplicate-jobs/:id/apply-preferences", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const outcome = applyPreferences(id, request.user!.id);
    if (!outcome.ok) { return refuse(reply, outcome.refused, outcome.detail); }
    return reply.send(jobsPayload(request.user!.id));
  });

  app.post("/api/library/gallery/duplicate-jobs/:id/complete", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const outcome = completeJob(id, request.user!.id, request.user!.role === "admin");
    if (!outcome.ok) { return refuse(reply, outcome.refused, outcome.detail); }
    logActivity({
      event: "library.gallery.duplicate_job_completed",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: null,
      detail: `Finished a duplicate cleanup: ${outcome.job.totals.deleted} copies removed.`,
      ipAddress: request.ip
    });
    return reply.send(jobsPayload(request.user!.id));
  });

  const cancelSchema = z.object({ reason: z.string().max(500).nullish() });
  app.post("/api/library/gallery/duplicate-jobs/:id/cancel", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = parseBody(cancelSchema, request.body ?? {});
    if (parsed.error) { return reply.code(400).send({ error: "Invalid request", details: parsed.error }); }
    const outcome = cancelJob(id, request.user!.id, request.user!.role === "admin", parsed.data.reason ?? undefined);
    if (!outcome.ok) { return refuse(reply, outcome.refused, outcome.detail); }
    logActivity({
      event: "library.gallery.duplicate_job_cancelled",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: null,
      detail: "Cancelled a duplicate cleanup. Photos already removed stay in the Recycle Bin.",
      ipAddress: request.ip
    });
    return reply.send(jobsPayload(request.user!.id));
  });

  const reassignSchema = z.object({ userId: z.string().min(1).max(64) });
  app.post("/api/library/gallery/duplicate-jobs/:id/reassign", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = parseBody(reassignSchema, request.body ?? {});
    if (parsed.error) { return reply.code(400).send({ error: "Invalid request", details: parsed.error }); }
    const outcome = reassignJob(id, parsed.data.userId, request.user!.id);
    if (!outcome.ok) { return refuse(reply, outcome.refused, outcome.detail); }
    logActivity({
      event: "library.gallery.duplicate_job_reassigned",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: parsed.data.userId,
      detail: `Handed a duplicate cleanup to ${outcome.job.ownerName}.`,
      ipAddress: request.ip
    });
    return reply.send(jobsPayload(request.user!.id));
  });

  // Removes the job's own paperwork. Photos already in the Recycle Bin stay there —
  // said plainly in the confirm on the page, because "delete job" next to a list of
  // deleted photos reads as undoing them.
  app.delete("/api/library/gallery/duplicate-jobs/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const outcome = deleteJob(id, request.user!.id, request.user!.role === "admin");
    if (!outcome.ok) { return refuse(reply, outcome.refused, outcome.detail); }
    logActivity({
      event: "library.gallery.duplicate_job_deleted",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: null,
      detail: "Deleted a duplicate cleanup job and its results. Files already moved to the Recycle Bin are unaffected.",
      ipAddress: request.ip
    });
    return reply.send(jobsPayload(request.user!.id));
  });
}
