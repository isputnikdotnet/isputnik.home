// Replace — the Photo Inbox check's own verb (docs/photo-inbox-proposal.md,
// decision 7). A set found by the check asks "is the new scan better than what the
// library has?", and when it is, the answer is not "delete the old one and keep
// the new": that makes a NEW item and leaves every album, story, tag and face
// pointing at a photo that no longer exists. Replace hands the incoming file to
// the library's item through replaceGalleryAssetFile, which keeps the item and
// parks the old file beside the Recycle Bin, then retires the Inbox's row — its
// file is now the library's.
//
// A scan that came in with its BACK (docs/back-sides-proposal.md) brings the back
// along: the file moves beside the keeper's new front under the keeper library's
// own naming, the keeper's previous back is set aside like its front was, and the
// back's turn and "written on the back" come across. Left behind, the back file
// would be an orphan in the Inbox folder that the next Inbox scan catalogues as a
// photo of its own.
import fs from "node:fs";
import path from "node:path";
import { db, logActivity } from "../../../../db.js";
import { validateLibrarySource } from "../../shared/library-source.js";
import { normalizeLibrarySettings } from "../../shared/library-settings.js";
import { normaliseRelativePath, pathIsInside } from "../../shared/storage-roots.js";
import { purgeCataloguedItem } from "../../shared/trash.js";
import { backFileNameFor, backRuleOf } from "../back-sides.js";
import { setBackRotation } from "../back-side-files.js";
import { uniqueGalleryFileName } from "../files.js";
import { replaceGalleryAssetFile, setAsideReplaced } from "../replace.js";
import { setBackSide } from "../scanner.js";
import { absorbDuplicateMetadata } from "./absorb.js";
import { getJob, recordAction, type JobOutcome } from "./jobs.js";
import { checkResult, type ResultCheck } from "./job-resolve.js";
import { listJobResults, type ResultFilter, type SnapshotResult } from "./job-results.js";
import type { DuplicateJobResultMemberRow, GalleryDetailRow, LibraryItemRow, LibraryRow } from "../../../../db/rows.js";

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
  /** The keeper's back side after the swap: the incoming scan's back, moved
   *  beside the new front, or null when the scan had none (or it could not be
   *  carried — then the Inbox folder still has it, and the action's detail says). */
  backRelativePath: string | null;
}

export type ReplaceResult =
  | JobOutcome<ReplaceOutcome>
  | { ok: false; refused: ReplaceRefusal; detail?: string; check?: ResultCheck };

type MemberRow = Pick<DuplicateJobResultMemberRow,
  "id" | "item_id" | "library_id" | "path" | "size_snapshot" | "role" | "status" | "keeper_member_id">;

const memberRow = (resultId: string, memberId: string): MemberRow | undefined =>
  db.prepare(`
    SELECT id, item_id, library_id, path, size_snapshot, role, status, keeper_member_id
    FROM duplicate_job_result_members WHERE id = ? AND result_id = ?
  `).get(memberId, resultId) as MemberRow | undefined;

type IncomingRow = Pick<LibraryItemRow, "folder_path"> & Pick<LibraryRow, "source_path">
  & Pick<GalleryDetailRow, "back_relative_path" | "back_rotation" | "back_text">;

type KeeperBackRow = Pick<LibraryItemRow, "library_id">
  & Pick<LibraryRow, "source_path" | "settings_json">
  & Pick<GalleryDetailRow, "back_relative_path">;

type CarryOutcome = { carried: true; relativePath: string } | { carried: false; reason: string };

/** Move the incoming scan's back beside the keeper's new front and record it there,
 *  the way "Add the back" does by hand (back-side-files.ts): the keeper's old back
 *  set aside first, the file named under the keeper library's rule, the row told.
 *  Never throws — the front is already the library's by now, so a back that cannot
 *  follow is reported, not fatal. */
async function carryBackSide(
  inboxRoot: string,
  incoming: IncomingRow,
  keeperItemId: string,
  keeperRelativePath: string
): Promise<CarryOutcome> {
  const incomingBackAbs = path.resolve(inboxRoot, ...incoming.back_relative_path!.split("/"));
  if (!pathIsInside(incomingBackAbs, inboxRoot) || !fs.existsSync(incomingBackAbs)) {
    return { carried: false, reason: "its back file is missing from the Inbox folder" };
  }
  const keeper = db.prepare(`
    SELECT li.library_id, lib.source_path, lib.settings_json, gd.back_relative_path
    FROM gallery_details gd
    JOIN library_items li ON li.id = gd.item_id
    JOIN libraries lib ON lib.id = li.library_id
    WHERE gd.item_id = ?
  `).get(keeperItemId) as KeeperBackRow | undefined;
  if (!keeper) return { carried: false, reason: "the library's photo could not be read back" };
  let keeperRoot: string;
  try { keeperRoot = validateLibrarySource(keeper.source_path); } catch (err) {
    return { carried: false, reason: err instanceof Error ? err.message : "the library folder is unavailable" };
  }

  // The keeper's own back, if it had one, goes the way its front just went.
  if (keeper.back_relative_path) {
    const oldAbs = path.resolve(keeperRoot, ...keeper.back_relative_path.split("/"));
    if (pathIsInside(oldAbs, keeperRoot) && fs.existsSync(oldAbs)) {
      const aside = setAsideReplaced(keeperRoot, keeper.library_id, keeperItemId, oldAbs);
      if (!aside.ok) return { carried: false, reason: aside.error };
    }
  }

  const frontAbs = path.resolve(keeperRoot, ...keeperRelativePath.split("/"));
  const dir = path.dirname(frontAbs);
  const rule = backRuleOf(normalizeLibrarySettings("gallery", keeper.settings_json).back_sides);
  const wanted = backFileNameFor(path.basename(keeperRelativePath), rule, path.extname(incomingBackAbs));
  const finalName = uniqueGalleryFileName(dir, wanted);
  if (!finalName) return { carried: false, reason: "no file name could be made for the back" };
  const finalAbs = path.join(dir, finalName);
  if (!pathIsInside(finalAbs, keeperRoot)) return { carried: false, reason: "the back's name can't be stored in the library" };
  try {
    fs.renameSync(incomingBackAbs, finalAbs);
  } catch (err) {
    return { carried: false, reason: err instanceof Error ? err.message : "the back file could not be moved" };
  }

  const relativePath = normaliseRelativePath(path.relative(keeperRoot, finalAbs));
  const recorded = await setBackSide(keeper.library_id, keeperItemId, relativePath);
  if (!recorded) return { carried: false, reason: "the back file could not be read as a photo" };

  // The turn is the back's own, and the words were written on this very print:
  // both belong with the file, whichever row describes it. A back that cannot be
  // rendered keeps its turn on record all the same.
  const rotation = ((Math.round((incoming.back_rotation ?? 0) / 90) * 90) % 360 + 360) % 360;
  if (rotation !== 0) {
    const turned = await setBackRotation(keeperItemId, rotation);
    if (!turned.ok) db.prepare("UPDATE gallery_details SET back_rotation = ? WHERE item_id = ?").run(rotation, keeperItemId);
  }
  if (incoming.back_text) {
    db.prepare("UPDATE gallery_details SET back_text = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE item_id = ?")
      .run(incoming.back_text, keeperItemId);
  }
  return { carried: true, relativePath };
}

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
    SELECT li.folder_path, lib.source_path, gd.back_relative_path, gd.back_rotation, gd.back_text
    FROM library_items li
    JOIN libraries lib ON lib.id = li.library_id
    LEFT JOIN gallery_details gd ON gd.item_id = li.id
    WHERE li.id = ? AND li.deleted_at IS NULL
  `).get(member.item_id) as IncomingRow | undefined;
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

  // The scan's back follows its front — before the Inbox row goes, since the row
  // is the only thing that says which file the back is.
  const back: CarryOutcome | null = incoming.back_relative_path
    ? await carryBackSide(root, incoming, keeper.item_id, replaced.relativePath)
    : null;

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

  const backNote = !back ? ""
    : back.carried ? " Its back side came with it."
    : ` Its back side stayed in the Inbox: ${back.reason}.`;
  recordAction({
    jobId, userId, action: "result.replaced", targetType: "result", targetId: resultId,
    status: back && !back.carried ? "partial" : "ok",
    details: `${member.path} replaced the library's copy.${backNote}`
  });
  logActivity({
    event: "library.gallery.inbox_replaced",
    actorUserId: userId,
    targetType: "book",
    targetId: keeper.item_id,
    detail: `Photo Inbox check: the incoming copy "${path.basename(member.path)}" replaced the library's file; the old file was set aside.${backNote}`,
    ipAddress: null
  });

  return {
    ok: true,
    job: {
      resultId, memberId: member.id, keeperItemId: keeper.item_id, replacedItemId: member.item_id, keptAt: replaced.keptAt,
      backRelativePath: back?.carried ? back.relativePath : null
    }
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
