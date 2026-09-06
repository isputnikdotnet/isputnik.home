// Replace — the Photo Inbox check's own verb (docs/photo-inbox-proposal.md,
// decision 7). A set found by the check asks "is the new scan better than what the
// library has?", and when it is, the answer is not "delete the old one and keep
// the new": that makes a NEW item and leaves every album, story, tag and face
// pointing at a photo that no longer exists. Replace hands the incoming file to
// the library's item through replaceGalleryAssetFile, which keeps the item and
// parks the old file beside the Recycle Bin, then retires the Inbox's row — its
// file is now the library's.
import fs from "node:fs";
import path from "node:path";
import { db, logActivity } from "../../../../db.js";
import { validateLibrarySource } from "../../shared/library-source.js";
import { pathIsInside } from "../../shared/storage-roots.js";
import { purgeCataloguedItem } from "../../shared/trash.js";
import { replaceGalleryAssetFile } from "../replace.js";
import { absorbDuplicateMetadata } from "./items.js";
import { getJob, recordAction, type JobOutcome } from "./jobs.js";
import { checkResult, type ResultCheck } from "./job-resolve.js";
import { listJobResults, type ResultFilter, type SnapshotResult } from "./job-scan.js";

export type ReplaceRefusal =
  | "stale" | "not_inbox_job" | "no_such_member" | "member_not_incoming" | "no_keeper" | "replace_failed";

export interface ReplaceOutcome {
  resultId: string;
  memberId: string;
  /** The library's item, which now carries the incoming file. */
  keeperItemId: string;
  /** The Inbox item that was retired. */
  replacedItemId: string;
  /** Where the library's previous file was set aside. */
  keptAt: string;
}

export type ReplaceResult =
  | JobOutcome<ReplaceOutcome>
  | { ok: false; refused: ReplaceRefusal; detail?: string; check?: ResultCheck };

interface MemberRow {
  id: string;
  item_id: string | null;
  library_id: string;
  path: string;
  size_snapshot: number | null;
  role: string;
  status: string;
  keeper_member_id: string | null;
}

const memberRow = (resultId: string, memberId: string): MemberRow | undefined =>
  db.prepare(`
    SELECT id, item_id, library_id, path, size_snapshot, role, status, keeper_member_id
    FROM duplicate_job_result_members WHERE id = ? AND result_id = ?
  `).get(memberId, resultId) as MemberRow | undefined;

/** Put the Inbox's copy in the library's place. All-or-nothing on the re-check,
 *  like a delete: if the set moved since the scan, nothing is touched. */
export async function replaceWithInboxCopy(
  jobId: string,
  userId: string,
  resultId: string,
  memberId: string
): Promise<ReplaceResult> {
  const job = getJob(jobId);
  if (!job) return { ok: false, refused: "not_found" };
  if (job.ownerUserId !== userId) return { ok: false, refused: "not_owner" };
  if (job.status !== "review" && job.status !== "paused" && job.status !== "processing") {
    return { ok: false, refused: "not_reviewable", detail: job.status };
  }
  if (job.duplicateType !== "inbox" || !job.inboxLibraryId) return { ok: false, refused: "not_inbox_job" };

  const check = checkResult(jobId, resultId);
  if (!check) return { ok: false, refused: "not_found" };
  if (!check.ok) return { ok: false, refused: "stale", check };

  const member = memberRow(resultId, memberId);
  if (!member) return { ok: false, refused: "no_such_member" };
  if (member.library_id !== job.inboxLibraryId || member.role !== "delete" || member.status === "deleted" || !member.item_id) {
    return { ok: false, refused: "member_not_incoming" };
  }
  const keeper = member.keeper_member_id ? memberRow(resultId, member.keeper_member_id) : undefined;
  if (!keeper?.item_id) return { ok: false, refused: "no_keeper" };

  const incoming = db.prepare(`
    SELECT li.folder_path, lib.source_path
    FROM library_items li JOIN libraries lib ON lib.id = li.library_id
    WHERE li.id = ? AND li.deleted_at IS NULL
  `).get(member.item_id) as { folder_path: string; source_path: string } | undefined;
  if (!incoming) return { ok: false, refused: "member_not_incoming" };
  let root: string;
  try { root = validateLibrarySource(incoming.source_path); } catch (err) {
    return { ok: false, refused: "replace_failed", detail: err instanceof Error ? err.message : "Inbox folder unavailable." };
  }
  const incomingAbs = path.resolve(root, ...incoming.folder_path.split("/"));
  if (!pathIsInside(incomingAbs, root) || !fs.existsSync(incomingAbs)) {
    return { ok: false, refused: "replace_failed", detail: "The Inbox file is missing on disk." };
  }

  // Hand-filed work moves first, so nothing a person did on the incoming copy is
  // lost with its row. Faces stay put: the pixels differ, and boxes are drawn on
  // the frame they were found in.
  absorbDuplicateMetadata(keeper.item_id, [member.item_id], { moveFaces: false });

  const replaced = await replaceGalleryAssetFile(keeper.item_id, {
    tmpPath: incomingAbs,
    filename: path.basename(incomingAbs)
  });
  if (!replaced.ok) return { ok: false, refused: "replace_failed", detail: replaced.error };

  // The incoming file is the library's now; its Inbox row describes nothing.
  purgeCataloguedItem(member.item_id);

  db.prepare(`
    UPDATE duplicate_job_result_members
    SET status = 'deleted', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
  `).run(member.id);
  const remaining = (db.prepare(`
    SELECT COUNT(*) AS n FROM duplicate_job_result_members
    WHERE result_id = ? AND role = 'delete' AND status NOT IN ('deleted', 'skipped')
  `).get(resultId) as { n: number }).n;
  db.prepare(`
    UPDATE duplicate_job_results
    SET status = CASE WHEN ? = 0 THEN 'resolved' ELSE status END,
        review_status = CASE WHEN ? = 0 THEN 'reviewed' ELSE review_status END,
        reclaimable_bytes = MAX(reclaimable_bytes - ?, 0),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(remaining, remaining, member.size_snapshot ?? 0, resultId);

  recordAction({
    jobId, userId, action: "result.replaced", targetType: "result", targetId: resultId,
    details: `${member.path} replaced the library's copy.`
  });
  logActivity({
    event: "library.gallery.inbox_replaced",
    actorUserId: userId,
    targetType: "book",
    targetId: keeper.item_id,
    detail: `Photo Inbox check: the incoming copy "${path.basename(member.path)}" replaced the library's file; the old file was set aside.`,
    ipAddress: null
  });

  return {
    ok: true,
    job: { resultId, memberId: member.id, keeperItemId: keeper.item_id, replacedItemId: member.item_id, keptAt: replaced.keptAt }
  };
}

export interface ReplaceSweepOutcome {
  /** Sets looked at. */
  results: number;
  replaced: number;
  /** Sets where the incoming copy was not larger, or had moved. */
  skipped: number;
  failed: number;
}

/** The incoming copies that beat the library's on pixels, in both dimensions. A
 *  set with several incoming copies takes the largest one; the rest stay for the
 *  card. Exact sets never qualify — same bytes, same pixels. */
function largerIncoming(result: SnapshotResult, inboxLibraryId: string): SnapshotResult["members"][number] | null {
  if (result.status !== "active") return null;
  const incoming = result.members.filter((member) =>
    member.libraryId === inboxLibraryId && member.role === "delete" && member.status !== "deleted"
    && member.width && member.height && member.keeperMemberId);
  let best: SnapshotResult["members"][number] | null = null;
  for (const member of incoming) {
    const keeper = result.members.find((row) => row.id === member.keeperMemberId);
    if (!keeper?.width || !keeper.height) continue;
    if (member.width! <= keeper.width || member.height! <= keeper.height) continue;
    if (!best || member.width! * member.height! > best.width! * best.height!) best = member;
  }
  return best;
}

/** "Replace all where the new copy is larger": every set on screen whose incoming
 *  copy has more pixels in both directions. Per result, like a sweep — a stale set
 *  is skipped, the rest go ahead. */
export async function replaceLargerSweep(
  jobId: string,
  userId: string,
  filter: ResultFilter = {}
): Promise<JobOutcome<ReplaceSweepOutcome> | { ok: false; refused: ReplaceRefusal }> {
  const job = getJob(jobId);
  if (!job) return { ok: false, refused: "not_found" };
  if (job.ownerUserId !== userId) return { ok: false, refused: "not_owner" };
  if (job.duplicateType !== "inbox" || !job.inboxLibraryId) return { ok: false, refused: "not_inbox_job" };

  const totals: ReplaceSweepOutcome = { results: 0, replaced: 0, skipped: 0, failed: 0 };
  const page = 200;
  const candidates: { resultId: string; memberId: string }[] = [];
  for (let offset = 0; ; offset += page) {
    const results = listJobResults(jobId, page, offset, { ...filter, type: "photo_set" });
    for (const result of results) {
      totals.results += 1;
      const member = largerIncoming(result, job.inboxLibraryId);
      if (member) candidates.push({ resultId: result.id, memberId: member.id });
      else totals.skipped += 1;
    }
    if (results.length < page) break;
  }
  for (const candidate of candidates) {
    const outcome = await replaceWithInboxCopy(jobId, userId, candidate.resultId, candidate.memberId);
    if (outcome.ok) totals.replaced += 1;
    else if (outcome.refused === "stale") totals.skipped += 1;
    else totals.failed += 1;
  }

  recordAction({
    jobId, userId, action: "results.replaced_larger",
    status: totals.failed > 0 ? "partial" : "ok",
    details: `${totals.replaced} library copies replaced by larger incoming ones`
      + (totals.skipped > 0 ? `, ${totals.skipped} sets left alone` : "")
      + (totals.failed > 0 ? `, ${totals.failed} refused` : "") + "."
  });
  return { ok: true, job: totals };
}
