// Admin API for duplicate cleanup jobs (duplicate-jobs.ts). Admin-only throughout,
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
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import {
  activeJob,
  cancelJob,
  completeJob,
  createJob,
  deleteJob,
  galleryLibraryOptions,
  getJob,
  reassignJob,
  recentJobs,
  setJobFolderPreferences,
  updateJobScope,
  type DuplicateJob,
  type JobOutcome,
  type JobRefusal
} from "./duplicate-jobs.js";
import { countJobResults, listJobResults, runJobScan, type ResultFilter } from "./duplicate-job-scan.js";
import { applyPreferences, dismissResult, markResult } from "./duplicate-job-review.js";
import { checkResult, resolveJobResult } from "./duplicate-job-resolve.js";

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
function refuse(reply: { code: (n: number) => { send: (body: unknown) => void } }, refused: JobRefusal, detail?: string) {
  const answer = REFUSALS[refused];
  const spoken = detail && refused === "scan_failed" ? `${answer.error} ${detail}` : answer.error;
  reply.code(answer.code).send({ error: spoken, detail: detail ?? null });
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
  reply: { send: (body: unknown) => void; code: (n: number) => { send: (body: unknown) => void } },
  outcome: JobOutcome<DuplicateJob | { id: string }>,
  userId: string
) => {
  if (!outcome.ok) { refuse(reply, outcome.refused, outcome.detail); return; }
  reply.send(jobsPayload(userId));
};

const scopeSchema = z.object({
  libraryIds: z.array(z.string().min(1).max(64)).max(200).optional(),
  duplicateType: z.enum(["folders", "files"]).optional(),
  mediaType: z.enum(["photo", "video", "both"]).optional(),
  currentStep: z.number().int().min(1).max(3).optional()
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
    reply.send(jobsPayload(request.user!.id));
  });

  app.get("/api/library/gallery/duplicate-jobs/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = getJob(id);
    if (!job) { refuse(reply, "not_found"); return; }
    reply.send({ job, isOwner: job.ownerUserId === request.user!.id });
  });

  app.post("/api/library/gallery/duplicate-jobs", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(createSchema, request.body ?? {});
    if (parsed.error) { reply.code(400).send({ error: "Invalid request", details: parsed.error }); return; }

    const outcome = createJob({ ownerUserId: request.user!.id, ...parsed.data });
    if (!outcome.ok) { refuse(reply, outcome.refused, outcome.detail); return; }

    logActivity({
      event: "library.gallery.duplicate_job_created",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: null,
      detail: `Started a duplicate cleanup over ${outcome.job.libraries.length} photo librar${outcome.job.libraries.length === 1 ? "y" : "ies"}.`,
      ipAddress: request.ip
    });
    reply.code(201).send(jobsPayload(request.user!.id));
  });

  app.patch("/api/library/gallery/duplicate-jobs/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = parseBody(scopeSchema, request.body ?? {});
    if (parsed.error) { reply.code(400).send({ error: "Invalid request", details: parsed.error }); return; }
    send(reply, updateJobScope(id, request.user!.id, parsed.data), request.user!.id);
  });

  app.post("/api/library/gallery/duplicate-jobs/:id/preferences", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = parseBody(preferencesSchema, request.body ?? {});
    if (parsed.error) { reply.code(400).send({ error: "Invalid request", details: parsed.error }); return; }
    send(reply, setJobFolderPreferences(id, request.user!.id, parsed.data.folders), request.user!.id);
  });

  // Compute the job's answers and write its snapshot. Reads no files — the digests
  // were left behind by the hashing pass — so this is fast enough to answer inline,
  // and the job is left in review with its results already counted.
  app.post("/api/library/gallery/duplicate-jobs/:id/scan", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const outcome = runJobScan(id, request.user!.id);
    if (!outcome.ok) { refuse(reply, outcome.refused, outcome.detail); return; }
    logActivity({
      event: "library.gallery.duplicate_job_scanned",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: null,
      detail: `Scanned for a duplicate cleanup: ${outcome.summary?.results ?? 0} results found.`,
      ipAddress: request.ip
    });
    reply.send({ ...jobsPayload(request.user!.id), summary: outcome.summary });
  });

  // One page of the snapshot. Anyone who may see the job may read its results; only
  // the owner may act on them.
  const resultsSchema = z.object({
    page: z.coerce.number().int().min(1).max(100000).optional(),
    perPage: z.coerce.number().int().min(1).max(200).optional(),
    q: z.string().max(200).optional(),
    type: z.enum(["photo_set", "folder_set", "contained", "overlap"]).optional(),
    review: z.enum(["unreviewed", "reviewed", "skipped"]).optional(),
    library: z.string().max(64).optional()
  });
  app.get("/api/library/gallery/duplicate-jobs/:id/results", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = getJob(id);
    if (!job) { refuse(reply, "not_found"); return; }
    const parsed = parseBody(resultsSchema, request.query ?? {});
    if (parsed.error) { reply.code(400).send({ error: "Invalid request", details: parsed.error }); return; }

    const filter: ResultFilter = {
      search: parsed.data.q,
      type: parsed.data.type,
      review: parsed.data.review,
      libraryId: parsed.data.library || undefined
    };
    const perPage = parsed.data.perPage ?? 25;
    const total = countJobResults(id, filter);
    // Clamp rather than correct in state, so a list that shrank under a deletion
    // can't strand the view past its end.
    const pages = Math.max(1, Math.ceil(total / perPage));
    const page = Math.min(parsed.data.page ?? 1, pages);
    reply.send({
      results: listJobResults(id, perPage, (page - 1) * perPage, filter),
      total,
      allResults: countJobResults(id),
      page,
      perPage,
      isOwner: job.ownerUserId === request.user!.id
    });
  });

  // "Not in this cleanup" — a note on the job, not a decision about the photos.
  const markSchema = z.object({ mark: z.enum(["unreviewed", "reviewed", "skipped"]) });
  app.post("/api/library/gallery/duplicate-jobs/:id/results/:resultId/mark", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id, resultId } = request.params as { id: string; resultId: string };
    const parsed = parseBody(markSchema, request.body ?? {});
    if (parsed.error) { reply.code(400).send({ error: "Invalid request", details: parsed.error }); return; }
    const outcome = markResult(id, request.user!.id, resultId, parsed.data.mark);
    if (!outcome.ok) { refuse(reply, outcome.refused, outcome.detail); return; }
    reply.send(outcome.job);
  });

  // "These are not duplicates" — the standing record every future scan honours. A
  // different statement from the mark above, and the page says so.
  app.post("/api/library/gallery/duplicate-jobs/:id/results/:resultId/dismiss", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id, resultId } = request.params as { id: string; resultId: string };
    const outcome = dismissResult(id, request.user!.id, resultId);
    if (!outcome.ok) { refuse(reply, outcome.refused, outcome.detail); return; }
    logActivity({
      event: "library.gallery.duplicate_job_dismissed",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: null,
      detail: "Marked a duplicate cleanup result as not duplicates; future scans won't pair them again.",
      ipAddress: request.ip
    });
    reply.send(outcome.job);
  });

  // What the snapshot promised, against the library as it stands. Safe to call at
  // any time — it writes nothing to a photo, only brings each member's own status up
  // to date so the page can show what has moved on since the scan.
  app.get("/api/library/gallery/duplicate-jobs/:id/results/:resultId/check", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id, resultId } = request.params as { id: string; resultId: string };
    const outcome = checkResult(id, resultId);
    if (!outcome) { refuse(reply, "not_found"); return; }
    reply.send(outcome);
  });

  // Delete one result's doomed copies. All-or-nothing on the re-check: if anything
  // has changed since the scan, nothing is removed and the reply says what.
  app.post("/api/library/gallery/duplicate-jobs/:id/results/:resultId/resolve", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id, resultId } = request.params as { id: string; resultId: string };
    const outcome = resolveJobResult(id, request.user!.id, resultId);
    if (!outcome.ok) {
      if (outcome.refused === "stale") {
        reply.code(409).send({
          error: "Some of these photos have changed since the scan, so nothing was deleted. Re-scan and look again.",
          check: outcome.check
        });
        return;
      }
      if (outcome.refused === "nothing_to_do") {
        reply.code(409).send({ error: "There is nothing left to remove here." });
        return;
      }
      refuse(reply, outcome.refused, "detail" in outcome ? outcome.detail : undefined);
      return;
    }
    reply.send({ ...outcome.job, job: getJob(id) });
  });

  // Recompute the job's results under its current folder instructions. Review marks
  // go with them — they were made about a different proposal.
  app.post("/api/library/gallery/duplicate-jobs/:id/apply-preferences", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const outcome = applyPreferences(id, request.user!.id);
    if (!outcome.ok) { refuse(reply, outcome.refused, outcome.detail); return; }
    reply.send(jobsPayload(request.user!.id));
  });

  app.post("/api/library/gallery/duplicate-jobs/:id/complete", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const outcome = completeJob(id, request.user!.id, request.user!.role === "admin");
    if (!outcome.ok) { refuse(reply, outcome.refused, outcome.detail); return; }
    logActivity({
      event: "library.gallery.duplicate_job_completed",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: null,
      detail: `Finished a duplicate cleanup: ${outcome.job.totals.deleted} copies removed.`,
      ipAddress: request.ip
    });
    reply.send(jobsPayload(request.user!.id));
  });

  const cancelSchema = z.object({ reason: z.string().max(500).nullish() });
  app.post("/api/library/gallery/duplicate-jobs/:id/cancel", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = parseBody(cancelSchema, request.body ?? {});
    if (parsed.error) { reply.code(400).send({ error: "Invalid request", details: parsed.error }); return; }
    const outcome = cancelJob(id, request.user!.id, request.user!.role === "admin", parsed.data.reason ?? undefined);
    if (!outcome.ok) { refuse(reply, outcome.refused, outcome.detail); return; }
    logActivity({
      event: "library.gallery.duplicate_job_cancelled",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: null,
      detail: "Cancelled a duplicate cleanup. Photos already removed stay in the Recycle Bin.",
      ipAddress: request.ip
    });
    reply.send(jobsPayload(request.user!.id));
  });

  const reassignSchema = z.object({ userId: z.string().min(1).max(64) });
  app.post("/api/library/gallery/duplicate-jobs/:id/reassign", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = parseBody(reassignSchema, request.body ?? {});
    if (parsed.error) { reply.code(400).send({ error: "Invalid request", details: parsed.error }); return; }
    const outcome = reassignJob(id, parsed.data.userId, request.user!.id);
    if (!outcome.ok) { refuse(reply, outcome.refused, outcome.detail); return; }
    logActivity({
      event: "library.gallery.duplicate_job_reassigned",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: parsed.data.userId,
      detail: `Handed a duplicate cleanup to ${outcome.job.ownerName}.`,
      ipAddress: request.ip
    });
    reply.send(jobsPayload(request.user!.id));
  });

  // Removes the job's own paperwork. Photos already in the Recycle Bin stay there —
  // said plainly in the confirm on the page, because "delete job" next to a list of
  // deleted photos reads as undoing them.
  app.delete("/api/library/gallery/duplicate-jobs/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const outcome = deleteJob(id, request.user!.id, request.user!.role === "admin");
    if (!outcome.ok) { refuse(reply, outcome.refused, outcome.detail); return; }
    logActivity({
      event: "library.gallery.duplicate_job_deleted",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: null,
      detail: "Deleted a duplicate cleanup job and its results. Files already moved to the Recycle Bin are unaffected.",
      ipAddress: request.ip
    });
    reply.send(jobsPayload(request.user!.id));
  });
}
