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
import { createJob, getJob } from "../src/modules/library/gallery/duplicates/jobs.js";
import {
  runJobScan, listJobResults, sweepPreview
} from "../src/modules/library/gallery/duplicates/job-scan.js";
import {
  checkResult, resolveJobResult, sweepJobResults
} from "../src/modules/library/gallery/duplicates/job-resolve.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

// Fingerprints as bit patterns: bits(0) and bits(3) are two bits apart, inside the
// near window. NULL by default, which keeps a photo out of that tier entirely.
const bits = (n: number): string => n.toString(16).padStart(16, "0");

function asset(
  id: string, relativePath: string, hash: string, library = "GAL", phash: string | null = null
): string {
  db.prepare(`
    INSERT INTO library_items (id, library_id, type, folder_path, status, discovered_at)
    VALUES (?, ?, 'gallery', ?, 'ready', '2024-01-01T00:00:00.000Z')
  `).run(id, library, relativePath);
  db.prepare(`
    INSERT INTO gallery_details (item_id, kind, relative_path, size, content_hash, content_hash_at, modified_at, phash)
    VALUES (?, 'photo', ?, 1000, ?, 'm1', 'mtime-1', ?)
  `).run(id, relativePath, hash, phash);
  return id;
}

// A cleanup is folders OR files, never both, so each test says which kind of work it exercises.
const startJob = (libraries = ["GAL"], duplicateType: "folders" | "files" = "files") => {
  const created = createJob({ ownerUserId: "u1", libraryIds: libraries, duplicateType });
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
  // One card per destination, so losing a destination stops THAT card and leaves
  // the others alone — which is the point of splitting them. Each card is a
  // self-contained promise about the photos it names.
  it("stops only the card whose destination has gone", () => {
    asset("t1", "test/one.jpg", "pic-1");
    asset("t2", "test/two.jpg", "pic-2");
    asset("f1", "One/one.jpg", "pic-1");
    asset("f2", "Two/two.jpg", "pic-2");
    const jobId = startJob(["GAL"], "folders");
    const cards = listJobResults(jobId).filter((result) => result.type === "contained");
    expect(cards).toHaveLength(2);
    expect(cards.every((card) => checkResult(jobId, card.id)!.ok)).toBe(true);

    const viaTwo = cards.find((card) =>
      card.folders.some((folder) => folder.role !== "delete" && folder.folderPath === "Two"))!;
    const viaOne = cards.find((card) => card.id !== viaTwo.id)!;

    db.prepare("UPDATE library_items SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = 'f2'").run();

    // The card that depended on "Two" refuses, naming both the lost copy and the
    // photo that was counting on it.
    const broken = checkResult(jobId, viaTwo.id)!;
    expect(broken.ok).toBe(false);
    expect(broken.problems.map((problem) => problem.path).sort())
      .toEqual(["Two/two.jpg", "test/two.jpg"].sort());

    // The other card is untouched and still safe to carry out.
    expect(checkResult(jobId, viaOne.id)!.ok).toBe(true);
  });
});

// ── The bulk sweep ──────────────────────────────────────────────────────────
//
// Clearing sets one at a time is a lot of clicking on a job with hundreds. The rule
// that matters is what it may NOT touch: byte-identical copies are interchangeable, so
// a hundred at once loses nothing anybody could notice; near-identical ones are
// different files and each is a judgement. The older page draws the line in the same
// place, and this must keep drawing it there.

describe("sweeping a cleanup", () => {
  it("clears every byte-identical set at once", () => {
    asset("a1", "Album/one.jpg", "same");
    asset("a2", "Downloads/one.jpg", "same");
    asset("b1", "Album/two.jpg", "twin");
    asset("b2", "Downloads/two.jpg", "twin");
    const jobId = startJob();

    const outcome = sweepJobResults(jobId, "u1", {});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Both sets were worked, and neither was skipped as stale.
    expect(outcome.job.results).toBe(2);
    expect(outcome.job.skipped).toBe(0);
    // Neither is waiting to be acted on any more. Not asserted as 'resolved': the move
    // to the Recycle Bin needs a real library folder, which this suite deliberately
    // does not have — trashBook's own tests cover that half.
    expect(listJobResults(jobId).some((result) => result.status === "active")).toBe(false);
  });

  // THE safety rule. If this ever passes with a near set swept, one press has made a
  // pile of judgements nobody looked at.
  it("never touches a near-identical set", () => {
    asset("n1", "Album/one.jpg", "a", "GAL", bits(0));
    asset("n2", "Downloads/one.jpg", "b", "GAL", bits(3));
    const jobId = startJob();
    expect(listJobResults(jobId)).toHaveLength(1);

    const outcome = sweepJobResults(jobId, "u1", {});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.job.results).toBe(0);
    expect(listJobResults(jobId)[0].status).toBe("active");
  });

  it("takes the identical sets and leaves the near ones beside them", () => {
    asset("e1", "Album/one.jpg", "same", "GAL", bits(0));
    asset("e2", "Downloads/one.jpg", "same", "GAL", bits(0));
    asset("n1", "Album/two.jpg", "a", "GAL", bits(8));
    asset("n2", "Downloads/two.jpg", "b", "GAL", bits(11));
    const jobId = startJob();

    const outcome = sweepJobResults(jobId, "u1", {});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.job.results).toBe(1);

    const left = listJobResults(jobId).filter((result) => result.status === "active");
    expect(left).toHaveLength(1);
    expect(left[0].tier).toBe("near");
  });

  it("follows the filters, so it clears only what the page is showing", () => {
    asset("a1", "Album/one.jpg", "same");
    asset("a2", "Downloads/one.jpg", "same");
    asset("b1", "Album/two.jpg", "twin");
    asset("b2", "Downloads/two.jpg", "twin");
    const jobId = startJob();

    const outcome = sweepJobResults(jobId, "u1", { search: "two.jpg" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.job.results).toBe(1);
    expect(listJobResults(jobId).filter((result) => result.status === "active")).toHaveLength(1);
  });

  it("counts what it would take before taking it, near sets excluded", () => {
    asset("a1", "Album/one.jpg", "same");
    asset("a2", "Downloads/one.jpg", "same");
    asset("n1", "Album/two.jpg", "a", "GAL", bits(0));
    asset("n2", "Downloads/two.jpg", "b", "GAL", bits(3));
    const jobId = startJob();

    const preview = sweepPreview(jobId);
    expect(preview.results).toBe(1);
    expect(preview.copies).toBe(1);
    expect(preview.bytes).toBe(1000);
  });

  it("refuses someone else's cleanup", () => {
    const { jobId } = twoCopies();
    expect(sweepJobResults(jobId, "u2", {})).toMatchObject({ ok: false, refused: "not_owner" });
  });
});

// A folder cleanup is "a few decisions about a lot of photos" by design, so a sweep
// there is not a faster way to do the same work — it is one press emptying folders.
// The older folder pages have never offered one either.
describe("a folder cleanup", () => {
  const twoIdenticalFolders = () => {
    asset("a1", "Trip/one.jpg", "p1");
    asset("a2", "Trip/two.jpg", "p2");
    asset("b1", "Copy/one.jpg", "p1");
    asset("b2", "Copy/two.jpg", "p2");
    return startJob(["GAL"], "folders");
  };

  it("finds folder results but offers no sweep over them", () => {
    const jobId = twoIdenticalFolders();
    expect(listJobResults(jobId).length).toBeGreaterThan(0);
    expect(sweepPreview(jobId)).toMatchObject({ results: 0, copies: 0 });
  });

  it("sweeps nothing even when asked directly", () => {
    const jobId = twoIdenticalFolders();
    const outcome = sweepJobResults(jobId, "u1", {});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.job.results).toBe(0);
    expect(listJobResults(jobId).every((result) => result.status === "active")).toBe(true);
  });
});
