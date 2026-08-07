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
} from "../src/modules/library/gallery/duplicates/jobs.js";
import {
  runJobScan,
  listJobResults,
  keeperFoldersOf,
  type SnapshotResult
} from "../src/modules/library/gallery/duplicates/job-scan.js";
import { dismissResult } from "../src/modules/library/gallery/duplicates/job-review.js";
import { NEAR_IDENTICAL_DISTANCE } from "../src/modules/library/gallery/duplicates/items.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

const EXTERNAL = JSON.stringify({ mode: "external" });

interface AssetOpts {
  library?: string;
  size?: number;
  hash?: string | null;
  kind?: "photo" | "video";
  /** 16 hex chars — the dHash the near-identical tier matches on. NULL by default,
   *  which is what every video has and what keeps a photo out of that tier. */
  phash?: string | null;
}

function asset(id: string, relativePath: string, opts: AssetOpts = {}): string {
  const { library = "GAL", size = 1000, hash = `h-${id}`, kind = "photo", phash = null } = opts;
  db.prepare(`
    INSERT INTO library_items (id, library_id, type, folder_path, status, discovered_at)
    VALUES (?, ?, 'gallery', ?, 'ready', '2024-01-01T00:00:00.000Z')
  `).run(id, library, relativePath);
  db.prepare(`
    INSERT INTO gallery_details (item_id, kind, relative_path, size, content_hash, content_hash_at, modified_at, phash)
    VALUES (?, ?, ?, ?, ?, 'm1', 'm1', ?)
  `).run(id, kind, relativePath, size, hash, phash);
  return id;
}

// Fingerprints as bit patterns, so a test says how far apart two pictures are rather
// than quoting hex. bits(0) and bits(3) are two bits apart — inside the window; bits(31)
// is five, outside it.
const bits = (n: number): string => n.toString(16).padStart(16, "0");

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

// A cleanup whose folder instructions are set before the scan, which is the order the
// wizard imposes: the scan picks each set's keeper as it writes it, so an instruction
// given afterwards would need the whole snapshot rebuilding (applyPreferences does
// exactly that, and has its own tests).
const scanWith = (
  instructions: { folderPath: string; mode: "keep" | "clear"; libraryId?: string }[],
  libraries = ["GAL"],
  duplicateType: "folders" | "files" = "folders"
) => {
  const open = activeJob();
  if (open) completeJob(open.id, "u1", true);
  const created = createJob({ ownerUserId: "u1", libraryIds: libraries, duplicateType });
  if (!created.ok) throw new Error(`job refused: ${created.refused}`);
  setJobFolderPreferences(created.job.id, "u1", instructions.map((entry) => ({
    libraryId: entry.libraryId ?? "GAL", folderPath: entry.folderPath, mode: entry.mode
  })));
  const done = runJobScan(created.job.id, "u1");
  if (!done.ok) throw new Error(`scan refused: ${done.refused}`);
  return { jobId: created.job.id, results: listJobResults(created.job.id) };
};

// One folder holding the same two pictures, wherever you put it.
function trip(prefix: string, idPrefix: string) {
  asset(`${idPrefix}1`, `${prefix}/one.jpg`, { hash: "pic-one" });
  asset(`${idPrefix}2`, `${prefix}/two.jpg`, { hash: "pic-two" });
}

const keeperFolder = (result: SnapshotResult) =>
  result.folders.find((folder) => folder.role === "keep")?.folderPath;

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

describe("what the byte-identical tier will and will not group", () => {
  it("pairs copies that sit in different libraries", () => {
    asset("a", "a.jpg", { hash: "same" });
    asset("b", "photos/b.jpg", { hash: "same", library: "GAL2" });
    asset("c", "c.jpg", { hash: "other" });

    const sets = byType(scan(["GAL", "GAL2"], "files").results, "photo_set");
    expect(sets).toHaveLength(1);
    expect(sets[0].members.map((member) => member.itemId).sort()).toEqual(["a", "b"]);
  });

  it("never pairs same-name siblings that differ in content (RAW + JPEG)", () => {
    // A camera writes IMG_1234.CR2 and IMG_1234.JPG side by side. Same basename, and a
    // name-based detector would pair them; different bytes, so this one must not.
    asset("raw", "IMG_1234.CR2", { size: 5000, hash: "raw-bytes" });
    asset("jpg", "IMG_1234.JPG", { size: 5000, hash: "jpg-bytes" });

    expect(byType(scan(["GAL"], "files").results, "photo_set")).toHaveLength(0);
  });

  it("leaves out a photo the hashing pass never reached", () => {
    asset("a", "a.jpg", { hash: "same" });
    asset("b", "b.jpg", { hash: "same" });
    asset("c", "c.jpg", { hash: null });

    const sets = byType(scan(["GAL"], "files").results, "photo_set");
    expect(sets).toHaveLength(1);
    expect(sets[0].members.map((member) => member.itemId).sort()).toEqual(["a", "b"]);
  });
});

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

describe("folders inside folders", () => {
  it("reports only the topmost pairing, not every subfolder inside it", () => {
    asset("a1", "Photos/2019/one.jpg", { hash: "pic-one" });
    asset("a2", "Photos/2019/two.jpg", { hash: "pic-two" });
    asset("b1", "Backup/2019/one.jpg", { hash: "pic-one" });
    asset("b2", "Backup/2019/two.jpg", { hash: "pic-two" });

    // Photos pairs with Backup, and Photos/2019 with Backup/2019 — only the parents
    // are worth acting on, because removing one takes its subfolders with it.
    const sets = byType(scan().results, "folder_set");
    expect(sets).toHaveLength(1);
    expect(sets[0].folders.map((folder) => folder.folderPath).sort()).toEqual(["Backup", "Photos"]);
  });

  it("never offers both sides of a mutual cover — that would delete everything", () => {
    // Same photos, different layout: each folder covers the other. Offering both
    // would propose deleting every copy there is between them.
    asset("a1", "Album/one.jpg", { hash: "pic-one" });
    asset("a2", "Album/two.jpg", { hash: "pic-two" });
    asset("b1", "Downloads/sub/one.jpg", { hash: "pic-one" });
    asset("b2", "Downloads/sub/two.jpg", { hash: "pic-two" });

    const contained = byType(scan().results, "contained");
    expect(contained).toHaveLength(1);
    // The downloads copy is the one that goes, never the album.
    expect(doomedFolder(contained[0])?.folderPath).toBe("Downloads");
  });
});

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

describe("clearing a folder out", () => {
  it("loses to every other folder in the set, even one named like a copy", () => {
    trip("Consolidated", "a");
    trip("Backup/holiday", "b");

    const sets = byType(scanWith([{ folderPath: "Consolidated", mode: "clear" }]).results, "folder_set");
    expect(keeperFolder(sets[0])).toBe("Backup/holiday");
  });

  it("still keeps a copy when every folder in the set is being cleared out", () => {
    trip("A", "a");
    trip("B", "b");

    const sets = byType(scanWith([
      { folderPath: "A", mode: "clear" },
      { folderPath: "B", mode: "clear" }
    ]).results, "folder_set");
    // No preferred survivor, so the ordinary criteria decide — one folder is still
    // kept. Clearing a folder out means "these are safe elsewhere", never "delete these".
    expect(sets).toHaveLength(1);
    expect(sets[0].folders.filter((folder) => folder.role === "keep")).toHaveLength(1);
  });

  it("never points photos at a folder being cleared out", () => {
    // Both Keepsafe and Old drop cover Inner, but one of them is on its way out. Each
    // covering folder holds a different extra, so no two are equal-contents — that
    // would be answered by the folder_set tier instead.
    asset("i1", "Inner/one.jpg", { hash: "pic-one" });
    asset("i2", "Inner/two.jpg", { hash: "pic-two" });
    trip("Old drop", "a");
    asset("a3", "Old drop/extra-a.jpg", { hash: "pic-a" });
    trip("Keepsafe", "k");
    asset("k3", "Keepsafe/extra-k.jpg", { hash: "pic-k" });

    const contained = byType(scanWith([{ folderPath: "Old drop", mode: "clear" }]).results, "contained");
    const inner = contained.find((result) => doomedFolder(result)?.folderPath === "Inner");
    expect(keeperFoldersOf(inner!)).toEqual(["Keepsafe"]);
  });

  // The shape that exposed both halves of this: OneDrive holds copies of dated folders
  // and is marked clear, but sits SHALLOWER than they do — and the doomed side is picked
  // deepest-first, so the dated folders claimed the removal and OneDrive became their
  // survivor. The instruction says the opposite: OneDrive's copies are the ones to go.
  it("offers the cleared folder for removal, not the folder it duplicates", () => {
    asset("c1", "OneDrive/Camera Roll/a.jpg", { hash: "pic-a" });
    asset("c2", "OneDrive/Camera Roll/b.jpg", { hash: "pic-b" });
    asset("p1", "Photos/_2016/2016-05-01/a.jpg", { hash: "pic-a" });
    asset("p2", "Photos/_2016/2016-05-01/b.jpg", { hash: "pic-b" });

    const results = scanWith([{ folderPath: "OneDrive", mode: "clear" }]).results;
    expect(results.length).toBeGreaterThan(0);
    // Which TIER answers is not the point — the equal-contents pair is the stronger
    // statement and claims it, leaving the cleared parent to the contained tier. What
    // matters is the direction: everything offered for removal is inside OneDrive, and
    // nothing is kept there.
    for (const result of results) {
      expect(doomedFolder(result)?.folderPath.startsWith("OneDrive")).toBe(true);
      expect(keeperFoldersOf(result).some((path) => path.startsWith("OneDrive"))).toBe(false);
    }
  });

  // And when the ONLY copy elsewhere is inside a folder being cleared out, the folder
  // is not covered by anywhere the admin wants to keep — so there is nothing safe to
  // say. Offering it anyway told them their photos were safe in the very folder they
  // had asked to empty.
  it("does not call a folder redundant when its only cover is being cleared out", () => {
    asset("o1", "OneDrive/a.jpg", { hash: "pic-a" });
    asset("o2", "OneDrive/b.jpg", { hash: "pic-b" });
    // An extra of its own, so OneDrive is not itself fully covered and cannot go whole.
    asset("o3", "OneDrive/only-here.jpg", { hash: "pic-unique" });
    asset("p1", "Photos/_2013/2013-09-28/a.jpg", { hash: "pic-a" });
    asset("p2", "Photos/_2013/2013-09-28/b.jpg", { hash: "pic-b" });

    const results = scanWith([{ folderPath: "OneDrive", mode: "clear" }]).results;
    const contained = byType(results, "contained");
    // Nothing may be offered on the promise that OneDrive is keeping a copy.
    expect(contained.flatMap(keeperFoldersOf)).not.toContain("OneDrive");
  });

  it("reads the most specific instruction, so an exception inside a kept folder holds", () => {
    trip("Photos/keepers", "a");
    trip("Photos/unsorted", "b");

    const sets = byType(scanWith([
      { folderPath: "Photos", mode: "keep" },
      { folderPath: "Photos/unsorted", mode: "clear" }
    ]).results, "folder_set");
    expect(keeperFolder(sets[0])).toBe("Photos/keepers");
  });

  it("keeps one copy even when both copies sit inside the folder being cleared", () => {
    // A file cleanup this time: the instruction covers both copies, so there is no
    // preferred survivor and the ordinary criteria still keep one.
    asset("a1", "Duplicates/one.jpg", { hash: "pic-one" });
    asset("a2", "Duplicates/anothercopy/one.jpg", { hash: "pic-one" });

    const sets = byType(
      scanWith([{ folderPath: "Duplicates", mode: "clear" }], ["GAL"], "files").results,
      "photo_set"
    );
    expect(sets).toHaveLength(1);
    expect(sets[0].members.filter((member) => member.role === "keep")).toHaveLength(1);
    // And the card admits it, or the setting reads as though it had been ignored.
    expect(sets[0].keeperReason).toContain("clearing out");
  });

  it("lets a more specific clear-out beat the folder it sits in", () => {
    asset("a1", "Duplicates/one.jpg", { hash: "pic-one" });
    asset("a2", "Duplicates/anothercopy/one.jpg", { hash: "pic-one" });

    const sets = byType(scanWith([
      { folderPath: "Duplicates", mode: "keep" },
      { folderPath: "Duplicates/anothercopy", mode: "clear" }
    ], ["GAL"], "files").results, "photo_set");
    expect(sets[0].members.find((member) => member.role === "keep")?.itemId).toBe("a1");
  });

  it("never proposes removing a folder the instructions say to keep", () => {
    asset("p1", "Trip/one.jpg", { hash: "pic-1" });
    asset("p2", "Trip/two.jpg", { hash: "pic-2" });
    asset("c1", "Trip/Trip/one.jpg", { hash: "pic-1" });
    asset("c2", "Trip/Trip/two.jpg", { hash: "pic-2" });

    const contained = byType(scanWith([{ folderPath: "Trip/Trip", mode: "keep" }]).results, "contained");
    expect(contained.map((result) => doomedFolder(result)?.folderPath)).not.toContain("Trip/Trip");
  });
});

describe("the snapshot", () => {
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

// ── The near-identical tier ─────────────────────────────────────────────────
//
// Same picture, different file: resized, re-compressed, re-exported. Matched on the
// dHash rather than the bytes, so unlike every other tier it is a JUDGEMENT rather
// than a fact — the copies are not interchangeable, and the recorded distance is what
// lets the rest of the app know that.

describe("near-identical photos", () => {
  it("finds a set the byte-identical tier cannot see", () => {
    asset("n1", "one/pic.jpg", { hash: "a", phash: bits(0) });
    asset("n2", "two/pic.jpg", { hash: "b", phash: bits(3) });

    const sets = byType(scan(["GAL"], "files").results, "photo_set");
    expect(sets).toHaveLength(1);
    expect(sets[0].tier).toBe("near");
  });

  it("records how far each copy sits from the keeper", () => {
    asset("n1", "one/pic.jpg", { hash: "a", phash: bits(0) });
    asset("n2", "two/pic.jpg", { hash: "b", phash: bits(3) });

    const [set] = byType(scan(["GAL"], "files").results, "photo_set");
    const keeper = set.members.find((member) => member.role === "keep")!;
    const going = set.members.find((member) => member.role === "delete")!;
    expect(keeper.distance).toBe(0);
    expect(going.distance).toBe(2);
  });

  // The tightest case the band index has to survive. A 64-bit fingerprint is indexed
  // as 4 bands of 16 bits: two pictures within 3 bits MUST share a band, because 3
  // differences cannot touch 4 bands. Spread them one per band and no band is left
  // whole — which is why the window stops at 3 and why raising it without adding
  // bands would silently stop finding pairs.
  it("finds a pair whose 3 differing bits are spread across three bands", () => {
    asset("a", "a.jpg", { hash: "h-a", phash: bits(2 ** 0 + 2 ** 16 + 2 ** 32) });
    asset("b", "b.jpg", { hash: "h-b", phash: bits(0) });

    const near = byType(scan(["GAL"], "files").results, "photo_set")
      .filter((result) => result.members.some((member) => member.distance > 0));
    expect(near).toHaveLength(1);
    expect(near[0].members.map((member) => member.itemId).sort()).toEqual(["a", "b"]);
  });

  it("stops at the window — one differing bit in every band is a different photo", () => {
    expect(NEAR_IDENTICAL_DISTANCE).toBe(3);
    // One differing bit in every band: no band survives whole, which is exactly why
    // the 4-band index is only exact up to 3.
    asset("a", "a.jpg", { hash: "h-a", phash: bits(2 ** 0 + 2 ** 16 + 2 ** 32 + 2 ** 48) });
    asset("b", "b.jpg", { hash: "h-b", phash: bits(0) });

    expect(byType(scan(["GAL"], "files").results, "photo_set")).toHaveLength(0);
  });

  it("leaves pictures further apart than the window alone", () => {
    asset("n1", "one/pic.jpg", { hash: "a", phash: bits(0) });
    asset("n2", "two/pic.jpg", { hash: "b", phash: bits(31) }); // five bits
    expect(byType(scan(["GAL"], "files").results, "photo_set")).toHaveLength(0);
  });

  // The ordering invariant. Run the near pass first, or without suppression, and every
  // byte-identical copy turns up twice — once in its own set and once inside a near set
  // sitting beside it.
  it("does not drag a byte-identical copy back in beside its own set", () => {
    asset("e1", "one/pic.jpg", { hash: "same", phash: bits(0) });
    asset("e2", "two/pic.jpg", { hash: "same", phash: bits(0) });
    asset("n1", "three/pic.jpg", { hash: "other", phash: bits(3) });

    const sets = byType(scan(["GAL"], "files").results, "photo_set");
    // One exact set of two, and one near set pairing its KEEPER with the third photo.
    expect(sets).toHaveLength(2);
    expect(sets.map((set) => set.tier).sort()).toEqual(["exact", "near"]);

    const near = sets.find((set) => set.tier === "near")!;
    const inNear = near.members.map((member) => member.path).sort();
    expect(inNear).toHaveLength(2);
    expect(inNear).toContain("three/pic.jpg");
    // Whichever of the identical pair was kept is in there; the other is not.
    expect(inNear.some((path) => path === "one/pic.jpg" || path === "two/pic.jpg")).toBe(true);
  });

  it("marks a byte-identical set as certain, not near", () => {
    asset("e1", "one/pic.jpg", { hash: "same", phash: bits(0) });
    asset("e2", "two/pic.jpg", { hash: "same", phash: bits(0) });

    const [set] = byType(scan(["GAL"], "files").results, "photo_set");
    expect(set.tier).toBe("exact");
    expect(set.members.every((member) => member.distance === 0)).toBe(true);
  });

  // phash is photos-only, so a re-encoded video is invisible to everything but bytes.
  it("never pairs videos, which have no fingerprint", () => {
    asset("v1", "one/clip.mp4", { hash: "a", kind: "video" });
    asset("v2", "two/clip.mp4", { hash: "b", kind: "video" });
    expect(byType(scan(["GAL"], "files").results, "photo_set")).toHaveLength(0);
  });

  it("honours a standing 'not the same' decision", () => {
    asset("n1", "one/pic.jpg", { hash: "a", phash: bits(0) });
    asset("n2", "two/pic.jpg", { hash: "b", phash: bits(3) });
    db.prepare("INSERT INTO gallery_duplicate_ignores (item_a, item_b) VALUES ('n1', 'n2')").run();

    expect(byType(scan(["GAL"], "files").results, "photo_set")).toHaveLength(0);
  });

  it("stays out of a folder cleanup, which answers a different question", () => {
    asset("n1", "one/pic.jpg", { hash: "a", phash: bits(0) });
    asset("n2", "two/pic.jpg", { hash: "b", phash: bits(3) });
    expect(byType(scan(["GAL"], "folders").results, "photo_set")).toHaveLength(0);
  });
});

// ── Telling a copy from two shots that look alike ───────────────────────────
//
// The fingerprint cannot do this on its own: consecutive frames of a static scene land
// one to three bits apart, exactly where a re-saved file does. On the dev library seven
// of eight sampled near sets were bursts — IMG_1109 beside IMG_1110, a second apart,
// sizes within a percent — so without this the tier mostly offers to delete
// photographs nobody has twice.

describe("lookalikes that are two separate photographs", () => {
  // A pair the fingerprint matches, parameterised on everything that decides.
  const pair = (opts: {
    widthA?: number; heightA?: number; sizeA?: number; takenA?: string | null;
    widthB?: number; heightB?: number; sizeB?: number; takenB?: string | null;
  }) => {
    const set = (id: string, path: string, w: number, h: number, size: number, taken: string | null) => {
      asset(id, path, { hash: `h-${id}`, phash: id === "p1" ? bits(0) : bits(3), size });
      db.prepare("UPDATE gallery_details SET width = ?, height = ?, taken_at = ? WHERE item_id = ?")
        .run(w, h, taken, id);
    };
    set("p1", "one/a.jpg", opts.widthA ?? 3456, opts.heightA ?? 2304, opts.sizeA ?? 4_000_000, opts.takenA ?? null);
    set("p2", "two/b.jpg", opts.widthB ?? 3456, opts.heightB ?? 2304, opts.sizeB ?? 4_000_000, opts.takenB ?? null);
  };

  it("leaves out frames a second apart at the same size and resolution", () => {
    pair({ takenA: "2009-12-08T21:50:47.000Z", takenB: "2009-12-08T21:50:48.000Z", sizeB: 3_900_000 });
    const { results, summary } = scan(["GAL"], "files");
    expect(byType(results, "photo_set")).toHaveLength(0);
    // Counted, not hidden: "we found less than you expected" deserves a reason.
    expect(summary.separateShots).toBe(1);
  });

  it("keeps a resized copy, whatever the timestamps say", () => {
    // The messenger copy from the dev library: same moment, a fraction of the pixels.
    pair({
      widthA: 3120, heightA: 4160, sizeA: 3_000_000, takenA: "2015-12-14T17:08:51.000Z",
      widthB: 960, heightB: 1280, sizeB: 180_000, takenB: "2015-12-14T17:08:51.000Z"
    });
    const { results, summary } = scan(["GAL"], "files");
    expect(byType(results, "photo_set")).toHaveLength(1);
    expect(summary.separateShots).toBe(0);
  });

  it("keeps a re-compressed copy at the same resolution", () => {
    pair({ takenA: "2008-10-04T17:53:23.000Z", takenB: "2008-10-04T17:53:25.000Z", sizeB: 900_000 });
    expect(byType(scan(["GAL"], "files").results, "photo_set")).toHaveLength(1);
  });

  // taken_at falls back to the file's mtime when there is no EXIF, so two copies made
  // months apart would look like a burst if the gap were not bounded.
  it("keeps copies whose only difference is when the files were written", () => {
    pair({ takenA: "2019-01-01T00:00:00.000Z", takenB: "2019-06-01T00:00:00.000Z" });
    expect(byType(scan(["GAL"], "files").results, "photo_set")).toHaveLength(1);
  });

  it("keeps a pair with no dates to compare", () => {
    pair({ takenA: null, takenB: null });
    expect(byType(scan(["GAL"], "files").results, "photo_set")).toHaveLength(1);
  });

  // A camera writing whole seconds puts two burst frames at the same value — but so
  // does a copy that inherited its original's EXIF, and dropping that would lose a real
  // duplicate. Ambiguous pairs stay in the tier for a person to look at.
  // What the timestamp cannot catch: cameras of that era write whole seconds, so a
  // pair fired inside one second shares its EXIF value exactly. The frame numbers
  // still say what happened.
  it("leaves out consecutive frame numbers even when the timestamp is identical", () => {
    pair({ takenA: "2008-10-04T22:30:01.000Z", takenB: "2008-10-04T22:30:01.000Z", sizeB: 3_990_000 });
    db.prepare("UPDATE gallery_details SET relative_path = ? WHERE item_id = ?").run("one/IMG_1109.JPG", "p1");
    db.prepare("UPDATE gallery_details SET relative_path = ? WHERE item_id = ?").run("two/IMG_1110.JPG", "p2");

    const { results, summary } = scan(["GAL"], "files");
    expect(byType(results, "photo_set")).toHaveLength(0);
    expect(summary.separateShots).toBe(1);
  });

  // The counter was ADDED, not incremented: "Picture 071-001" against "Picture 071"
  // share no prefix once the trailing digits come off. A real duplicate, and it stays.
  it("keeps a copy whose name gained a suffix rather than counting on", () => {
    pair({ takenA: "2005-11-23T05:25:31.000Z", takenB: "2005-11-23T05:25:31.000Z" });
    db.prepare("UPDATE gallery_details SET relative_path = ? WHERE item_id = ?").run("one/Picture 071.jpg", "p1");
    db.prepare("UPDATE gallery_details SET relative_path = ? WHERE item_id = ?").run("two/Picture 071-001.jpg", "p2");

    const { results, summary } = scan(["GAL"], "files");
    expect(byType(results, "photo_set")).toHaveLength(1);
    expect(summary.separateShots).toBe(0);
  });

  it("keeps a pair sharing a timestamp to the second", () => {
    pair({ takenA: "2008-10-04T17:53:23.000Z", takenB: "2008-10-04T17:53:23.000Z", sizeB: 2_700_000 });
    const { results, summary } = scan(["GAL"], "files");
    expect(byType(results, "photo_set")).toHaveLength(1);
    expect(summary.separateShots).toBe(0);
  });
});

// ── Folders sharing photos ──────────────────────────────────────────────────
//
// The third folder answer, for a partial copy: half a card re-imported, a "best of"
// pulled from several trips. Neither folder equals the other and neither is wholly
// inside it, so both stronger tiers stay silent — and the pair goes on holding the same
// pictures for ever. BOTH FOLDERS STAY: only the shared copies leave one side.

describe("overlapping folders", () => {
  const overlapping = () => {
    // Two shared pictures, and one of its own on each side so neither folder equals
    // nor contains the other.
    asset("a1", "Trip/one.jpg", { hash: "shared-1" });
    asset("a2", "Trip/two.jpg", { hash: "shared-2" });
    asset("a3", "Trip/only-here.jpg", { hash: "trip-only" });
    asset("b1", "Best of/one.jpg", { hash: "shared-1" });
    asset("b2", "Best of/two.jpg", { hash: "shared-2" });
    asset("b3", "Best of/only-there.jpg", { hash: "best-only" });
  };

  it("is found, and offered as an overlap rather than a folder set", () => {
    overlapping();
    const { results } = scan(["GAL"], "folders");
    expect(byType(results, "folder_set")).toHaveLength(0);
    expect(byType(results, "contained")).toHaveLength(0);
    expect(byType(results, "overlap")).toHaveLength(1);
  });

  it("offers only the shared copies, never a folder", () => {
    overlapping();
    const [pair] = byType(scan(["GAL"], "folders").results, "overlap");
    const doomed = pair.members.filter((member) => member.role === "delete");
    // Two shared pictures go from one side. The photo each folder holds alone is not
    // in the result at all.
    expect(doomed).toHaveLength(2);
    expect(doomed.map((member) => member.path.split("/").pop()).sort()).toEqual(["one.jpg", "two.jpg"]);
    expect(pair.members.some((member) => member.path.includes("only-"))).toBe(false);
  });

  it("names the counterpart each doomed copy hands its work to", () => {
    overlapping();
    const [pair] = byType(scan(["GAL"], "folders").results, "overlap");
    const doomed = pair.members.filter((member) => member.role === "delete");
    // Every copy that goes points at the same picture on the other side.
    expect(doomed.every((member) => member.keeperPath !== null)).toBe(true);
    for (const member of doomed) {
      expect(member.keeperPath!.split("/").pop()).toBe(member.path.split("/").pop());
    }
  });

  it("keeps both folders in the result, one keeping and one losing its copies", () => {
    overlapping();
    const [pair] = byType(scan(["GAL"], "folders").results, "overlap");
    expect(pair.folders.map((folder) => folder.role).sort()).toEqual(["delete", "keep"]);
    expect(pair.folders.map((folder) => folder.folderPath).sort()).toEqual(["Best of", "Trip"]);
  });

  // A pair a stronger tier already speaks for is not repeated here as a weaker one.
  it("stays quiet when the folders are identical — that is a folder set", () => {
    asset("a1", "Trip/one.jpg", { hash: "p1" });
    asset("a2", "Trip/two.jpg", { hash: "p2" });
    asset("b1", "Copy/one.jpg", { hash: "p1" });
    asset("b2", "Copy/two.jpg", { hash: "p2" });

    const { results } = scan(["GAL"], "folders");
    expect(byType(results, "folder_set")).toHaveLength(1);
    expect(byType(results, "overlap")).toHaveLength(0);
  });

  it("stays quiet when one folder is wholly stored in the other", () => {
    asset("a1", "Trip/one.jpg", { hash: "p1" });
    asset("a2", "Trip/two.jpg", { hash: "p2" });
    asset("a3", "Trip/three.jpg", { hash: "p3" });
    asset("b1", "Small/one.jpg", { hash: "p1" });
    asset("b2", "Small/two.jpg", { hash: "p2" });

    const { results } = scan(["GAL"], "folders");
    expect(byType(results, "contained")).not.toHaveLength(0);
    expect(byType(results, "overlap")).toHaveLength(0);
  });

  it("needs more than one shared picture to be worth a card", () => {
    asset("a1", "Trip/one.jpg", { hash: "shared" });
    asset("a2", "Trip/own-a.jpg", { hash: "a-only" });
    asset("b1", "Other/one.jpg", { hash: "shared" });
    asset("b2", "Other/own-b.jpg", { hash: "b-only" });

    expect(byType(scan(["GAL"], "folders").results, "overlap")).toHaveLength(0);
  });

  it("never pairs a folder with its own parent — that is the photo tier's business", () => {
    asset("p1", "Photos/x.jpg", { hash: "pic-p1" });
    asset("p2", "Photos/y.jpg", { hash: "pic-p2" });
    asset("q1", "Photos/sub/x.jpg", { hash: "pic-p1" });
    asset("q2", "Photos/sub/y.jpg", { hash: "pic-p2" });
    asset("q3", "Photos/sub/z.jpg", { hash: "pic-p3" });

    expect(byType(scan().results, "overlap")).toHaveLength(0);
  });

  it("keeps the read-only side, whatever else is true", () => {
    db.prepare("UPDATE libraries SET policy_json = ? WHERE id = 'GAL2'").run(EXTERNAL);
    asset("m1", "Mine/one.jpg", { hash: "pic-1" });
    asset("m2", "Mine/two.jpg", { hash: "pic-2" });
    asset("m3", "Mine/extra.jpg", { hash: "pic-m" });
    asset("x1", "Theirs/one.jpg", { hash: "pic-1", library: "GAL2" });
    asset("x2", "Theirs/two.jpg", { hash: "pic-2", library: "GAL2" });
    asset("x3", "Theirs/extra.jpg", { hash: "pic-x", library: "GAL2" });

    const [overlap] = byType(scan(["GAL", "GAL2"]).results, "overlap");
    // Proposing to delete out of a library the app may only read proposes something
    // that cannot happen, so that side always survives — marked 'protected' rather
    // than 'keep', which is the same answer with the reason attached.
    expect(overlap.folders.find((folder) => folder.role === "protected")?.libraryId).toBe("GAL2");
    expect(doomedFolder(overlap)?.libraryId).toBe("GAL");
  });

  it("honours a clear-out instruction when choosing the losing side", () => {
    asset("m1", "Mine/one.jpg", { hash: "pic-1" });
    asset("m2", "Mine/two.jpg", { hash: "pic-2" });
    asset("m3", "Mine/extra.jpg", { hash: "pic-m" });
    asset("x1", "Theirs/one.jpg", { hash: "pic-1" });
    asset("x2", "Theirs/two.jpg", { hash: "pic-2" });
    asset("x3", "Theirs/extra.jpg", { hash: "pic-x" });

    const results = scanWith([{ folderPath: "Mine", mode: "clear" }]).results;
    const [overlap] = byType(results, "overlap");
    expect(doomedFolder(overlap)?.folderPath).toBe("Mine");
    expect(overlap.folders.find((folder) => folder.role === "keep")?.folderPath).toBe("Theirs");
  });

  it("honours a standing 'stop pairing these' decision", () => {
    overlapping();
    // Side A is the lexically smaller (library, path).
    db.prepare(`
      INSERT INTO gallery_duplicate_folder_overlap_ignores (library_a, path_a, library_b, path_b)
      VALUES ('GAL', 'Best of', 'GAL', 'Trip')
    `).run();

    expect(byType(scan(["GAL"], "folders").results, "overlap")).toHaveLength(0);
  });

  it("stays out of a file cleanup, which answers a different question", () => {
    overlapping();
    expect(byType(scan(["GAL"], "files").results, "overlap")).toHaveLength(0);
  });
});

// ── Standing dismissals ─────────────────────────────────────────────────────
//
// "Not the same" writes a record every future scan is meant to honour — the confirm
// dialog and the user guide both promise it, "on this page or the older ones". The job
// snapshot used to consult none of those records, so pressing it and scanning again
// brought the result straight back.

describe("a dismissed result", () => {
  const dismiss = (jobId: string, resultId: string) => {
    const outcome = dismissResult(jobId, "u1", resultId);
    if (!outcome.ok) throw new Error(`dismiss refused: ${outcome.refused}`);
  };

  it("stays gone for a photo set", () => {
    asset("a1", "one/pic.jpg", { hash: "same" });
    asset("a2", "two/pic.jpg", { hash: "same" });

    const first = scan(["GAL"], "files");
    const [set] = byType(first.results, "photo_set");
    dismiss(first.jobId, set.id);

    expect(byType(scan(["GAL"], "files").results, "photo_set")).toHaveLength(0);
  });

  // One dismissal does not shatter a set of three. A and C are still the same bytes,
  // and they stay linked through the copy nobody said anything about.
  it("only breaks a set apart when it truly disconnects it", () => {
    asset("a1", "one/pic.jpg", { hash: "same" });
    asset("a2", "two/pic.jpg", { hash: "same" });
    asset("a3", "three/pic.jpg", { hash: "same" });

    const first = scan(["GAL"], "files");
    const [set] = byType(first.results, "photo_set");
    // Dismiss just one pair out of the three, by hand — dismissResult writes them all.
    const ids = set.members.map((member) => member.itemId).sort();
    db.prepare("INSERT INTO gallery_duplicate_ignores (item_a, item_b) VALUES (?, ?)").run(ids[0], ids[1]);

    const again = byType(scan(["GAL"], "files").results, "photo_set");
    expect(again).toHaveLength(1);
    expect(again[0].members).toHaveLength(3);
  });

  it("stays gone for identical folders", () => {
    asset("a1", "Trip/one.jpg", { hash: "p1" });
    asset("a2", "Trip/two.jpg", { hash: "p2" });
    asset("b1", "Copy/one.jpg", { hash: "p1" });
    asset("b2", "Copy/two.jpg", { hash: "p2" });

    const first = scan(["GAL"], "folders");
    const [set] = byType(first.results, "folder_set");
    dismiss(first.jobId, set.id);

    expect(byType(scan(["GAL"], "folders").results, "folder_set")).toHaveLength(0);
  });

  it("stays gone for a folder stored elsewhere", () => {
    asset("t1", "Trip/one.jpg", { hash: "p1" });
    asset("t2", "Trip/two.jpg", { hash: "p2" });
    asset("t3", "Trip/three.jpg", { hash: "p3" });
    asset("s1", "Small/one.jpg", { hash: "p1" });
    asset("s2", "Small/two.jpg", { hash: "p2" });

    const first = scan(["GAL"], "folders");
    const [set] = byType(first.results, "contained");
    dismiss(first.jobId, set.id);

    expect(byType(scan(["GAL"], "folders").results, "contained")).toHaveLength(0);
  });
});

// ── How sure a result is ────────────────────────────────────────────────────
//
// Two axes, never merged. The case that proves they must stay apart is a
// byte-identical set with nothing to choose between the copies: completely certain
// about the match, completely arbitrary about the keeper.

describe("certainty", () => {
  it("calls a byte-identical set certain", () => {
    asset("a1", "one/pic.jpg", { hash: "same" });
    asset("a2", "two/pic.jpg", { hash: "same" });
    const [set] = byType(scan(["GAL"], "files").results, "photo_set");
    expect(set.matchConfidence).toBe("certain");
  });

  it("says so when the keeper was a coin toss", () => {
    asset("a1", "one/pic.jpg", { hash: "same" });
    asset("a2", "two/pic.jpg", { hash: "same" });
    const [set] = byType(scan(["GAL"], "files").results, "photo_set");
    // Certain about the match, arbitrary about the choice — the pair of answers that
    // one merged label could not express.
    expect(set.matchConfidence).toBe("certain");
    expect(set.keeperConfidence).toBe("tossup");
  });

  it("calls a keeper chosen on your own tags evidence", () => {
    asset("a1", "one/pic.jpg", { hash: "same" });
    asset("a2", "two/pic.jpg", { hash: "same" });
    db.prepare("INSERT INTO tags (id, key, display_name) VALUES ('t1', 'trips', 'Trips')").run();
    db.prepare("INSERT INTO taggables (tag_id, entity_type, entity_id) VALUES ('t1', 'library_item', 'a2')").run();

    const [set] = byType(scan(["GAL"], "files").results, "photo_set");
    expect(set.keeperConfidence).toBe("evidence");
    expect(set.members.find((m) => m.role === "keep")?.path).toBe("two/pic.jpg");
  });

  it("calls a keeper chosen on the file itself a guess", () => {
    asset("a1", "one/pic.jpg", { hash: "same", size: 100 });
    asset("a2", "two/pic.jpg", { hash: "same", size: 900 });
    const [set] = byType(scan(["GAL"], "files").results, "photo_set");
    expect(set.keeperConfidence).toBe("guess");
  });

  // #20's case, from the dev library: 3,318,030 against 3,317,962 bytes at the same
  // dimensions, taken 2h43m apart, three bits of fingerprint apart — and two entirely
  // different photographs.
  it("doubts a near pair whose files agree but whose moments do not", () => {
    asset("n1", "one/pic.jpg", { hash: "a", phash: bits(0), size: 3_318_030 });
    asset("n2", "two/pic.jpg", { hash: "b", phash: bits(3), size: 3_317_962 });
    for (const [id, when] of [["n1", "2008-10-04T20:32:35.000Z"], ["n2", "2008-10-04T17:49:49.000Z"]]) {
      db.prepare("UPDATE gallery_details SET width = 3456, height = 2304, taken_at = ? WHERE item_id = ?")
        .run(when, id);
    }

    const [set] = byType(scan(["GAL"], "files").results, "photo_set");
    expect(set.tier).toBe("near");
    expect(set.matchConfidence).toBe("unsure");
  });

  it("trusts a near pair that looks like a real copy", () => {
    // A messenger's copy: same moment, a fraction of the pixels.
    asset("n1", "one/pic.jpg", { hash: "a", phash: bits(0), size: 3_000_000 });
    asset("n2", "two/pic.jpg", { hash: "b", phash: bits(3), size: 180_000 });
    db.prepare("UPDATE gallery_details SET width = 3120, height = 4160, taken_at = '2015-12-14T17:08:51.000Z' WHERE item_id = 'n1'").run();
    db.prepare("UPDATE gallery_details SET width = 960, height = 1280, taken_at = '2015-12-14T17:08:51.000Z' WHERE item_id = 'n2'").run();

    const [set] = byType(scan(["GAL"], "files").results, "photo_set");
    expect(set.tier).toBe("near");
    expect(set.matchConfidence).toBe("likely");
  });
});
