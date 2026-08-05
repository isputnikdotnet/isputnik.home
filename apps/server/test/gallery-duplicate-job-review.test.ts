// Working a cleanup job's results: narrowing them, marking them off, and the two
// different ways of saying "not this one" — a note on this job, or a standing record
// every future scan honours.
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { createJob, getJob, setJobFolderPreferences } from "../src/modules/library/gallery/duplicate-jobs.js";
import {
  runJobScan, listJobResults, countJobResults, keeperFoldersOf
} from "../src/modules/library/gallery/duplicate-job-scan.js";
import {
  applyPreferences, dismissResult, markResult
} from "../src/modules/library/gallery/duplicate-job-review.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

function asset(id: string, relativePath: string, hash: string, library = "GAL"): string {
  db.prepare(`
    INSERT INTO library_items (id, library_id, type, folder_path, status, discovered_at)
    VALUES (?, ?, 'gallery', ?, 'ready', '2024-01-01T00:00:00.000Z')
  `).run(id, library, relativePath);
  db.prepare(`
    INSERT INTO gallery_details (item_id, kind, relative_path, size, content_hash, content_hash_at, modified_at)
    VALUES (?, 'photo', ?, 1000, ?, 'm1', 'm1')
  `).run(id, relativePath, hash);
  return id;
}

// A cleanup is folders OR files, never both, so each test says which kind of work it exercises.
const startJob = (libraries = ["GAL"], duplicateType: "folders" | "files" = "folders") => {
  const created = createJob({ ownerUserId: "u1", libraryIds: libraries, duplicateType });
  if (!created.ok) throw new Error(`job refused: ${created.refused}`);
  const done = runJobScan(created.job.id, "u1");
  if (!done.ok) throw new Error(`scan refused: ${done.refused}`);
  return created.job.id;
};

beforeEach(() => {
  resetDb();
  makeUser("u1", "admin");
  makeUser("u2", "admin");
  makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
  makeLibrary("GAL2", { createdBy: "u1", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
  grant("group", EVERYONE_GROUP_ID, "GAL2", "member");
});

describe("marking a result", () => {
  it("records the mark without touching a photo", () => {
    asset("a1", "Album/one.jpg", "same");
    asset("a2", "Copies/one.jpg", "same");
    const jobId = startJob(["GAL"], "files");
    const result = listJobResults(jobId)[0];

    expect(markResult(jobId, "u1", result.id, "skipped").ok).toBe(true);
    expect(listJobResults(jobId)[0].reviewStatus).toBe("skipped");
    // Still there, still countable — skipping is "not today", not "gone".
    expect(countJobResults(jobId)).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM library_items").get()).toEqual({ n: 2 });

    expect(markResult(jobId, "u1", result.id, "reviewed").ok).toBe(true);
    expect(listJobResults(jobId)[0].reviewStatus).toBe("reviewed");
  });

  it("is only for the owner", () => {
    asset("a1", "Album/one.jpg", "same");
    asset("a2", "Copies/one.jpg", "same");
    const jobId = startJob(["GAL"], "files");
    const result = listJobResults(jobId)[0];
    expect(markResult(jobId, "u2", result.id, "skipped")).toMatchObject({ ok: false, refused: "not_owner" });
  });

  it("counts towards the job's totals", () => {
    asset("a1", "Album/one.jpg", "same");
    asset("a2", "Copies/one.jpg", "same");
    const jobId = startJob(["GAL"], "files");
    markResult(jobId, "u1", listJobResults(jobId)[0].id, "reviewed");
    expect(getJob(jobId)!.totals.reviewed).toBe(1);
  });
});

// Skipping is a note on the job. Dismissing is a decision about the photos, and it
// outlives the job — the distinction the older pages' single button lost.
describe("dismissing a result", () => {
  it("takes a photo set off the list and stops it being found again", () => {
    asset("a1", "Album/one.jpg", "same");
    asset("a2", "Copies/one.jpg", "same");
    const jobId = startJob(["GAL"], "files");
    const result = listJobResults(jobId)[0];

    expect(dismissResult(jobId, "u1", result.id).ok).toBe(true);
    expect(listJobResults(jobId)).toHaveLength(0);
    // The standing record the older pages read, written as an edge between the two
    // copies so a regrouping can't lose it.
    const ignores = db.prepare("SELECT item_a, item_b FROM gallery_duplicate_ignores").all();
    expect(ignores).toEqual([{ item_a: "a1", item_b: "a2" }]);
    // And nothing was deleted.
    expect(db.prepare("SELECT COUNT(*) AS n FROM library_items").get()).toEqual({ n: 2 });
  });

  it("records a contained folder by the folder, not by the pair", () => {
    asset("t1", "test/one.jpg", "pic-1");
    asset("t2", "test/two.jpg", "pic-2");
    asset("f1", "One/one.jpg", "pic-1");
    asset("f2", "Two/two.jpg", "pic-2");
    const jobId = startJob();
    const contained = listJobResults(jobId).find((result) => result.type === "contained")!;

    expect(dismissResult(jobId, "u1", contained.id).ok).toBe(true);
    const row = db.prepare(
      "SELECT library_id, folder_path FROM gallery_duplicate_contained_ignores"
    ).get() as { library_id: string; folder_path: string };
    expect(row).toEqual({ library_id: "GAL", folder_path: "test" });
  });

  it("records identical folders as a pair", () => {
    asset("a1", "Trip/one.jpg", "pic-1");
    asset("a2", "Trip/two.jpg", "pic-2");
    asset("b1", "Copy/one.jpg", "pic-1");
    asset("b2", "Copy/two.jpg", "pic-2");
    const jobId = startJob();
    const set = listJobResults(jobId).find((result) => result.type === "folder_set")!;

    expect(dismissResult(jobId, "u1", set.id).ok).toBe(true);
    const row = db.prepare(
      "SELECT library_a, path_a, library_b, path_b FROM gallery_duplicate_folder_ignores"
    ).get();
    expect(row).toEqual({ library_a: "GAL", path_a: "Copy", library_b: "GAL", path_b: "Trip" });
  });

  it("is only for the owner", () => {
    asset("a1", "Album/one.jpg", "same");
    asset("a2", "Copies/one.jpg", "same");
    const jobId = startJob(["GAL"], "files");
    const result = listJobResults(jobId)[0];
    expect(dismissResult(jobId, "u2", result.id)).toMatchObject({ ok: false, refused: "not_owner" });
  });
});

describe("applying the job's folder instructions", () => {
  it("recomputes which side is kept", () => {
    asset("a1", "Trip/one.jpg", "pic-1");
    asset("a2", "Trip/two.jpg", "pic-2");
    asset("b1", "Second/one.jpg", "pic-1");
    asset("b2", "Second/two.jpg", "pic-2");
    const jobId = startJob();

    const before = listJobResults(jobId).find((result) => result.type === "folder_set")!;
    expect(before.folders.find((folder) => folder.role === "keep")?.folderPath).toBe("Second");

    setJobFolderPreferences(jobId, "u1", [{ libraryId: "GAL", folderPath: "Trip", mode: "keep" }]);
    expect(applyPreferences(jobId, "u1").ok).toBe(true);

    const after = listJobResults(jobId).find((result) => result.type === "folder_set")!;
    expect(after.folders.find((folder) => folder.role === "keep")?.folderPath).toBe("Trip");
  });

  // A "keep" doesn't only change which copy wins — it can withdraw an offer
  // altogether, which is why the results are recomputed rather than patched.
  it("withdraws an offer for a folder now marked keep", () => {
    asset("t1", "test/one.jpg", "pic-1");
    asset("t2", "test/two.jpg", "pic-2");
    asset("f1", "One/one.jpg", "pic-1");
    asset("f2", "Two/two.jpg", "pic-2");
    const jobId = startJob();
    expect(listJobResults(jobId).some((result) => result.type === "contained")).toBe(true);

    setJobFolderPreferences(jobId, "u1", [{ libraryId: "GAL", folderPath: "test", mode: "keep" }]);
    applyPreferences(jobId, "u1");
    expect(listJobResults(jobId).some((result) => result.type === "contained")).toBe(false);
  });

  it("is refused once the job is finished", () => {
    asset("a1", "Album/one.jpg", "same");
    asset("a2", "Copies/one.jpg", "same");
    const jobId = startJob(["GAL"], "files");
    db.prepare("UPDATE duplicate_jobs SET status = 'completed' WHERE id = ?").run(jobId);
    expect(applyPreferences(jobId, "u1")).toMatchObject({ ok: false, refused: "not_reviewable" });
  });
});

describe("narrowing the list", () => {
  // A folder cleanup, so every fixture here is folder-shaped. GAL holds a scattered
  // contained folder; GAL2 holds an identical pair — two kinds, one library each, so
  // the type and library filters have something distinct to bite on.
  beforeEach(() => {
    // Scattered on purpose: the counterparts sit in two different folders, so "test"
    // is a contained folder rather than half of an identical pair.
    asset("t1", "test/one.jpg", "pic-1");
    asset("t2", "test/two.jpg", "pic-2");
    asset("f1", "Holiday/one.jpg", "pic-1");
    asset("f2", "Archive/two.jpg", "pic-2");
    asset("g1", "Other/three.jpg", "pic-3", "GAL2");
    asset("g2", "Other/four.jpg", "pic-4", "GAL2");
    asset("g3", "Spare/three.jpg", "pic-3", "GAL2");
    asset("g4", "Spare/four.jpg", "pic-4", "GAL2");
  });

  it("filters by kind of result", () => {
    const jobId = startJob(["GAL", "GAL2"]);
    const all = countJobResults(jobId);
    const contained = countJobResults(jobId, { type: "contained" });
    const folderSets = countJobResults(jobId, { type: "folder_set" });
    expect(contained).toBeGreaterThan(0);
    expect(folderSets).toBeGreaterThan(0);
    expect(contained + folderSets).toBe(all);
    expect(listJobResults(jobId, 50, 0, { type: "contained" }).every((r) => r.type === "contained")).toBe(true);
    // A folder cleanup holds no single-file sets at all — that is a different job.
    expect(countJobResults(jobId, { type: "photo_set" })).toBe(0);
  });

  it("filters by library", () => {
    const jobId = startJob(["GAL", "GAL2"]);
    const inSecond = listJobResults(jobId, 50, 0, { libraryId: "GAL2" });
    expect(inSecond.length).toBeGreaterThan(0);
    expect(inSecond.every((result) => result.members.some((member) => member.libraryId === "GAL2"))).toBe(true);
  });

  it("searches folder paths and file paths alike", () => {
    const jobId = startJob(["GAL", "GAL2"]);
    expect(countJobResults(jobId, { search: "Holiday" })).toBeGreaterThan(0);
    expect(countJobResults(jobId, { search: "three.jpg" })).toBeGreaterThan(0);
    expect(countJobResults(jobId, { search: "nothing-like-this" })).toBe(0);
  });

  it("filters by review mark", () => {
    const jobId = startJob(["GAL", "GAL2"]);
    const first = listJobResults(jobId)[0];
    markResult(jobId, "u1", first.id, "skipped");
    expect(countJobResults(jobId, { review: "skipped" })).toBe(1);
    expect(countJobResults(jobId, { review: "unreviewed" })).toBe(countJobResults(jobId) - 1);
  });

  it("counts and pages from the same filter", () => {
    const jobId = startJob(["GAL", "GAL2"]);
    const filter = { type: "folder_set" as const };
    const total = countJobResults(jobId, filter);
    expect(total).toBeGreaterThan(0);
    expect(listJobResults(jobId, 1, 0, filter)).toHaveLength(1);
    expect(listJobResults(jobId, 100, 0, filter)).toHaveLength(total);
  });
});

describe("the contained card's sentence", () => {
  // The whole point, restated where the page will read it: a list of real folders,
  // never a stand-in for "somewhere in this library".
  it("survives being narrowed, marked and re-read", () => {
    asset("t1", "test/one.jpg", "pic-1");
    asset("t2", "test/two.jpg", "pic-2");
    asset("t3", "test/three.jpg", "pic-3");
    asset("f1", "FolderOne/one.jpg", "pic-1");
    asset("f2", "FolderTwo/two.jpg", "pic-2");
    asset("f3", "FolderThree/three.jpg", "pic-3");

    const jobId = startJob();
    const contained = listJobResults(jobId, 50, 0, { type: "contained" })[0];
    markResult(jobId, "u1", contained.id, "reviewed");

    const again = listJobResults(jobId, 50, 0, { type: "contained" })[0];
    expect(keeperFoldersOf(again)).toEqual(["FolderOne", "FolderThree", "FolderTwo"]);
    expect(again.reviewStatus).toBe("reviewed");
  });
});
