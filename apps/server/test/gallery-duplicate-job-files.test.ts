// A cleanup end to end, over REAL files on disk.
//
// Everything else about a cleanup is tested against pre-set digests, which is the right
// trade for grouping rules. This suite covers the one part that cannot be: the pass that
// opens files and hashes them. It is the only place that reads a disk, the only place
// that can decide a photo has changed since the catalogue last looked, and the reason a
// first scan is slow — so it needs a test that actually writes bytes.
//
// The pass itself (hashDuplicateCandidates) is shared with the install-wide scan the
// older pages run. This exercises it through the JOB path — Run scan → the worker's two
// phases → the snapshot — which is the path that outlives them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import { createJob, completeJob, activeJob } from "../src/modules/library/gallery/duplicates/jobs.js";
import { startJobScan, listJobResults, type SnapshotResult } from "../src/modules/library/gallery/duplicates/job-scan.js";
import { resolveJobResult, sweepJobResults } from "../src/modules/library/gallery/duplicates/job-resolve.js";
import {
  DUPLICATE_SCAN_JOB_TYPE,
  processDuplicateScanQueue,
  duplicateCandidateCount,
  duplicatePendingCount
} from "../src/modules/library/gallery/duplicates/items.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

let sourceRoot = "";
let secondRoot = "";

/** Write a real file and catalogue it exactly as the library scanner would — size AND
 *  the file's own mtime, so the estimate the wizard quotes lines up with what a scan
 *  really reads. No digest: earning that is the point of the pass under test. */
function file(id: string, relativePath: string, bytes: string, library = "GAL"): void {
  const root = library === "GAL" ? sourceRoot : secondRoot;
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, bytes);
  db.prepare(`
    INSERT INTO library_items (id, library_id, type, folder_path, status, discovered_at)
    VALUES (?, ?, 'gallery', ?, 'ready', '2024-01-01T00:00:00.000Z')
  `).run(id, library, relativePath);
  db.prepare(`
    INSERT INTO gallery_details (item_id, kind, relative_path, size, modified_at)
    VALUES (?, 'photo', ?, ?, ?)
  `).run(id, relativePath, Buffer.byteLength(bytes), new Date(fs.statSync(absolutePath).mtimeMs).toISOString());
}

const hashOf = (id: string): string | null =>
  (db.prepare("SELECT content_hash FROM gallery_details WHERE item_id = ?").get(id) as { content_hash: string | null })
    .content_hash;

/** What the last pass actually read, off the queue row the worker wrote. */
function lastPass(): { hashed: number; stale: number } {
  const row = db.prepare(`
    SELECT payload FROM jobs WHERE type = ? AND status = 'completed'
    ORDER BY rowid DESC LIMIT 1
  `).get(DUPLICATE_SCAN_JOB_TYPE) as { payload: string } | undefined;
  const result = row ? (JSON.parse(row.payload) as { result?: { hashed?: number; stale?: number } }).result : undefined;
  return { hashed: result?.hashed ?? 0, stale: result?.stale ?? 0 };
}

/** Press Run scan and let the worker finish: queue a fingerprint pass over the job's
 *  libraries, then snapshot. Retires whatever the previous call left open, since only
 *  one cleanup may be active at a time. */
async function cleanup(libraries = ["GAL"], duplicateType: "folders" | "files" = "files") {
  const open = activeJob();
  if (open) completeJob(open.id, "u1", true);
  const created = createJob({ ownerUserId: "u1", libraryIds: libraries, duplicateType });
  if (!created.ok) throw new Error(`job refused: ${created.refused}`);
  const started = startJobScan(created.job.id, "u1");
  if (!started.ok) throw new Error(`scan refused: ${started.refused}`);
  await processDuplicateScanQueue();
  return { jobId: created.job.id, results: listJobResults(created.job.id) };
}

const photoSets = (results: SnapshotResult[]) => results.filter((result) => result.type === "photo_set");

beforeEach(() => {
  resetDb();
  // resetDb leaves `jobs` alone, and this suite lives in that queue: a pending row from
  // the last test is another pass the worker would run before the one under test.
  db.prepare("DELETE FROM jobs").run();

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-files-"));
  sourceRoot = path.join(base, "library");
  secondRoot = path.join(base, "second");
  const thumbRoot = path.join(base, "thumbs");
  for (const dir of [sourceRoot, secondRoot, thumbRoot]) fs.mkdirSync(dir);

  makeUser("u1", "admin");
  db.prepare("INSERT OR REPLACE INTO storage_roots (id, name, path, created_by) VALUES ('sr1', 'test', ?, 'u1')").run(base);
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(thumbnailPathSettingKey, thumbRoot);
  makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
  makeLibrary("GAL2", { createdBy: "u1", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
  grant("group", EVERYONE_GROUP_ID, "GAL2", "member");
  db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'GAL'").run(sourceRoot);
  db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'GAL2'").run(secondRoot);
});

describe("what a cleanup's scan reads off the disk", () => {
  it("opens only the photos whose size collides with another, and groups the identical ones", async () => {
    file("a", "a.jpg", "PICTURE-ONE");
    file("b", "b.jpg", "PICTURE-ONE"); // same bytes as a
    file("c", "c.jpg", "PICTURE-TWO"); // same size as a and b, different bytes
    file("solo", "solo.jpg", "A MUCH LONGER PICTURE PAYLOAD");

    const { results } = await cleanup();

    // a, b and c collide on size so all three are read; 'solo' is provably unique and
    // is never opened — which is what keeps a first scan off most of a library.
    expect(lastPass().hashed).toBe(3);
    expect(hashOf("solo")).toBeNull();

    const sets = photoSets(results);
    expect(sets).toHaveLength(1);
    expect(sets[0].members.map((member) => member.itemId).sort()).toEqual(["a", "b"]);
  });

  // The size gate is deliberately global while the hashing is scoped: a photo's only
  // twin is very often in a library this cleanup does not cover, and narrowing the gate
  // would silently stop finding those pairs. See decision 4 in the plan.
  it("reads only the cleanup's own libraries, and leaves the rest unhashed", async () => {
    file("a", "a.jpg", "PICTURE-ONE");
    file("b", "b.jpg", "PICTURE-ONE", "GAL2");

    await cleanup(["GAL"]);

    expect(lastPass().hashed).toBe(1);
    expect(hashOf("a")).not.toBeNull();
    expect(hashOf("b")).toBeNull();
  });

  it("still pairs across libraries once both have been read", async () => {
    file("a", "a.jpg", "PICTURE-ONE");
    file("b", "b.jpg", "PICTURE-ONE", "GAL2");

    const { results } = await cleanup(["GAL", "GAL2"]);

    expect(lastPass().hashed).toBe(2);
    expect(photoSets(results)[0].members.map((member) => member.itemId).sort()).toEqual(["a", "b"]);
  });

  it("counts the cost of a scan before it runs, so the wizard can quote it", async () => {
    file("a", "a.jpg", "PICTURE-ONE");
    file("b", "b.jpg", "PICTURE-ONE");
    file("solo", "solo.jpg", "SOMETHING ELSE ENTIRELY", "GAL2");

    // Two photos worth checking, both still to be read.
    expect(duplicateCandidateCount("GAL")).toBe(2);
    expect(duplicatePendingCount("GAL")).toBe(2);
    expect(duplicateCandidateCount("GAL2")).toBe(0);

    await cleanup(["GAL"]);

    // Read once, they cost nothing to scan again.
    expect(duplicateCandidateCount("GAL")).toBe(2);
    expect(duplicatePendingCount("GAL")).toBe(0);
  });

  // The catalogue's modified_at only moves when a LIBRARY scan notices a change. If the
  // cleanup trusted it, a photo edited between library scans would keep a digest of
  // bytes that no longer exist — and stay grouped with a photo it no longer matches.
  it("re-reads a file edited in place, with no library rescan in between", async () => {
    file("a", "a.jpg", "PICTURE-ONE");
    file("b", "b.jpg", "PICTURE-ONE");
    expect(photoSets((await cleanup()).results)).toHaveLength(1);

    // Edit 'b' to different content of the SAME length and leave the catalogue alone —
    // exactly what a library scan would not have noticed yet.
    fs.writeFileSync(path.join(sourceRoot, "b.jpg"), "PICTURE-TWO");
    fs.utimesSync(path.join(sourceRoot, "b.jpg"), new Date(), new Date(Date.now() + 1000));

    const { results } = await cleanup();
    expect(lastPass().hashed).toBe(1); // only 'b' was re-read
    expect(lastPass().stale).toBe(0);  // same size, so nothing is out of step
    expect(photoSets(results)).toHaveLength(0);
  });

  it("skips a file whose size no longer matches the catalogue, and drops its digest", async () => {
    file("a", "a.jpg", "PICTURE-ONE");
    file("b", "b.jpg", "PICTURE-ONE");
    expect(photoSets((await cleanup()).results)).toHaveLength(1);

    // 'b' grows on disk. The catalogued size is what put it in the candidate set, so
    // that premise is now wrong and its digest cannot be trusted either.
    fs.writeFileSync(path.join(sourceRoot, "b.jpg"), "PICTURE-TWO-BUT-MUCH-LONGER");

    const { results } = await cleanup();
    expect(lastPass().stale).toBe(1);
    expect(lastPass().hashed).toBe(0);
    expect(hashOf("b")).toBeNull();
    expect(photoSets(results)).toHaveLength(0);
  });

  it("leaves an untouched file alone rather than re-reading it", async () => {
    file("a", "a.jpg", "PICTURE-ONE");
    file("b", "b.jpg", "PICTURE-ONE");
    await cleanup();
    expect(lastPass().hashed).toBe(2);

    // Nothing changed on disk, so the second cleanup reads nothing at all and still
    // finds the pair.
    const { results } = await cleanup();
    expect(lastPass().hashed).toBe(0);
    expect(photoSets(results)).toHaveLength(1);
  });
});

describe("what a cleanup does to the disk", () => {
  it("keeps the copy carrying your work, takes its tags, and bins the other", async () => {
    file("a", "a.jpg", "PICTURE-ONE");
    file("b", "b.jpg", "PICTURE-ONE");
    // 'b' carries user work, so it should win despite 'a' sorting first.
    db.prepare("INSERT INTO tags (id, key, display_name) VALUES ('t1', 'lake', 'Lake')").run();
    db.prepare("INSERT INTO taggables (tag_id, entity_type, entity_id) VALUES ('t1', 'library_item', 'b')").run();

    const { jobId, results } = await cleanup();
    const set = photoSets(results)[0];
    expect(set.members.find((member) => member.role === "keep")?.itemId).toBe("b");

    const outcome = resolveJobResult(jobId, "u1", set.id);
    expect(outcome.ok).toBe(true);

    // The kept copy still holds the tag, the losing row is gone from the catalogue, and
    // its file has left the library folder for the Recycle Bin.
    expect(db.prepare("SELECT 1 FROM taggables WHERE tag_id='t1' AND entity_id='b'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM library_items WHERE id='a'").get()).toBeUndefined();
    expect(fs.existsSync(path.join(sourceRoot, "a.jpg"))).toBe(false);
    expect(fs.existsSync(path.join(sourceRoot, "b.jpg"))).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM trashed_items").get()).toEqual({ n: 1 });
  });

  it("bins the removal as a cleanup, not as a hand delete", async () => {
    file("a", "a.jpg", "PICTURE-ONE");
    file("b", "b.jpg", "PICTURE-ONE");

    const { jobId, results } = await cleanup();
    expect(resolveJobResult(jobId, "u1", photoSets(results)[0].id).ok).toBe(true);

    // Which decides how long it is kept, and lets the bin tell a cleanup's rows from
    // the handful someone deleted themselves.
    expect(db.prepare("SELECT source FROM trashed_items").get()).toEqual({ source: "duplicate_cleanup" });
  });

  it("does not carry a face box from a smaller copy onto the one that survives", async () => {
    file("big", "big.jpg", "PICTURE-ORIGINAL");
    file("small", "small.jpg", "PICTURE-ORIGINAL");
    db.prepare("UPDATE gallery_details SET width = 4000, height = 3000 WHERE item_id = 'big'").run();
    db.prepare("UPDATE gallery_details SET width = 800, height = 600 WHERE item_id = 'small'").run();
    db.prepare("INSERT INTO gallery_people (id, name) VALUES ('p1', 'Mum')").run();
    db.prepare("INSERT INTO gallery_faces (id, item_id, person_id, box_x) VALUES ('f1', 'small', 'p1', 0.25)").run();

    const { jobId, results } = await cleanup();
    const set = photoSets(results)[0];
    // The face makes 'small' the keeper, so aim the deletion the other way round: the
    // face row then sits on the copy being removed, which is the case that must not
    // carry over — a box normalised against 800x600 does not fit 4000x3000.
    const doomed = set.members.find((member) => member.role === "delete")!;
    expect(doomed.itemId).toBe("big");

    expect(resolveJobResult(jobId, "u1", set.id).ok).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM gallery_faces WHERE item_id = 'small'").get()).toEqual({ n: 1 });
    expect(fs.existsSync(path.join(sourceRoot, "big.jpg"))).toBe(false);
    expect(fs.existsSync(path.join(sourceRoot, "small.jpg"))).toBe(true);
  });

  it("sweeps every identical set at once, leaving one copy of each on disk", async () => {
    file("a1", "a1.jpg", "SET-ONE");
    file("a2", "a2.jpg", "SET-ONE");
    file("b1", "b1.jpg", "SET-TWO-LONGER");
    file("b2", "b2.jpg", "SET-TWO-LONGER");

    const { jobId, results } = await cleanup();
    expect(photoSets(results)).toHaveLength(2);

    const swept = sweepJobResults(jobId, "u1", {});
    expect(swept.ok).toBe(true);
    // JobOutcome names its payload `job` whatever the payload is — here, the sweep totals.
    if (swept.ok) expect(swept.job).toMatchObject({ results: 2, deleted: 2, failed: 0 });

    // One survivor per set, and both losers are in the bin rather than gone.
    const left = ["a1", "a2", "b1", "b2"].filter((id) => fs.existsSync(path.join(sourceRoot, `${id}.jpg`)));
    expect(left).toHaveLength(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM trashed_items").get()).toEqual({ n: 2 });
  });

  it("refuses the lot when a photo has changed since the scan", async () => {
    file("a", "a.jpg", "PICTURE-ONE");
    file("b", "b.jpg", "PICTURE-ONE");
    const { jobId, results } = await cleanup();
    const set = photoSets(results)[0];

    // Re-saved between the scan and the confirmation — the premise the set was built
    // on is gone, so nothing at all is removed.
    fs.writeFileSync(path.join(sourceRoot, "a.jpg"), "PICTURE-CHANGED");
    db.prepare("UPDATE gallery_details SET size = 15 WHERE item_id = 'a'").run();

    const outcome = resolveJobResult(jobId, "u1", set.id);
    expect(outcome.ok).toBe(false);
    expect(fs.existsSync(path.join(sourceRoot, "a.jpg"))).toBe(true);
    expect(fs.existsSync(path.join(sourceRoot, "b.jpg"))).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM trashed_items").get()).toEqual({ n: 0 });
  });
});
