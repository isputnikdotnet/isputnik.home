// Working through a cleanup job's results: narrowing them, marking them off, and the
// two different ways of saying "not this one".
//
// ── Skip and dismiss are not the same statement ─────────────────────────────
//
//   Skip      "not in this cleanup." A note on the job's own result row. The next
//             job will offer these folders again, because nothing was decided about
//             them — only about this afternoon's work.
//   Dismiss   "these are not duplicates, stop pairing them." A standing record, the
//             same one the older pages write, honoured by every future scan and every
//             future job.
//
// They were one button on the older pages, which meant every "I'll deal with that
// later" quietly became "never show me this again". Each control here says which of
// the two it is.
import { db } from "../../../../db.js";
import { getJob, recordAction, type JobOutcome } from "./jobs.js";
import { runJobScan } from "./job-scan.js";

export type ReviewMark = "unreviewed" | "reviewed" | "skipped";

interface ResultRow {
  id: string;
  job_id: string;
  result_type: "photo_set" | "folder_set" | "contained" | "overlap";
  status: string;
}

const resultRow = (jobId: string, resultId: string): ResultRow | undefined =>
  db.prepare("SELECT id, job_id, result_type, status FROM duplicate_job_results WHERE id = ? AND job_id = ?")
    .get(resultId, jobId) as ResultRow | undefined;

/** Mark one result reviewed, skipped, or back to untouched. A note on the job; it
 *  changes nothing about the photos and no future scan reads it. */
export function markResult(
  jobId: string,
  userId: string,
  resultId: string,
  mark: ReviewMark
): JobOutcome<{ id: string; reviewStatus: ReviewMark }> {
  const job = getJob(jobId);
  if (!job) return { ok: false, refused: "not_found" };
  if (job.ownerUserId !== userId) return { ok: false, refused: "not_owner" };
  const row = resultRow(jobId, resultId);
  if (!row) return { ok: false, refused: "not_found" };

  db.prepare(`
    UPDATE duplicate_job_results
    SET review_status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(mark, resultId);
  recordAction({ jobId, userId, action: `result.${mark}`, targetType: "result", targetId: resultId });
  return { ok: true, job: { id: resultId, reviewStatus: mark } };
}

/** Why a copy's role could not be changed. Its own vocabulary rather than more entries
 *  in JobRefusal, for the same reason resolve has ResolveRefusal: these are answers
 *  about one member, and every other caller would have to handle cases it can't hit. */
export type RoleRefusal =
  | "not_a_photo_set"
  | "no_such_member"
  | "member_protected"
  | "member_gone";

interface RoleMemberRow {
  id: string;
  role: "keep" | "delete" | "protected";
  status: string;
  distance: number;
  size_snapshot: number | null;
}

/** Overrule the scan about which copies of one set survive.
 *
 *  Everything else in this file is a note ABOUT a result, and applyPreferences
 *  deliberately re-runs the scan rather than editing keepers so that one keeper
 *  implementation exists. This is a different kind of statement: not a better guess at
 *  the keeper, but a person looking at the pictures and disagreeing with the guess. It
 *  edits the snapshot in place precisely because a re-scan would compute the same
 *  answer again and throw the decision away.
 *
 *  Photo sets only. In a folder result the offer is about the FOLDER, and letting one
 *  file out of it would leave a "delete this folder" card that no longer means what it
 *  says.
 *
 *  One click moves ONE copy, and every combination is allowed: keep them all, keep two
 *  of five, or keep none. Keeping none is a real answer — a set of copies of something
 *  nobody wants — and it means the photograph leaves the library, so the card says so
 *  and the bulk sweep will not touch such a set (sweepScope). What it costs here is the
 *  survivor a doomed copy hands its tags and faces to: with nothing kept there is no
 *  such copy, the hand-over is skipped, and the files go to the Recycle Bin whole. */
export function setMemberRole(
  jobId: string,
  userId: string,
  resultId: string,
  memberId: string,
  role: "keep" | "delete"
): JobOutcome<{ id: string; role: "keep" | "delete" }> | { ok: false; refused: RoleRefusal } {
  const job = getJob(jobId);
  if (!job) return { ok: false, refused: "not_found" };
  if (job.ownerUserId !== userId) return { ok: false, refused: "not_owner" };
  if (job.status !== "review" && job.status !== "paused") {
    return { ok: false, refused: "not_reviewable", detail: job.status };
  }
  const row = resultRow(jobId, resultId);
  if (!row) return { ok: false, refused: "not_found" };
  if (row.result_type !== "photo_set") return { ok: false, refused: "not_a_photo_set" };

  // Ordered by path so "the first keeper" below is the same copy every time this runs.
  const members = db.prepare(`
    SELECT id, role, status, distance, size_snapshot
    FROM duplicate_job_result_members WHERE result_id = ? ORDER BY path
  `).all(resultId) as RoleMemberRow[];

  const target = members.find((member) => member.id === memberId);
  if (!target) return { ok: false, refused: "no_such_member" };
  // Protection is a property of the library, not a choice about this photo, so there is
  // nothing here to overrule — the copy could not be deleted whatever the card said.
  if (target.role === "protected") return { ok: false, refused: "member_protected" };
  if (target.status === "deleted") return { ok: false, refused: "member_gone" };
  if (target.role === role) return { ok: true, job: { id: memberId, role } };

  const after = members.map((member) => (member.id === memberId ? { ...member, role } : member));
  const keepers = after.filter((member) => member.role === "keep");

  // Which copy the doomed ones hand their tags, albums and people to. One of them, even
  // when several are kept: absorbing into two copies would duplicate the work, not save
  // it twice. Undefined when nothing is kept — then there is no survivor to hand
  // anything to, and the delete rows say so with a NULL rather than pointing at a copy
  // that is leaving too.
  const primary = keepers[0] as RoleMemberRow | undefined;

  // Distance is measured FROM THE KEEPER, so moving the keeper invalidates every stored
  // figure. Rather than re-fingerprint, hold the one property the delete path actually
  // reads: resolve moves face boxes only at distance 0, on the grounds that identical
  // bytes means identical pixels. A near set therefore keeps every non-keeper at 1 or
  // more, so faces are never moved onto what may be a differently-framed photograph. An
  // exact set is all zeroes and stays that way — any copy is any other copy.
  //
  // Keeping the shape (one 0, the rest >0) also preserves the tier, which listJobResults
  // derives from these same distances.
  const near = members.some((member) => member.distance > 0);

  const setRole = db.prepare(`
    UPDATE duplicate_job_result_members
    SET role = ?, keeper_member_id = ?, distance = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `);

  db.transaction(() => {
    for (const member of after) {
      const isPrimary = primary !== undefined && member.id === primary.id;
      const distance = !near ? 0 : isPrimary ? 0 : Math.max(member.distance, 1);
      setRole.run(
        member.role,
        member.role === "delete" ? primary?.id ?? null : null,
        distance,
        member.id
      );
    }
    // Recomputed from the rows rather than adjusted by the difference: the figure on the
    // card has to agree with what a resolve would actually free.
    const reclaimable = db.prepare(`
      SELECT COALESCE(SUM(size_snapshot), 0) AS bytes FROM duplicate_job_result_members
      WHERE result_id = ? AND role = 'delete' AND status NOT IN ('deleted', 'skipped')
    `).get(resultId) as { bytes: number };
    // keeper_rank 0 is the top of the evidence ladder, and rightly: every rank above it
    // is the scan inferring what somebody would want, and this IS what somebody wants.
    // With nothing kept there is no keeper to give a reason for, so the line goes
    // rather than saying "kept because" about a set that keeps nothing.
    db.prepare(`
      UPDATE duplicate_job_results
      SET reclaimable_bytes = ?, keeper_reason = ?, keeper_rank = 0,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(reclaimable.bytes, primary ? "you chose it" : null, resultId);
  })();

  recordAction({
    jobId, userId, action: `member.${role}`, targetType: "member", targetId: memberId,
    details: `${keepers.length} of ${after.length} copies kept.`
  });
  return { ok: true, job: { id: memberId, role } };
}

/** "These are not duplicates." Writes the standing records the older pages write, so
 *  the decision survives this job, every rebuild, and every future scan — then takes
 *  the result off this job's list too, since it is no longer something to decide. */
export function dismissResult(
  jobId: string,
  userId: string,
  resultId: string
): JobOutcome<{ id: string }> {
  const job = getJob(jobId);
  if (!job) return { ok: false, refused: "not_found" };
  if (job.ownerUserId !== userId) return { ok: false, refused: "not_owner" };
  const row = resultRow(jobId, resultId);
  if (!row) return { ok: false, refused: "not_found" };

  const folders = db.prepare(
    "SELECT library_id, folder_path, role FROM duplicate_job_result_folders WHERE result_id = ?"
  ).all(resultId) as { library_id: string; folder_path: string; role: string }[];
  const members = db.prepare(
    "SELECT item_id, role FROM duplicate_job_result_members WHERE result_id = ? AND item_id IS NOT NULL"
  ).all(resultId) as { item_id: string; role: string }[];

  db.transaction(() => {
    if (row.result_type === "photo_set") {
      // Stored as EDGES between copies, not against a group id — the same reason the
      // older tier does it: a rebuild that regroups the set must not lose the
      // decision. Every pair in the set is dismissed, so no two of them link again.
      const ids = members.map((member) => member.item_id).sort();
      const add = db.prepare(
        "INSERT INTO gallery_duplicate_ignores (item_a, item_b) VALUES (?, ?) ON CONFLICT DO NOTHING"
      );
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) add.run(ids[i], ids[j]);
      }
    } else if (row.result_type === "contained") {
      // Read by FOLDER, not by folder-and-target: "leave this one alone" is a
      // statement about the folder, and matching on the pair would bring it straight
      // back under whichever folder covers it next.
      const doomed = folders.find((folder) => folder.role === "delete");
      const target = folders.find((folder) => folder.role !== "delete");
      if (doomed) {
        db.prepare(`
          INSERT INTO gallery_duplicate_contained_ignores
            (library_id, folder_path, target_library_id, target_folder_path)
          VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING
        `).run(
          doomed.library_id, doomed.folder_path,
          target?.library_id ?? doomed.library_id, target?.folder_path ?? ""
        );
      }
    } else {
      // Folder sets and overlaps are dismissed as PAIRS, lexically smaller side
      // first so a pair has exactly one row however it is discovered next time.
      const keys = folders
        .map((folder) => ({ libraryId: folder.library_id, folderPath: folder.folder_path }))
        .sort((a, b) => (`${a.libraryId}${a.folderPath}` < `${b.libraryId}${b.folderPath}` ? -1 : 1));
      const table = row.result_type === "overlap"
        ? "gallery_duplicate_folder_overlap_ignores"
        : "gallery_duplicate_folder_ignores";
      const add = db.prepare(`
        INSERT INTO ${table} (library_a, path_a, library_b, path_b)
        VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING
      `);
      for (let i = 0; i < keys.length; i += 1) {
        for (let j = i + 1; j < keys.length; j += 1) {
          add.run(keys[i].libraryId, keys[i].folderPath, keys[j].libraryId, keys[j].folderPath);
        }
      }
    }

    db.prepare("DELETE FROM duplicate_job_results WHERE id = ?").run(resultId);
  })();

  recordAction({ jobId, userId, action: "result.dismissed", targetType: "result", targetId: resultId });
  return { ok: true, job: { id: resultId } };
}

/** Apply the job's folder instructions to what it found.
 *
 *  This RE-RUNS the snapshot rather than editing keepers in place. Deliberately: a
 *  "keep" can change which copy survives, and it can also remove an offer outright
 *  (a folder you keep photos in is never proposed for clearing), so patching the
 *  existing rows would mean a second keeper implementation that can drift from the
 *  first — which is the exact class of bug this redesign exists to end.
 *
 *  Review marks are lost, and that is honest: they were made about a different
 *  proposal. The scan reads no files, so this costs a second or two. */
export function applyPreferences(jobId: string, userId: string): JobOutcome<{ id: string }> {
  const job = getJob(jobId);
  if (!job) return { ok: false, refused: "not_found" };
  if (job.ownerUserId !== userId) return { ok: false, refused: "not_owner" };
  if (job.status !== "review" && job.status !== "paused") {
    return { ok: false, refused: "not_reviewable", detail: job.status };
  }
  const rescan = runJobScan(jobId, userId);
  return rescan.ok ? { ok: true, job: { id: jobId } } : rescan;
}
