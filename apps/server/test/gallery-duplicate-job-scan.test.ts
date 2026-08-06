// The cleanup job's SNAPSHOT — what a scan writes into the job's own tables.
//
// The case that matters most here is the scattered one. A folder whose copies sit in
// several other folders has no single covering folder except the library's own root,
// and the cached contained tier — one target column — could only answer "the root",
// which the card rendered as "Everything in this library" with a note reading
// «Copies sit in ".", "FolderOne", "FolderThree" and 1 more folder». Four releases
// re-worded that sentence. These tests pin the data shape that makes it sayable.
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import {
  activeJob, completeJob, createJob, getJob, setJobFolderPreferences
} from "../src/modules/library/gallery/duplicate-jobs.js";
import {
  runJobScan,
  listJobResults,
  keeperFoldersOf,
  type SnapshotResult
} from "../src/modules/library/gallery/duplicate-job-scan.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

const EXTERNAL = JSON.stringify({ mode: "external" });

interface AssetOpts {
  library?: string;
  size?: number;
  hash?: string | null;
  kind?: "photo" | "video";
}

function asset(id: string, relativePath: string, opts: AssetOpts = {}): string {
  const { library = "GAL", size = 1000, hash = `h-${id}`, kind = "photo" } = opts;
  db.prepare(`
    INSERT INTO library_items (id, library_id, type, folder_path, status, discovered_at)
    VALUES (?, ?, 'gallery', ?, 'ready', '2024-01-01T00:00:00.000Z')
  `).run(id, library, relativePath);
  db.prepare(`
    INSERT INTO gallery_details (item_id, kind, relative_path, size, content_hash, content_hash_at, modified_at)
    VALUES (?, ?, ?, ?, ?, 'm1', 'm1')
  `).run(id, kind, relativePath, size, hash);
  return id;
}

// A cleanup is folders OR files, never both, so every test says which it wants —
// a folder job holds no single-file sets and a file job holds no folder answers.
//
// A test that scans twice wants two jobs, and only one may be active at a time —
// so retire whatever the last call left behind rather than tripping the lock.
const scan = (libraries = ["GAL"], duplicateType: "folders" | "files" = "folders") => {
  const open = activeJob();
  if (open) completeJob(open.id, "u1", true);
  const created = createJob({ ownerUserId: "u1", libraryIds: libraries, duplicateType });
  if (!created.ok) throw new Error(`job refused: ${created.refused}`);
  const done = runJobScan(created.job.id, "u1");
  if (!done.ok) throw new Error(`scan refused: ${done.refused}`);
  return { jobId: created.job.id, summary: done.summary!, results: listJobResults(created.job.id) };
};

const byType = (results: SnapshotResult[], type: SnapshotResult["type"]) =>
  results.filter((result) => result.type === type);

const doomedFolder = (result: SnapshotResult) =>
  result.folders.find((folder) => folder.role === "delete");

beforeEach(() => {
  resetDb();
  makeUser("u1", "admin");
  makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
  makeLibrary("GAL2", { createdBy: "u1", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
  grant("group", EVERYONE_GROUP_ID, "GAL2", "member");
});

// ── The defect this whole redesign exists to fix ────────────────────────────

describe("a folder whose copies are scattered", () => {
  // Exactly the shape found in the dev library: "test" holds three files whose
  // counterparts sit one in each of three other folders. No single folder covers it.
  beforeEach(() => {
    asset("t1", "test/one.jpg", { hash: "pic-1" });
    asset("t2", "test/two.jpg", { hash: "pic-2" });
    asset("t3", "test/three.jpg", { hash: "pic-3" });
    asset("f1", "FolderOne/one.jpg", { hash: "pic-1" });
    asset("f2", "FolderTwo/two.jpg", { hash: "pic-2" });
    asset("f3", "FolderThree/three.jpg", { hash: "pic-3" });
  });

  it("is still found — coverage does not need one folder to hold everything", () => {
    const contained = byType(scan().results, "contained");
    // One card per destination: the three photos are safe in three different
    // folders, so there are three plain statements rather than one compound one.
    expect(contained).toHaveLength(3);
    expect(contained.every((result) => doomedFolder(result)?.folderPath === "test")).toBe(true);
  });

  it("gives every card exactly one destination, and never the library root", () => {
    const contained = byType(scan().results, "contained");
    // The whole point of the split: a card compares one folder with one folder.
    expect(contained.every((result) => keeperFoldersOf(result).length === 1)).toBe(true);
    expect(contained.flatMap(keeperFoldersOf).sort())
      .toEqual(["FolderOne", "FolderThree", "FolderTwo"]);
    // The bug, stated as a test: no "" folder standing in for "somewhere in this
    // library", which is what the old single-target row was forced to answer.
    expect(contained.flatMap(keeperFoldersOf)).not.toContain("");
  });

  it("says where each individual copy survives", () => {
    const contained = byType(scan().results, "contained");
    const doomed = contained.flatMap((result) =>
      result.members.filter((member) => member.role === "delete"));
    expect(doomed.map((member) => `${member.path} -> ${member.keeperPath}`).sort()).toEqual([
      "test/one.jpg -> FolderOne/one.jpg",
      "test/three.jpg -> FolderThree/three.jpg",
      "test/two.jpg -> FolderTwo/two.jpg"
    ]);
  });

  it("counts only the photos that card is actually about", () => {
    const contained = byType(scan().results, "contained");
    // Each card offers one photo here, not the folder's whole three — the folder
    // leaves across all three cards, and no single one of them empties it.
    expect(contained.map((result) => doomedFolder(result)?.itemCount)).toEqual([1, 1, 1]);
  });
});

describe("a copy genuinely loose at the top level", () => {
  it("is still named as the top level, because that is where it really is", () => {
    asset("t1", "test/one.jpg", { hash: "pic-1" });
    asset("t2", "test/two.jpg", { hash: "pic-2" });
    asset("r1", "one.jpg", { hash: "pic-1" });
    asset("r2", "two.jpg", { hash: "pic-2" });

    // Both copies survive in the same place, so it is one card — and "" is the
    // honest destination, the counterparts being in no folder at all.
    const contained = byType(scan().results, "contained");
    expect(contained).toHaveLength(1);
    expect(keeperFoldersOf(contained[0])).toEqual([""]);
  });

  it("gets a card of its own, separate from the foldered copies", () => {
    asset("t1", "test/one.jpg", { hash: "pic-1" });
    asset("t2", "test/two.jpg", { hash: "pic-2" });
    asset("r1", "one.jpg", { hash: "pic-1" });
    asset("f2", "Album/two.jpg", { hash: "pic-2" });

    // One photo survives loose at the top, the other inside "Album" — two
    // destinations, so two cards, each naming exactly one place.
    const contained = byType(scan().results, "contained");
    expect(contained).toHaveLength(2);
    expect(contained.flatMap(keeperFoldersOf).sort()).toEqual(["", "Album"]);
  });
});

// ── Coverage is per file, and refuses when a file has no counterpart ─────────

describe("coverage", () => {
  it("is refused when even one photo has no copy elsewhere", () => {
    asset("t1", "test/one.jpg", { hash: "pic-1" });
    asset("t2", "test/two.jpg", { hash: "pic-2" });
    asset("f1", "Album/one.jpg", { hash: "pic-1" });
    // pic-2 exists nowhere else.
    expect(byType(scan().results, "contained")).toHaveLength(0);
  });

  it("respects multiplicity — two copies here need two copies there", () => {
    asset("t1", "test/one.jpg", { hash: "pic-1" });
    asset("t2", "test/also-one.jpg", { hash: "pic-1" });
    asset("f1", "Album/one.jpg", { hash: "pic-1" });
    expect(byType(scan().results, "contained")).toHaveLength(0);

    asset("f2", "Album/one-again.jpg", { hash: "pic-1" });
    expect(byType(scan().results, "contained")).toHaveLength(1);
  });

  it("does not count a folder's own files as copies of itself", () => {
    asset("t1", "test/one.jpg", { hash: "pic-1" });
    asset("t2", "test/nested/one.jpg", { hash: "pic-1" });
    expect(byType(scan().results, "contained")).toHaveLength(0);
  });

  // The commonest real mess: a folder copied INSIDE itself. The parent's own files
  // cover the child's, and no equal-contents test can ever see it.
  it("catches a folder copied into itself", () => {
    asset("a1", "Trip/one.jpg", { hash: "pic-1" });
    asset("a2", "Trip/two.jpg", { hash: "pic-2" });
    asset("b1", "Trip/Trip/one.jpg", { hash: "pic-1" });
    asset("b2", "Trip/Trip/two.jpg", { hash: "pic-2" });

    const contained = byType(scan().results, "contained")[0];
    expect(doomedFolder(contained)?.folderPath).toBe("Trip/Trip");
    expect(keeperFoldersOf(contained)).toEqual(["Trip"]);
  });
});

// ── Identical folders ───────────────────────────────────────────────────────

describe("identical folders", () => {
  it("keeps one and offers the rest, with every file pointing at its counterpart", () => {
    asset("a1", "Trip/one.jpg", { hash: "pic-1" });
    asset("a2", "Trip/two.jpg", { hash: "pic-2" });
    asset("b1", "Backups/Trip/one.jpg", { hash: "pic-1" });
    asset("b2", "Backups/Trip/two.jpg", { hash: "pic-2" });

    const results = scan().results;
    const sets = byType(results, "folder_set");
    expect(sets).toHaveLength(1);

    const kept = sets[0].folders.find((folder) => folder.role === "keep");
    const going = sets[0].folders.find((folder) => folder.role === "delete");
    // "Backups/…" is named like a copy, so the original is the one kept.
    expect(kept?.folderPath).toBe("Trip");
    expect(going?.folderPath).toBe("Backups/Trip");

    const doomed = sets[0].members.filter((member) => member.role === "delete");
    expect(doomed.map((member) => `${member.path} -> ${member.keeperPath}`).sort()).toEqual([
      "Backups/Trip/one.jpg -> Trip/one.jpg",
      "Backups/Trip/two.jpg -> Trip/two.jpg"
    ]);
  });

  it("does not also report the same folders as stored elsewhere", () => {
    asset("a1", "Trip/one.jpg", { hash: "pic-1" });
    asset("a2", "Trip/two.jpg", { hash: "pic-2" });
    asset("b1", "Copy/one.jpg", { hash: "pic-1" });
    asset("b2", "Copy/two.jpg", { hash: "pic-2" });

    const results = scan().results;
    expect(byType(results, "folder_set")).toHaveLength(1);
    expect(byType(results, "contained")).toHaveLength(0);
  });
});

// ── Photo sets ──────────────────────────────────────────────────────────────

describe("photo sets", () => {
  it("group byte-identical copies and name the survivor", () => {
    asset("a1", "Album/one.jpg", { hash: "same" });
    asset("a2", "Downloads/one.jpg", { hash: "same" });

    const sets = byType(scan(["GAL"], "files").results, "photo_set");
    expect(sets).toHaveLength(1);
    const keep = sets[0].members.find((member) => member.role === "keep");
    const going = sets[0].members.find((member) => member.role === "delete");
    expect(keep?.path).toBe("Album/one.jpg");
    expect(going?.keeperPath).toBe("Album/one.jpg");
  });

  it("are left out of a folder cleanup entirely", () => {
    asset("a1", "Album/one.jpg", { hash: "same" });
    asset("a2", "Downloads/one.jpg", { hash: "same" });

    const created = createJob({ ownerUserId: "u1", libraryIds: ["GAL"], duplicateType: "folders" });
    if (!created.ok) throw new Error("expected a job");
    runJobScan(created.job.id, "u1");
    expect(byType(listJobResults(created.job.id), "photo_set")).toHaveLength(0);
  });

  it("honour the media type the wizard chose", () => {
    asset("p1", "Album/one.jpg", { hash: "pic" });
    asset("p2", "Copies/one.jpg", { hash: "pic" });
    asset("v1", "Album/clip.mp4", { hash: "vid", kind: "video" });
    asset("v2", "Copies/clip.mp4", { hash: "vid", kind: "video" });

    const created = createJob({ ownerUserId: "u1", libraryIds: ["GAL"], duplicateType: "files", mediaType: "video" });
    if (!created.ok) throw new Error("expected a job");
    runJobScan(created.job.id, "u1");
    const sets = byType(listJobResults(created.job.id), "photo_set");
    expect(sets).toHaveLength(1);
    expect(sets[0].members.every((member) => member.path.endsWith(".mp4"))).toBe(true);
  });
});

// ── Scope and protection ────────────────────────────────────────────────────

describe("scope", () => {
  it("never looks at a library the job didn't include", () => {
    asset("a1", "Album/one.jpg", { hash: "same" });
    asset("b1", "Elsewhere/one.jpg", { hash: "same", library: "GAL2" });

    // Scoped to GAL alone there is only one copy, so there is nothing to offer —
    // and crucially nothing that would propose deleting the last copy in scope.
    expect(scan(["GAL"], "files").results).toHaveLength(0);
    expect(byType(scan(["GAL", "GAL2"], "files").results, "photo_set")).toHaveLength(1);
  });

  it("shows a copy in a read-only library but never offers it for deletion", () => {
    makeLibrary("EXT", { createdBy: "u1", type: "gallery", policyJson: EXTERNAL });
    grant("group", EVERYONE_GROUP_ID, "EXT", "member");
    asset("a1", "Album/one.jpg", { hash: "same" });
    asset("e1", "Sync/one.jpg", { hash: "same", library: "EXT" });

    const sets = byType(scan(["GAL", "EXT"], "files").results, "photo_set");
    expect(sets).toHaveLength(1);
    // The external copy wins the keeper contest — it is the only outcome available.
    const keep = sets[0].members.find((member) => member.role === "keep");
    expect(keep?.libraryId).toBe("EXT");
    const going = sets[0].members.find((member) => member.role === "delete");
    expect(going?.libraryId).toBe("GAL");
    expect(sets[0].members.some((member) => member.role === "delete" && member.libraryId === "EXT")).toBe(false);
  });

  it("never offers to clear out a folder in a read-only library", () => {
    makeLibrary("EXT", { createdBy: "u1", type: "gallery", policyJson: EXTERNAL });
    grant("group", EVERYONE_GROUP_ID, "EXT", "member");
    asset("e1", "Sync/one.jpg", { hash: "pic-1", library: "EXT" });
    asset("e2", "Sync/two.jpg", { hash: "pic-2", library: "EXT" });
    asset("a1", "Album/one.jpg", { hash: "pic-1" });
    asset("a2", "Album/two.jpg", { hash: "pic-2" });

    const results = scan(["GAL", "EXT"]).results;
    for (const result of byType(results, "contained")) {
      expect(doomedFolder(result)?.libraryId).not.toBe("EXT");
    }
    for (const result of byType(results, "folder_set")) {
      const going = result.folders.filter((folder) => folder.role === "delete");
      expect(going.every((folder) => folder.libraryId !== "EXT")).toBe(true);
    }
  });
});

describe("the job's own folder instructions", () => {
  it("decide which side is kept, without touching the global ones", () => {
    asset("a1", "Trip/one.jpg", { hash: "pic-1" });
    asset("a2", "Trip/two.jpg", { hash: "pic-2" });
    asset("b1", "Second/one.jpg", { hash: "pic-1" });
    asset("b2", "Second/two.jpg", { hash: "pic-2" });

    const created = createJob({ ownerUserId: "u1", libraryIds: ["GAL"] });
    if (!created.ok) throw new Error("expected a job");
    setJobFolderPreferences(created.job.id, "u1", [
      { libraryId: "GAL", folderPath: "Second", mode: "keep" }
    ]);
    runJobScan(created.job.id, "u1");

    const set = byType(listJobResults(created.job.id), "folder_set")[0];
    expect(set.folders.find((folder) => folder.role === "keep")?.folderPath).toBe("Second");
  });

  it("keep a folder from being offered for removal at all", () => {
    asset("t1", "test/one.jpg", { hash: "pic-1" });
    asset("t2", "test/two.jpg", { hash: "pic-2" });
    asset("f1", "One/one.jpg", { hash: "pic-1" });
    asset("f2", "Two/two.jpg", { hash: "pic-2" });

    const created = createJob({ ownerUserId: "u1", libraryIds: ["GAL"] });
    if (!created.ok) throw new Error("expected a job");
    setJobFolderPreferences(created.job.id, "u1", [
      { libraryId: "GAL", folderPath: "test", mode: "keep" }
    ]);
    runJobScan(created.job.id, "u1");
    expect(byType(listJobResults(created.job.id), "contained")).toHaveLength(0);
  });
});

// ── The snapshot is the job's own ───────────────────────────────────────────

describe("the snapshot", () => {
  it("survives a rebuild of the global caches", () => {
    asset("t1", "test/one.jpg", { hash: "pic-1" });
    asset("t2", "test/two.jpg", { hash: "pic-2" });
    asset("f1", "One/one.jpg", { hash: "pic-1" });
    asset("f2", "Two/two.jpg", { hash: "pic-2" });

    const { jobId, results } = scan();
    // Two destinations, so two cards.
    expect(byType(results, "contained")).toHaveLength(2);
    const before = results.length;

    // Everything the older pages do on a Rebuild — the caches are emptied and
    // rewritten under new ids. A job that referenced them would be gutted here.
    db.prepare("DELETE FROM gallery_duplicate_contained_folders").run();
    db.prepare("DELETE FROM gallery_duplicate_groups").run();
    db.prepare("DELETE FROM gallery_duplicate_folder_groups").run();

    const after = listJobResults(jobId);
    expect(after).toHaveLength(before);
    expect(byType(after, "contained").flatMap(keeperFoldersOf).sort()).toEqual(["One", "Two"]);
  });

  it("is replaced, not added to, when the job is scanned again", () => {
    asset("a1", "Album/one.jpg", { hash: "same" });
    asset("a2", "Copies/one.jpg", { hash: "same" });

    const created = createJob({ ownerUserId: "u1", libraryIds: ["GAL"] });
    if (!created.ok) throw new Error("expected a job");
    runJobScan(created.job.id, "u1");
    const first = listJobResults(created.job.id).length;
    runJobScan(created.job.id, "u1");
    expect(listJobResults(created.job.id)).toHaveLength(first);
  });

  it("leaves the job in review with its totals counted", () => {
    asset("a1", "Album/one.jpg", { hash: "same", size: 500 });
    asset("a2", "Copies/one.jpg", { hash: "same", size: 500 });

    const { jobId } = scan(["GAL"], "files");
    const job = getJob(jobId)!;
    expect(job.status).toBe("review");
    expect(job.scanCompletedAt).not.toBeNull();
    expect(job.totals.results).toBe(1);
    expect(job.totals.remaining).toBe(1);
    expect(job.totals.reclaimableBytes).toBe(500);
  });

  it("refuses to scan someone else's job", () => {
    makeUser("u2", "admin");
    const created = createJob({ ownerUserId: "u1", libraryIds: ["GAL"] });
    if (!created.ok) throw new Error("expected a job");
    expect(runJobScan(created.job.id, "u2")).toMatchObject({ ok: false, refused: "not_owner" });
  });
});
