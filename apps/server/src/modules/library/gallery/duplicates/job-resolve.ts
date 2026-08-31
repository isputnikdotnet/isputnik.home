// Carrying out one of a cleanup job's offers.
//
// A job's results are a snapshot, and the whole point of a snapshot is that you can
// come back to it next week. Which means by the time anyone presses Delete, the
// library may have moved on: photos deleted elsewhere, files re-saved by an editor,
// a library turned external, the Recycle Bin emptied. So nothing here trusts the
// snapshot — it is re-checked against the library as it stands, file by file, and a
// single disagreement stops the whole result rather than deleting the part that still
// matches.
//
// The order is deliberate and matches the older tiers: check everything first, then
// hand each doomed photo's tags, albums, collections and tagged people to the copy
// that survives it, and only then move the file to the Recycle Bin. Nothing is ever
// erased — trashBook refuses outright for a library the app may only read.
import { db, logActivity } from "../../../../db.js";
import { trashBook, libraryAllowsDelete } from "../../shared/trash.js";
import { lockCovering } from "../../shared/folder-locks.js";
import { absorbDuplicateMetadata } from "./items.js";
import { getJob, recordAction, type JobOutcome } from "./jobs.js";
import { sweepableResultIds, type ResultFilter } from "./job-scan.js";

/** Why a member can no longer be acted on. Each one is a different sentence on the
 *  page, because each has a different remedy. */
export type StaleReason = "missing" | "modified" | "protected";

export interface MemberCheck {
  memberId: string;
  path: string;
  libraryId: string;
  role: "keep" | "delete" | "protected";
  stale: StaleReason | null;
}

export interface ResultCheck {
  resultId: string;
  ok: boolean;
  members: MemberCheck[];
  /** The members standing in the way, for the message the page shows. */
  problems: MemberCheck[];
}

interface MemberRow {
  id: string;
  item_id: string | null;
  library_id: string;
  path: string;
  size_snapshot: number | null;
  mtime_snapshot: string | null;
  content_hash: string | null;
  distance: number;
  role: "keep" | "delete" | "protected";
  status: string;
  keeper_member_id: string | null;
}

const membersOf = (resultId: string): MemberRow[] =>
  db.prepare(`
    SELECT id, item_id, library_id, path, size_snapshot, mtime_snapshot, content_hash,
           distance, role, status, keeper_member_id
    FROM duplicate_job_result_members WHERE result_id = ? ORDER BY role DESC, path
  `).all(resultId) as MemberRow[];

interface LiveRow {
  item_id: string;
  size: number | null;
  modified_at: string | null;
  content_hash: string | null;
}

function liveFiles(itemIds: string[]): Map<string, LiveRow> {
  const out = new Map<string, LiveRow>();
  if (itemIds.length === 0) return out;
  const rows = db.prepare(`
    SELECT li.id AS item_id, gd.size, gd.modified_at, gd.content_hash
    FROM library_items li
    JOIN gallery_details gd ON gd.item_id = li.id
    WHERE li.id IN (${itemIds.map(() => "?").join(",")})
      AND li.deleted_at IS NULL AND li.status = 'ready'
  `).all(...itemIds) as LiveRow[];
  for (const row of rows) out.set(row.item_id, row);
  return out;
}

/** Compare the snapshot with the library as it stands. Nothing is written to the
 *  photos; only each member's own status is brought up to date, so the page can say
 *  which rows are stale and why without pretending the offer is still good. */
export function checkResult(jobId: string, resultId: string): ResultCheck | null {
  const exists = db.prepare("SELECT id FROM duplicate_job_results WHERE id = ? AND job_id = ?")
    .get(resultId, jobId) as { id: string } | undefined;
  if (!exists) return null;

  const members = membersOf(resultId);
  const live = liveFiles(members.map((member) => member.item_id).filter((id): id is string => Boolean(id)));
  const byId = new Map(members.map((member) => [member.id, member]));

  const checks: MemberCheck[] = members.map((member) => {
    const base = {
      memberId: member.id,
      path: member.path,
      libraryId: member.library_id,
      role: member.role
    };
    // Already carried out — not stale, just done.
    if (member.status === "deleted") return { ...base, stale: null };

    const current = member.item_id ? live.get(member.item_id) : undefined;
    if (!current) return { ...base, stale: "missing" as const };

    // Changed under us. Size, digest and modification time are all compared: a photo
    // re-saved at the same byte length by an editor keeps its size and changes the
    // rest, and a restore from backup can do the reverse.
    const changed = current.size !== member.size_snapshot
      || current.content_hash !== member.content_hash
      || current.modified_at !== member.mtime_snapshot;
    if (changed) return { ...base, stale: "modified" as const };

    // Only the copies being removed care about the library's policy — a keeper in a
    // read-only library is exactly what should happen. A folder locked AFTER the
    // snapshot reads the same way: policy forbids deleting this copy, so the offer
    // refuses cleanly here instead of hitting trashBook's backstop mid-set.
    if (member.role === "delete"
        && (!libraryAllowsDelete(member.library_id) || lockCovering(member.library_id, member.path) !== null)) {
      return { ...base, stale: "protected" as const };
    }
    return { ...base, stale: null };
  });

  // A doomed photo is only safe to remove while the copy that survives it is still
  // there and still itself. Checked explicitly, because "my file is fine" says
  // nothing about the file it was promised to hand its tags to.
  //
  // A NULL keeper is not a broken promise: it is a set where the person kept nothing,
  // so no copy was ever promised to survive this one. That is the one case where a
  // doomed row with no keeper is exactly right, and treating it as stale would make a
  // deliberate answer un-actionable.
  for (const check of checks) {
    if (check.stale || check.role !== "delete") continue;
    const member = byId.get(check.memberId)!;
    if (member.status === "deleted") continue;
    if (member.keeper_member_id === null) continue;
    const keeper = checks.find((other) => other.memberId === member.keeper_member_id);
    if (!keeper || keeper.stale) check.stale = "missing";
  }

  const stamp = db.prepare(`
    UPDATE duplicate_job_result_members
    SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND status NOT IN ('deleted', 'skipped')
  `);
  db.transaction(() => {
    for (const check of checks) {
      stamp.run(check.stale === "modified" ? "modified" : check.stale ? "missing" : "pending", check.memberId);
    }
  })();

  const problems = checks.filter((check) => check.stale !== null);
  return { resultId, ok: problems.length === 0, members: checks, problems };
}

export interface SweepOutcome {
  /** Sets cleared completely. */
  results: number;
  /** Copies moved to the Recycle Bin. */
  deleted: number;
  bytes: number;
  /** Sets left alone because something had moved since the scan. */
  skipped: number;
  /** Individual copies the Recycle Bin refused. */
  failed: number;
}

/** Clear every byte-identical set the current filters leave on screen.
 *
 *  Per RESULT, not per sweep: a set whose copies have moved since the scan is skipped
 *  and the rest go ahead, because refusing the whole sweep over one stale photo would
 *  make the button useless on exactly the libraries that need it most. Each result
 *  still gets the same all-or-nothing revalidation it would get on its own — this only
 *  presses the same button repeatedly, it does not take a shortcut through the checks.
 *
 *  What it may touch is decided by sweepableResultIds, which forces the exact tier. */
export function sweepJobResults(
  jobId: string,
  userId: string,
  filter: ResultFilter = {}
): JobOutcome<SweepOutcome> {
  const job = getJob(jobId);
  if (!job) return { ok: false, refused: "not_found" };
  if (job.ownerUserId !== userId) return { ok: false, refused: "not_owner" };
  if (job.status !== "review" && job.status !== "paused" && job.status !== "processing") {
    return { ok: false, refused: "not_reviewable", detail: job.status };
  }

  const totals: SweepOutcome = { results: 0, deleted: 0, bytes: 0, skipped: 0, failed: 0 };
  for (const resultId of sweepableResultIds(jobId, filter)) {
    const outcome = resolveJobResult(jobId, userId, resultId);
    if (!outcome.ok) { totals.skipped += 1; continue; }
    totals.results += 1;
    totals.deleted += outcome.job.deletedItemIds.length;
    totals.bytes += outcome.job.reclaimedBytes;
    totals.failed += outcome.job.failed.length;
  }

  recordAction({
    jobId, userId, action: "results.swept",
    status: totals.skipped > 0 || totals.failed > 0 ? "partial" : "ok",
    details: `${totals.deleted} copies from ${totals.results} identical sets`
      + (totals.skipped > 0 ? `, ${totals.skipped} skipped as changed` : "")
      + (totals.failed > 0 ? `, ${totals.failed} refused` : "") + "."
  });
  return { ok: true, job: totals };
}

export interface ResolveOutcome {
  resultId: string;
  deletedItemIds: string[];
  failed: { path: string; error: string }[];
  reclaimedBytes: number;
}

export type ResolveRefusal = "stale" | "nothing_to_do";

/** Delete one result's doomed copies. All-or-nothing on the CHECK: if anything has
 *  moved since the scan, nothing is removed and the page is told what changed. */
export function resolveJobResult(
  jobId: string,
  userId: string,
  resultId: string
): JobOutcome<ResolveOutcome> | { ok: false; refused: ResolveRefusal; check: ResultCheck } {
  const job = getJob(jobId);
  if (!job) return { ok: false, refused: "not_found" };
  if (job.ownerUserId !== userId) return { ok: false, refused: "not_owner" };
  if (job.status !== "review" && job.status !== "paused" && job.status !== "processing") {
    return { ok: false, refused: "not_reviewable", detail: job.status };
  }

  const check = checkResult(jobId, resultId);
  if (!check) return { ok: false, refused: "not_found" };
  if (!check.ok) {
    db.prepare(`
      UPDATE duplicate_job_results SET status = 'error',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
    `).run(resultId);
    recordAction({
      jobId, userId, action: "result.stale", targetType: "result", targetId: resultId, status: "refused",
      details: check.problems.map((problem) => `${problem.path}: ${problem.stale}`).join("; ").slice(0, 500)
    });
    return { ok: false, refused: "stale", check };
  }

  const members = membersOf(resultId);
  const byId = new Map(members.map((member) => [member.id, member]));
  const doomed = members.filter((member) => member.role === "delete" && member.status !== "deleted");
  if (doomed.length === 0) return { ok: false, refused: "nothing_to_do", check };

  const deletedItemIds: string[] = [];
  const failed: { path: string; error: string }[] = [];
  let reclaimed = 0;

  const markMember = db.prepare(`
    UPDATE duplicate_job_result_members
    SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
  `);

  for (const member of doomed) {
    const keeper = member.keeper_member_id ? byId.get(member.keeper_member_id) : undefined;
    // A keeper that was RECORDED and cannot be found is a broken snapshot and stops
    // this copy. A keeper that was never recorded is the "keep nothing" answer, which
    // is allowed — there is simply nobody to inherit, so the hand-over is skipped.
    if (!member.item_id || (member.keeper_member_id !== null && !keeper?.item_id)) {
      failed.push({ path: member.path, error: "No surviving copy is recorded for this photo." });
      markMember.run("error", member.id);
      continue;
    }
    // Hand over the hand-filed work first, so nothing filed by a person is lost with
    // the file.
    //
    // Faces are the exception, and the distance is what decides. On a byte-identical
    // copy the pixels are the same, so a face box drawn on one describes the same spot
    // on the other. A near-identical copy is a DIFFERENT image — resized, re-cropped,
    // re-compressed — and its boxes are normalised to its own frame, so moving them
    // would land rectangles on the wrong part of the keeper.
    if (keeper?.item_id) {
      absorbDuplicateMetadata(keeper.item_id, [member.item_id], { moveFaces: member.distance === 0 });
    }
    try {
      trashBook(member.item_id, userId, { source: "duplicate_cleanup" });
      deletedItemIds.push(member.item_id);
      reclaimed += member.size_snapshot ?? 0;
      markMember.run("deleted", member.id);
    } catch (err) {
      failed.push({
        path: member.path,
        error: err instanceof Error ? err.message : "Could not move the photo to the Recycle Bin."
      });
      markMember.run("error", member.id);
      db.prepare(`
        INSERT INTO duplicate_job_errors (id, job_id, target_type, target_id, error_code, message)
        VALUES (lower(hex(randomblob(8))), ?, 'member', ?, 'trash_failed', ?)
      `).run(jobId, member.id, err instanceof Error ? err.message : "unknown");
    }
  }

  // Where the result stands now. Resolved when every doomed copy has gone; left in
  // error when some refused, so the page can offer the rest again rather than
  // reporting a clean sweep that wasn't.
  const remaining = db.prepare(`
    SELECT COUNT(*) AS n FROM duplicate_job_result_members
    WHERE result_id = ? AND role = 'delete' AND status NOT IN ('deleted', 'skipped')
  `).get(resultId) as { n: number };
  db.prepare(`
    UPDATE duplicate_job_results
    SET status = ?, review_status = 'reviewed', reclaimable_bytes = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(
    remaining.n === 0 ? "resolved" : "error",
    Math.max((db.prepare("SELECT reclaimable_bytes AS b FROM duplicate_job_results WHERE id = ?")
      .get(resultId) as { b: number }).b - reclaimed, 0),
    resultId
  );

  recordAction({
    jobId, userId, action: "result.resolved", targetType: "result", targetId: resultId,
    status: failed.length > 0 ? "partial" : "ok",
    details: `${deletedItemIds.length} moved to the Recycle Bin${failed.length > 0 ? `, ${failed.length} refused` : ""}.`
  });

  if (deletedItemIds.length > 0) {
    logActivity({
      event: "library.gallery.duplicate_job_resolved",
      actorUserId: userId,
      targetType: "library",
      targetId: doomed[0].library_id,
      detail: `Duplicate cleanup: moved ${deletedItemIds.length} photo${deletedItemIds.length === 1 ? "" : "s"} to the Recycle Bin, each one kept elsewhere.`,
      ipAddress: null
    });
  }

  return { ok: true, job: { resultId, deletedItemIds, failed, reclaimedBytes: reclaimed } };
}
