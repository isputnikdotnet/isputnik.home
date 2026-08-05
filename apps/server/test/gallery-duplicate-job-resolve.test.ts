// Carrying out a cleanup job's offers — and, mostly, refusing to.
//
// A snapshot is meant to be come back to, so by the time anyone presses Delete the
// library may have moved on. Everything here is about noticing that: a photo gone, a
// file re-saved, a library turned read-only, or the surviving copy itself no longer
// where it was promised to be.
//
// The move to the Recycle Bin is trashBook's own suite (it needs a real library
// folder on disk). What matters here is what happens BEFORE it: the re-check, and
// the hand-filed work reaching the copy that survives.
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { createJob, getJob } from "../src/modules/library/gallery/duplicate-jobs.js";
import { runJobScan, listJobResults } from "../src/modules/library/gallery/duplicate-job-scan.js";
import { checkResult, resolveJobResult } from "../src/modules/library/gallery/duplicate-job-resolve.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

function asset(id: string, relativePath: string, hash: string, library = "GAL"): string {
  db.prepare(`
    INSERT INTO library_items (id, library_id, type, folder_path, status, discovered_at)
    VALUES (?, ?, 'gallery', ?, 'ready', '2024-01-01T00:00:00.000Z')
  `).run(id, library, relativePath);
  db.prepare(`
    INSERT INTO gallery_details (item_id, kind, relative_path, size, content_hash, content_hash_at, modified_at)
    VALUES (?, 'photo', ?, 1000, ?, 'm1', 'mtime-1')
  `).run(id, relativePath, hash);
  return id;
}

const startJob = (libraries = ["GAL"]) => {
  const created = createJob({ ownerUserId: "u1", libraryIds: libraries });
  if (!created.ok) throw new Error(`job refused: ${created.refused}`);
  const done = runJobScan(created.job.id, "u1");
  if (!done.ok) throw new Error(`scan refused: ${done.refused}`);
  return created.job.id;
};

/** A simple photo set: one copy in Album, one in Downloads. Album keeps. */
const twoCopies = () => {
  asset("a1", "Album/one.jpg", "same");
  asset("a2", "Downloads/one.jpg", "same");
  const jobId = startJob();
  const result = listJobResults(jobId)[0];
  return { jobId, result };
};

beforeEach(() => {
  resetDb();
  makeUser("u1", "admin");
  makeUser("u2", "admin");
  makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
});

describe("the re-check", () => {
  it("passes while nothing has changed", () => {
    const { jobId, result } = twoCopies();
    const check = checkResult(jobId, result.id)!;
    expect(check.ok).toBe(true);
    expect(check.problems).toEqual([]);
  });

  it("notices a photo that has gone since the scan", () => {
    const { jobId, result } = twoCopies();
    db.prepare("UPDATE library_items SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = 'a2'").run();

    const check = checkResult(jobId, result.id)!;
    expect(check.ok).toBe(false);
    expect(check.problems.map((problem) => [problem.path, problem.stale])).toEqual([
      ["Downloads/one.jpg", "missing"]
    ]);
  });

  it("notices a file re-saved at the same size", () => {
    const { jobId, result } = twoCopies();
    // An editor that rewrites the file keeps the byte count and changes the rest.
    db.prepare("UPDATE gallery_details SET content_hash = 'different' WHERE item_id = 'a2'").run();

    const check = checkResult(jobId, result.id)!;
    expect(check.ok).toBe(false);
    expect(check.problems[0]).toMatchObject({ path: "Downloads/one.jpg", stale: "modified" });
  });

  it("notices a changed modification time on its own", () => {
    const { jobId, result } = twoCopies();
    db.prepare("UPDATE gallery_details SET modified_at = 'mtime-2' WHERE item_id = 'a2'").run();
    expect(checkResult(jobId, result.id)!.problems[0]).toMatchObject({ stale: "modified" });
  });

  // The dangerous one: my file is fine, but the copy it was promised to hand its tags
  // to is not. Deleting on that basis bins the last copy.
  it("refuses when the SURVIVING copy has gone", () => {
    const { jobId, result } = twoCopies();
    db.prepare("UPDATE library_items SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = 'a1'").run();

    const check = checkResult(jobId, result.id)!;
    expect(check.ok).toBe(false);
    // Both rows are flagged: the keeper because it is gone, the copy because what it
    // depended on is gone.
    expect(check.problems.map((problem) => problem.path).sort())
      .toEqual(["Album/one.jpg", "Downloads/one.jpg"]);
  });

  it("notices a library that has been turned read-only", () => {
    const { jobId, result } = twoCopies();
    db.prepare(`UPDATE libraries SET policy_json = '{"mode":"external"}' WHERE id = 'GAL'`).run();

    const check = checkResult(jobId, result.id)!;
    expect(check.ok).toBe(false);
    // Only the copy being REMOVED is a problem — a keeper in a read-only library is
    // exactly what should happen.
    expect(check.problems.map((problem) => problem.role)).toEqual(["delete"]);
  });

  it("writes the reason onto the member, so the page can say which row is stale", () => {
    const { jobId, result } = twoCopies();
    db.prepare("UPDATE gallery_details SET content_hash = 'different' WHERE item_id = 'a2'").run();
    checkResult(jobId, result.id);

    const rows = db.prepare(
      "SELECT path, status FROM duplicate_job_result_members WHERE result_id = ? ORDER BY path"
    ).all(result.id);
    expect(rows).toEqual([
      { path: "Album/one.jpg", status: "pending" },
      { path: "Downloads/one.jpg", status: "modified" }
    ]);
  });
});

describe("deleting", () => {
  it("removes nothing at all when one photo has moved on", () => {
    const { jobId, result } = twoCopies();
    db.prepare("UPDATE gallery_details SET content_hash = 'different' WHERE item_id = 'a2'").run();

    const outcome = resolveJobResult(jobId, "u1", result.id);
    expect(outcome).toMatchObject({ ok: false, refused: "stale" });
    // Nothing went to the bin, and the set is still whole.
    expect(db.prepare("SELECT COUNT(*) AS n FROM library_items WHERE deleted_at IS NULL").get())
      .toEqual({ n: 2 });
    expect(listJobResults(jobId)[0].status).toBe("error");
  });

  // The handover has to happen before the file goes, or the work is lost with it.
  it("hands the doomed copy's tags to the copy that survives it", () => {
    const { jobId, result } = twoCopies();
    db.prepare("INSERT INTO tags (id, key, display_name) VALUES ('t1', 'trips', 'Trips')").run();
    db.prepare("INSERT INTO taggables (tag_id, entity_type, entity_id) VALUES ('t1', 'library_item', 'a2')").run();

    resolveJobResult(jobId, "u1", result.id);

    const tagged = db.prepare(
      "SELECT entity_id FROM taggables WHERE tag_id = 't1' ORDER BY entity_id"
    ).all() as { entity_id: string }[];
    expect(tagged.map((row) => row.entity_id)).toContain("a1");
  });

  it("accounts for every doomed photo — deleted or refused, never silently skipped", () => {
    const { jobId, result } = twoCopies();
    const outcome = resolveJobResult(jobId, "u1", result.id);
    if (!outcome.ok) throw new Error("expected the resolve to run");
    // trashBook needs a real library folder, so in here every one of them reports
    // why it could not go rather than disappearing from the tally.
    expect(outcome.job.deletedItemIds.length + outcome.job.failed.length).toBe(1);
  });

  it("records a refusal against the job rather than losing it", () => {
    const { jobId, result } = twoCopies();
    const outcome = resolveJobResult(jobId, "u1", result.id);
    if (!outcome.ok) throw new Error("expected the resolve to run");
    if (outcome.job.failed.length === 0) return; // a real filesystem would succeed

    expect(db.prepare("SELECT COUNT(*) AS n FROM duplicate_job_errors WHERE job_id = ?").get(jobId))
      .toEqual({ n: 1 });
    // Left in error, not reported as a clean sweep.
    expect(listJobResults(jobId)[0].status).toBe("error");
    expect(getJob(jobId)!.totals.errors).toBe(1);
  });

  it("is only for the owner", () => {
    const { jobId, result } = twoCopies();
    expect(resolveJobResult(jobId, "u2", result.id)).toMatchObject({ ok: false, refused: "not_owner" });
  });

  it("is refused once the job is finished", () => {
    const { jobId, result } = twoCopies();
    db.prepare("UPDATE duplicate_jobs SET status = 'completed' WHERE id = ?").run(jobId);
    expect(resolveJobResult(jobId, "u1", result.id)).toMatchObject({ ok: false, refused: "not_reviewable" });
  });

  it("refuses a result whose copies are all in a read-only library", () => {
    const { jobId, result } = twoCopies();
    db.prepare(`UPDATE libraries SET policy_json = '{"mode":"external"}' WHERE id = 'GAL'`).run();
    expect(resolveJobResult(jobId, "u1", result.id)).toMatchObject({ ok: false, refused: "stale" });
  });
});

describe("a contained folder", () => {
  it("checks every copy AND every folder the copies survive in", () => {
    asset("t1", "test/one.jpg", "pic-1");
    asset("t2", "test/two.jpg", "pic-2");
    asset("f1", "One/one.jpg", "pic-1");
    asset("f2", "Two/two.jpg", "pic-2");
    const jobId = startJob();
    const contained = listJobResults(jobId).find((result) => result.type === "contained")!;

    expect(checkResult(jobId, contained.id)!.ok).toBe(true);

    // Lose one of the two folders the copies live in, and the whole offer stops —
    // even though the other folder is untouched.
    db.prepare("UPDATE library_items SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = 'f2'").run();
    const check = checkResult(jobId, contained.id)!;
    expect(check.ok).toBe(false);
    expect(check.problems.map((problem) => problem.path).sort())
      .toEqual(["test/two.jpg", "Two/two.jpg"].sort());
    // And the copy whose counterpart is fine is NOT flagged.
    expect(check.problems.some((problem) => problem.path === "test/one.jpg")).toBe(false);
  });
});
