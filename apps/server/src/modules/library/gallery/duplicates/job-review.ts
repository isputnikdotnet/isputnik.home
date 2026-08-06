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
