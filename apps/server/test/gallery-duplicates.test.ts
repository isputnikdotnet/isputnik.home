// Duplicate photo detection, tier 1 (byte-identical files). Covers the size gate that
// keeps the scan off the disk, the grouping rules, keeper choice, and the metadata
// absorption that has to happen before a copy is trashed. The trash step itself is not
// exercised (that's trashBook's own suite); resolveDuplicateGroup is tested through its
// re-validation guards, which run before anything is removed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { galleryDuplicateRoutesPlugin } from "../src/modules/library/gallery/duplicate-routes.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import {
  duplicateCandidateCount,
  rebuildExactDuplicateGroups,
  rebuildDuplicateGroups,
  NEAR_IDENTICAL_DISTANCE,
  runDuplicateScan,
  listDuplicateGroups,
  setDuplicateKeeper,
  ignoreDuplicateGroup,
  resolveDuplicateGroup,
  resolveDuplicateSelection,
  resolveAllExactGroups,
  duplicateScanStatus,
  duplicateLibraryOptions,
  absorbDuplicateMetadata,
  pickKeeper
} from "../src/modules/library/gallery/duplicates.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

interface AssetOpts {
  library?: string;
  size?: number;
  hash?: string | null;
  phash?: string | null;
  kind?: string;
  width?: number;
  height?: number;
  takenAt?: string | null;
  takenAtSource?: string;
  cameraMake?: string | null;
  deleted?: boolean;
  status?: string;
  discoveredAt?: string;
}

// A ready gallery asset with a pre-set content digest — the state the hashing pass
// leaves behind, so grouping can be tested without touching a filesystem.
function asset(id: string, relativePath: string, opts: AssetOpts = {}): string {
  const {
    library = "GAL", size = 1000, hash = "h1", phash = null, kind = "photo",
    width = 4000, height = 3000,
    takenAt = "2024-05-01T10:00:00.000Z", takenAtSource = "scan", cameraMake = "Canon",
    deleted = false, status = "ready", discoveredAt = "2024-01-01T00:00:00.000Z"
  } = opts;
  db.prepare(`
    INSERT INTO library_items (id, library_id, type, folder_path, status, deleted_at, discovered_at)
    VALUES (?, ?, 'gallery', ?, ?, ?, ?)
  `).run(id, library, relativePath, status, deleted ? new Date().toISOString() : null, discoveredAt);
  db.prepare(`
    INSERT INTO gallery_details
      (item_id, kind, relative_path, size, width, height, taken_at, taken_at_source,
       camera_make, content_hash, content_hash_at, modified_at, phash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'm1', 'm1', ?)
  `).run(id, kind, relativePath, size, width, height, takenAt, takenAtSource, cameraMake, hash, phash);
  return id;
}

// A 64-bit dHash as 16 hex chars, with the given bit positions set. Bit 0-15 land in
// band 3, 16-31 in band 2, 32-47 in band 1, 48-63 in band 0 — which is what makes it
// possible to aim a difference at specific bands.
function fingerprint(...bits: number[]): string {
  let value = 0n;
  for (const bit of bits) value |= 1n << BigInt(bit);
  return value.toString(16).padStart(16, "0");
}

const groupsByMembers = () =>
  listDuplicateGroups().map((g) => ({
    keeper: g.keeperItemId,
    members: g.members.map((m) => m.itemId).sort(),
    reclaimable: g.reclaimableBytes
  }));

beforeEach(() => {
  resetDb();
  db.prepare("DELETE FROM jobs").run();
  makeUser("u1", "admin");
  makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
  makeLibrary("GAL2", { createdBy: "u1", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
  grant("group", EVERYONE_GROUP_ID, "GAL2", "member");
});

describe("size gate", () => {
  it("only considers assets whose byte size collides with another asset", () => {
    asset("a", "a.jpg", { size: 1000 });
    asset("b", "b.jpg", { size: 1000 });
    asset("unique", "unique.jpg", { size: 4242 });
    expect(duplicateCandidateCount()).toBe(2);
  });

  it("ignores tombstoned and not-yet-ready assets", () => {
    asset("a", "a.jpg", { size: 1000 });
    asset("gone", "gone.jpg", { size: 1000, deleted: true });
    asset("pending", "pending.jpg", { size: 1000, status: "pending" });
    // Only 'a' is live at that size, so nothing collides any more.
    expect(duplicateCandidateCount()).toBe(0);
  });
});

describe("exact grouping", () => {
  it("groups identical digests and spans libraries", () => {
    asset("a", "a.jpg", { hash: "same" });
    asset("b", "photos/b.jpg", { hash: "same", library: "GAL2" });
    asset("c", "c.jpg", { hash: "other" });

    const summary = rebuildExactDuplicateGroups();
    expect(summary.groups).toBe(1);
    expect(summary.extraCopies).toBe(1);
    expect(summary.reclaimableBytes).toBe(1000);
    expect(groupsByMembers()).toEqual([{ keeper: "a", members: ["a", "b"], reclaimable: 1000 }]);
  });

  it("never groups same-name siblings that differ in content (RAW + JPEG)", () => {
    // A camera writes IMG_1234.CR2 and IMG_1234.JPG side by side. Same basename, and a
    // name-based detector would pair them; different bytes, so this one must not.
    asset("raw", "IMG_1234.CR2", { size: 5000, hash: "raw-bytes" });
    asset("jpg", "IMG_1234.JPG", { size: 5000, hash: "jpg-bytes" });
    expect(rebuildExactDuplicateGroups().groups).toBe(0);
  });

  it("leaves an unhashed asset out of every group", () => {
    asset("a", "a.jpg", { hash: "same" });
    asset("b", "b.jpg", { hash: "same" });
    asset("c", "c.jpg", { hash: null });
    expect(groupsByMembers()).toEqual([]);
    rebuildExactDuplicateGroups();
    expect(groupsByMembers()[0].members).toEqual(["a", "b"]);
  });

  it("rebuilds from scratch, so a resolved copy disappears from the results", () => {
    asset("a", "a.jpg", { hash: "same" });
    asset("b", "b.jpg", { hash: "same" });
    rebuildExactDuplicateGroups();
    expect(listDuplicateGroups()).toHaveLength(1);

    db.prepare("DELETE FROM library_items WHERE id = 'b'").run();
    rebuildExactDuplicateGroups();
    expect(listDuplicateGroups()).toEqual([]);
  });
});

describe("near-identical grouping", () => {
  // Distinct digests throughout, so nothing here is caught by the exact tier instead.
  const photo = (id: string, phash: string, opts: AssetOpts = {}) =>
    asset(id, `${id}.jpg`, { hash: `h-${id}`, phash, ...opts });

  const nearGroups = () =>
    listDuplicateGroups().filter((g) => g.kind === "near").map((g) => g.members.map((m) => m.itemId).sort());

  it("groups a re-encoded copy but leaves a different picture alone", () => {
    photo("original", fingerprint(1, 2, 3, 40, 41));
    photo("resized", fingerprint(1, 2, 3, 40));            // 1 bit away
    photo("different", fingerprint(4, 5, 6, 7, 8, 9, 10)); // far away

    rebuildDuplicateGroups();
    expect(nearGroups()).toEqual([["original", "resized"]]);
  });

  it("finds a pair whose 3 differing bits are spread across three bands", () => {
    // The tightest case the band index has to survive: 3 bits in 3 different bands
    // leaves exactly one band untouched, which is the whole pigeonhole argument.
    photo("a", fingerprint(0, 16, 32));
    photo("b", fingerprint());

    rebuildDuplicateGroups();
    expect(nearGroups()).toEqual([["a", "b"]]);
  });

  it("stops at the threshold — a 4-bit difference is a different photo", () => {
    // One bit in every band: no band survives untouched, which is exactly why the
    // 4-band index is only exact up to 3. Raising this constant without adding bands
    // would start missing pairs silently — hence the guard.
    expect(NEAR_IDENTICAL_DISTANCE).toBe(3);
    photo("a", fingerprint(0, 16, 32, 48));
    photo("b", fingerprint());

    rebuildDuplicateGroups();
    expect(nearGroups()).toEqual([]);
  });

  it("records each copy's distance from the one being kept", () => {
    photo("keeper", fingerprint(1, 2), { width: 4000, height: 3000 });
    photo("close", fingerprint(1, 2, 3), { width: 800, height: 600 });
    photo("closer", fingerprint(1, 2), { width: 1600, height: 1200 });

    rebuildDuplicateGroups();
    const group = listDuplicateGroups().find((g) => g.kind === "near")!;
    expect(group.keeperItemId).toBe("keeper"); // highest resolution wins
    const distances = db.prepare(
      "SELECT item_id, distance FROM gallery_duplicate_members WHERE group_id = ? ORDER BY item_id"
    ).all(group.id) as { item_id: string; distance: number }[];
    expect(distances).toEqual([
      { item_id: "close", distance: 1 },
      { item_id: "closer", distance: 0 },
      { item_id: "keeper", distance: 0 }
    ]);
  });

  it("never groups videos — they have no fingerprint", () => {
    photo("photo1", fingerprint(1, 2));
    asset("video1", "video1.mp4", { hash: "h-v1", phash: null, kind: "video" });
    asset("video2", "video2.mp4", { hash: "h-v2", phash: null, kind: "video" });

    rebuildDuplicateGroups();
    expect(nearGroups()).toEqual([]);
  });

  it("lets an identical set take part through its keeper only", () => {
    // 'twinA'/'twinB' are byte-identical; 'resized' is a smaller copy of the same shot.
    // The near set should pair the resized copy with the kept twin, not list all three.
    asset("twinA", "twinA.jpg", { hash: "same", phash: fingerprint(1, 2), width: 4000, height: 3000 });
    asset("twinB", "twinB.jpg", { hash: "same", phash: fingerprint(1, 2), width: 4000, height: 3000 });
    photo("resized", fingerprint(1, 2, 3), { width: 800, height: 600 });

    rebuildDuplicateGroups();
    const exact = listDuplicateGroups().find((g) => g.kind === "exact")!;
    expect(exact.members.map((m) => m.itemId).sort()).toEqual(["twinA", "twinB"]);
    expect(nearGroups()).toEqual([[exact.keeperItemId!, "resized"].sort()]);
  });

  it("keeps a dismissed pair apart", () => {
    photo("a", fingerprint(1, 2));
    photo("b", fingerprint(1, 2, 3));
    rebuildDuplicateGroups();
    expect(nearGroups()).toHaveLength(1);

    ignoreDuplicateGroup(listDuplicateGroups().find((g) => g.kind === "near")!.id);
    rebuildDuplicateGroups();
    expect(nearGroups()).toEqual([]);
  });

  it("absorbing a near-identical copy moves tags but NOT faces", () => {
    // A resized copy's face boxes are normalised against different pixels, so carrying
    // them over would land a box in the wrong place. Tags and albums have no such
    // problem. (Tier 1 does move faces — covered under "metadata absorption".)
    photo("keeper", fingerprint(1, 2), { width: 4000, height: 3000 });
    photo("small", fingerprint(1, 2, 3), { width: 800, height: 600 });
    db.prepare("INSERT INTO tags (id, key, display_name) VALUES ('t1', 'lake', 'Lake')").run();
    db.prepare("INSERT INTO taggables (tag_id, entity_type, entity_id) VALUES ('t1', 'library_item', 'small')").run();
    db.prepare("INSERT INTO gallery_people (id, name) VALUES ('p1', 'Mum')").run();
    db.prepare("INSERT INTO gallery_faces (id, item_id, person_id, box_x) VALUES ('f1', 'small', 'p1', 0.25)").run();

    absorbDuplicateMetadata("keeper", ["small"], { moveFaces: false });

    expect(db.prepare("SELECT 1 FROM taggables WHERE tag_id='t1' AND entity_id='keeper'").get()).toBeTruthy();
    expect(db.prepare("SELECT COUNT(*) AS n FROM gallery_faces WHERE item_id='keeper'").get()).toEqual({ n: 0 });
  });

  it("hands the keeper vote to whichever copy carries the tagging work", () => {
    // Deliberate: the small copy wins despite being lower resolution, because tags and
    // faces can't be recovered from the file and pixels can.
    photo("big", fingerprint(1, 2), { width: 4000, height: 3000 });
    photo("small", fingerprint(1, 2, 3), { width: 800, height: 600 });
    db.prepare("INSERT INTO tags (id, key, display_name) VALUES ('t1', 'lake', 'Lake')").run();
    db.prepare("INSERT INTO taggables (tag_id, entity_type, entity_id) VALUES ('t1', 'library_item', 'small')").run();

    rebuildDuplicateGroups();
    expect(listDuplicateGroups().find((g) => g.kind === "near")!.keeperItemId).toBe("small");
  });

  it("refuses to resolve when a fingerprint has drifted out of range", () => {
    photo("a", fingerprint(1, 2), { width: 4000, height: 3000 });
    photo("b", fingerprint(1, 2, 3), { width: 800, height: 600 });
    rebuildDuplicateGroups();
    const group = listDuplicateGroups().find((g) => g.kind === "near")!;

    // The photo was re-edited between the scan and the click.
    db.prepare("UPDATE gallery_details SET phash = ? WHERE item_id = 'b'").run(fingerprint(20, 21, 22, 23, 24));

    expect(resolveDuplicateGroup(group.id, "u1")).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM library_items").get()).toEqual({ n: 2 });
  });
});

describe("dismissed pairs", () => {
  it("keeps a dismissed pair apart on every later scan", () => {
    asset("a", "a.jpg", { hash: "same" });
    asset("b", "b.jpg", { hash: "same" });
    rebuildExactDuplicateGroups();

    expect(ignoreDuplicateGroup(listDuplicateGroups()[0].id)).toBe(true);
    expect(listDuplicateGroups()).toEqual([]);

    rebuildExactDuplicateGroups();
    expect(listDuplicateGroups()).toEqual([]);
  });

  it("still links three identical copies when only one pair was dismissed", () => {
    asset("a", "a.jpg", { hash: "same" });
    asset("b", "b.jpg", { hash: "same" });
    asset("c", "c.jpg", { hash: "same" });
    db.prepare("INSERT INTO gallery_duplicate_ignores (item_a, item_b) VALUES ('a', 'b')").run();

    rebuildExactDuplicateGroups();
    // a—c and b—c survive, so the set stays connected: they really are the same bytes.
    expect(groupsByMembers()[0].members).toEqual(["a", "b", "c"]);
  });
});

describe("keeper choice", () => {
  const detail = (id: string) => ({
    item_id: id, library_id: "GAL", library_name: "GAL", relative_path: `${id}.jpg`,
    discovered_at: "2024-01-01T00:00:00.000Z", size: 1000, width: 4000, height: 3000,
    taken_at: "2024-05-01T10:00:00.000Z", taken_at_source: "scan", gps_source: "scan",
    camera_make: "Canon", camera_model: null, content_hash: "same", title: null,
    metadata_source: null, cover_storage_key: null, face_count: 0, album_count: 0,
    slideshow_count: 0, collection_count: 0, tag_count: 0, save_count: 0, share_count: 0,
    ft_person_count: 0, ft_event_count: 0
  });

  it("user work outranks every property of the file", () => {
    const plain = { ...detail("plain"), width: 6000, height: 4000, size: 9999 };
    const tagged = { ...detail("tagged"), tag_count: 1 };
    // 'plain' is bigger and higher-resolution, but 'tagged' carries work that can't be
    // recovered from the file.
    expect(pickKeeper([plain, tagged])?.keeperId).toBe("tagged");
  });

  it("prefers the original over a file-manager copy", () => {
    const original = detail("original");
    const copy = { ...detail("copy"), relative_path: "IMG_1234 (1).jpg" };
    const choice = pickKeeper([copy, original]);
    expect(choice?.keeperId).toBe("original");
    expect(choice?.reason).toContain("not a copy");
  });

  it("prefers an original folder over a received one", () => {
    const camera = { ...detail("camera"), relative_path: "Camera/IMG_1.jpg" };
    const received = { ...detail("received"), relative_path: "WhatsApp Images/IMG_1.jpg" };
    expect(pickKeeper([received, camera])?.keeperId).toBe("camera");
  });

  it("falls back to the copy added first, deterministically", () => {
    const older = { ...detail("zzz"), discovered_at: "2023-01-01T00:00:00.000Z" };
    const newer = { ...detail("aaa"), discovered_at: "2025-01-01T00:00:00.000Z" };
    const choice = pickKeeper([newer, older]);
    expect(choice?.keeperId).toBe("zzz");
    expect(choice?.reason).toContain("added first");
  });

  it("carries a hand-picked keeper across a rebuild", () => {
    asset("a", "a.jpg", { hash: "same" });
    asset("b", "b.jpg", { hash: "same" });
    rebuildExactDuplicateGroups();
    const group = listDuplicateGroups()[0];
    expect(group.keeperItemId).toBe("a");

    expect(setDuplicateKeeper(group.id, "b")).toBe(true);
    rebuildExactDuplicateGroups();
    const after = listDuplicateGroups()[0];
    expect(after.keeperItemId).toBe("b");
    expect(after.keeperSource).toBe("manual");
  });

  it("drops a hand-picked keeper when the member set changes", () => {
    asset("a", "a.jpg", { hash: "same" });
    asset("b", "b.jpg", { hash: "same" });
    rebuildExactDuplicateGroups();
    setDuplicateKeeper(listDuplicateGroups()[0].id, "b");

    // A third copy turns up: the earlier choice was made about a different question.
    asset("c", "c.jpg", { hash: "same" });
    rebuildExactDuplicateGroups();
    const after = listDuplicateGroups()[0];
    expect(after.members).toHaveLength(3);
    expect(after.keeperSource).toBe("auto");
  });
});

describe("metadata absorption", () => {
  it("moves tags, albums and collections onto the kept copy", () => {
    asset("keep", "keep.jpg", { hash: "same" });
    asset("dup", "dup.jpg", { hash: "same" });

    db.prepare("INSERT INTO tags (id, key, display_name) VALUES ('t1', 'beach', 'Beach')").run();
    db.prepare("INSERT INTO taggables (tag_id, entity_type, entity_id) VALUES ('t1', 'library_item', 'dup')").run();
    db.prepare("INSERT INTO gallery_albums (id, name, created_by) VALUES ('al1', 'Trip', 'u1')").run();
    db.prepare("INSERT INTO gallery_album_items (album_id, item_id, position) VALUES ('al1', 'dup', 1)").run();
    db.prepare("INSERT INTO collections (id, user_id, name) VALUES ('c1', 'u1', 'Best')").run();
    db.prepare("INSERT INTO collection_items (id, collection_id, entity_type, entity_id, position) VALUES ('ci1', 'c1', 'library_item', 'dup', 1)").run();

    absorbDuplicateMetadata("keep", ["dup"]);

    expect(db.prepare("SELECT 1 FROM taggables WHERE tag_id='t1' AND entity_id='keep'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM gallery_album_items WHERE album_id='al1' AND item_id='keep'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM collection_items WHERE collection_id='c1' AND entity_id='keep'").get()).toBeTruthy();
  });

  it("puts the kept copy in both albums when the copies were filed separately", () => {
    asset("keep", "keep.jpg", { hash: "same" });
    asset("dup", "dup.jpg", { hash: "same" });
    db.prepare("INSERT INTO gallery_albums (id, name, created_by) VALUES ('al1', 'A', 'u1'), ('al2', 'B', 'u1')").run();
    db.prepare("INSERT INTO gallery_album_items (album_id, item_id, position) VALUES ('al1', 'keep', 1), ('al2', 'dup', 1)").run();

    absorbDuplicateMetadata("keep", ["dup"]);

    const albums = (db.prepare("SELECT album_id FROM gallery_album_items WHERE item_id = 'keep' ORDER BY album_id")
      .all() as { album_id: string }[]).map((r) => r.album_id);
    expect(albums).toEqual(["al1", "al2"]);
  });

  it("repoints an album cover that pointed at a removed copy", () => {
    asset("keep", "keep.jpg", { hash: "same" });
    asset("dup", "dup.jpg", { hash: "same" });
    db.prepare("INSERT INTO gallery_albums (id, name, cover_item_id, created_by) VALUES ('al1', 'A', 'dup', 'u1')").run();

    absorbDuplicateMetadata("keep", ["dup"]);

    const album = db.prepare("SELECT cover_item_id FROM gallery_albums WHERE id = 'al1'").get() as { cover_item_id: string };
    expect(album.cover_item_id).toBe("keep");
  });

  it("takes hand-edited details only when the kept copy has none of its own", () => {
    asset("keep", "keep.jpg", { hash: "same" });
    asset("dup", "dup.jpg", { hash: "same" });
    db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES ('dup', 'manual', 'Grandma at the lake')").run();
    db.prepare("UPDATE gallery_details SET taken_at = '1975-06-01T00:00:00.000Z', taken_at_source = 'manual' WHERE item_id = 'dup'").run();

    absorbDuplicateMetadata("keep", ["dup"]);

    const meta = db.prepare("SELECT source, title FROM item_metadata WHERE item_id = 'keep'").get() as { source: string; title: string };
    expect(meta).toEqual({ source: "manual", title: "Grandma at the lake" });
    const details = db.prepare("SELECT taken_at, taken_at_source FROM gallery_details WHERE item_id = 'keep'").get() as { taken_at: string; taken_at_source: string };
    expect(details.taken_at_source).toBe("manual");
    expect(details.taken_at).toBe("1975-06-01T00:00:00.000Z");
  });

  it("never overwrites the kept copy's own hand-edited title", () => {
    asset("keep", "keep.jpg", { hash: "same" });
    asset("dup", "dup.jpg", { hash: "same" });
    db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES ('keep', 'manual', 'Mine')").run();
    db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES ('dup', 'manual', 'Theirs')").run();

    absorbDuplicateMetadata("keep", ["dup"]);

    const meta = db.prepare("SELECT title FROM item_metadata WHERE item_id = 'keep'").get() as { title: string };
    expect(meta.title).toBe("Mine");
  });

  it("takes one face per person instead of stacking identical detections", () => {
    asset("keep", "keep.jpg", { hash: "same" });
    asset("d1", "d1.jpg", { hash: "same" });
    asset("d2", "d2.jpg", { hash: "same" });
    db.prepare("INSERT INTO gallery_people (id, name) VALUES ('p1', 'Mum'), ('p2', 'Dad')").run();
    db.prepare("INSERT INTO gallery_faces (id, item_id, person_id) VALUES ('f0', 'keep', 'p1')").run();
    // Both copies were scanned independently and found the same two people.
    db.prepare("INSERT INTO gallery_faces (id, item_id, person_id) VALUES ('f1', 'd1', 'p1'), ('f2', 'd1', 'p2'), ('f3', 'd2', 'p1'), ('f4', 'd2', 'p2')").run();

    absorbDuplicateMetadata("keep", ["d1", "d2"]);

    const people = (db.prepare("SELECT person_id FROM gallery_faces WHERE item_id = 'keep' ORDER BY person_id")
      .all() as { person_id: string }[]).map((r) => r.person_id);
    expect(people).toEqual(["p1", "p2"]); // p1 not duplicated, p2 taken once
  });

  it("takes a whole face set from one copy when the kept copy was never scanned", () => {
    asset("keep", "keep.jpg", { hash: "same" });
    asset("d1", "d1.jpg", { hash: "same" });
    asset("d2", "d2.jpg", { hash: "same" });
    db.prepare("INSERT INTO gallery_people (id, name) VALUES ('p1', 'Mum')").run();
    db.prepare("INSERT INTO gallery_faces (id, item_id, person_id) VALUES ('f1', 'd1', 'p1'), ('f2', 'd1', NULL)").run();
    db.prepare("INSERT INTO gallery_faces (id, item_id, person_id) VALUES ('f3', 'd2', 'p1')").run();

    absorbDuplicateMetadata("keep", ["d1", "d2"]);

    // The richest single donor (d1) moves wholesale, including its unnamed face; d2's
    // redundant copy is left to cascade away.
    const ids = (db.prepare("SELECT id FROM gallery_faces WHERE item_id = 'keep' ORDER BY id")
      .all() as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(["f1", "f2"]);
  });
});

describe("resolving a group", () => {
  it("refuses when a copy no longer matches the digest the group was built on", () => {
    asset("a", "a.jpg", { hash: "same" });
    asset("b", "b.jpg", { hash: "same" });
    rebuildExactDuplicateGroups();
    const groupId = listDuplicateGroups()[0].id;

    // The file changed under us between the scan and the click.
    db.prepare("UPDATE gallery_details SET content_hash = 'changed' WHERE item_id = 'b'").run();

    expect(resolveDuplicateGroup(groupId, "u1")).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM library_items").get()).toEqual({ n: 2 });
  });

  it("refuses when the copy it was told to keep has gone", () => {
    asset("a", "a.jpg", { hash: "same" });
    asset("b", "b.jpg", { hash: "same" });
    rebuildExactDuplicateGroups();
    const groupId = listDuplicateGroups()[0].id;

    db.prepare("UPDATE library_items SET deleted_at = ? WHERE id = 'a'").run(new Date().toISOString());

    expect(resolveDuplicateGroup(groupId, "u1")).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM library_items").get()).toEqual({ n: 2 });
  });

  it("returns null for a group that no longer exists", () => {
    expect(resolveDuplicateGroup("nope", "u1")).toBeNull();
  });
});

// Deleting goes through trashBook, which moves the real file into the Recycle Bin —
// so unlike the grouping tests, these need assets that exist on disk.
describe("resolving a selection", () => {
  let sourceRoot = "";

  beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "dup-select-"));
    sourceRoot = path.join(base, "library");
    const thumbRoot = path.join(base, "thumbs");
    fs.mkdirSync(sourceRoot);
    fs.mkdirSync(thumbRoot);
    db.prepare("INSERT OR REPLACE INTO storage_roots (id, name, path, created_by) VALUES ('sr1', 'test', ?, 'u1')").run(base);
    db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(thumbnailPathSettingKey, thumbRoot);
    db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'GAL'").run(sourceRoot);
  });

  // A real file catalogued with its digest already set, so grouping needs no scan.
  function copy(id: string, hash = "same"): string {
    const relativePath = `${id}.jpg`;
    fs.writeFileSync(path.join(sourceRoot, relativePath), `PICTURE-${hash}`);
    return asset(id, relativePath, { hash, size: 1000 });
  }

  const liveIds = () =>
    (db.prepare("SELECT id FROM library_items ORDER BY id").all() as { id: string }[]).map((r) => r.id);

  it("deletes only the copies named, keeping the rest", () => {
    copy("a"); copy("b"); copy("c");
    rebuildExactDuplicateGroups();
    const groupId = listDuplicateGroups()[0].id;

    const result = resolveDuplicateSelection(groupId, ["c"], "u1");

    expect(result?.deletedItemIds).toEqual(["c"]);
    expect(result?.keptItemIds.sort()).toEqual(["a", "b"]);
    expect(liveIds()).toEqual(["a", "b"]);
  });

  it("keeps the set alive when two copies still remain", () => {
    copy("a"); copy("b"); copy("c");
    rebuildExactDuplicateGroups();
    const groupId = listDuplicateGroups()[0].id;

    resolveDuplicateSelection(groupId, ["c"], "u1");

    expect(listDuplicateGroups().map((g) => g.members.length)).toEqual([2]);
  });

  it("removes every copy when the whole set is selected", () => {
    copy("a"); copy("b");
    rebuildExactDuplicateGroups();
    const groupId = listDuplicateGroups()[0].id;

    const result = resolveDuplicateSelection(groupId, ["a", "b"], "u1");

    expect(result?.deletedItemIds.sort()).toEqual(["a", "b"]);
    expect(result?.keptItemIds).toEqual([]);
    expect(liveIds()).toEqual([]);
    expect(listDuplicateGroups()).toEqual([]);
  });

  it("moves a deleted copy's tags onto a survivor", () => {
    copy("a"); copy("b"); copy("c");
    db.prepare("INSERT INTO tags (id, key, display_name) VALUES ('t1', 'beach', 'Beach')").run();
    db.prepare("INSERT INTO taggables (tag_id, entity_type, entity_id) VALUES ('t1', 'library_item', 'c')").run();
    rebuildExactDuplicateGroups();
    const groupId = listDuplicateGroups()[0].id;
    setDuplicateKeeper(groupId, "a");

    resolveDuplicateSelection(groupId, ["c"], "u1");

    const tagged = (db.prepare(
      "SELECT entity_id FROM taggables WHERE tag_id = 't1' ORDER BY entity_id"
    ).all() as { entity_id: string }[]).map((r) => r.entity_id);
    expect(tagged).toEqual(["a"]);
  });

  it("promotes a survivor when the keeper itself was the copy deleted", () => {
    // The FK is ON DELETE SET NULL, so without promotion the surviving set would have
    // no keeper — every copy would default to "delete" on the next pass.
    copy("a"); copy("b"); copy("c");
    rebuildExactDuplicateGroups();
    const groupId = listDuplicateGroups()[0].id;
    setDuplicateKeeper(groupId, "a");

    resolveDuplicateSelection(groupId, ["a"], "u1");

    const group = listDuplicateGroups()[0];
    expect(group.keeperItemId).not.toBeNull();
    expect(["b", "c"]).toContain(group.keeperItemId);
  });

  it("refuses ids that aren't live members of the set", () => {
    copy("a"); copy("b"); copy("outsider", "different");
    rebuildExactDuplicateGroups();
    const groupId = listDuplicateGroups()[0].id;

    expect(resolveDuplicateSelection(groupId, ["b", "outsider"], "u1")).toBeNull();
    expect(liveIds()).toEqual(["a", "b", "outsider"]);
  });

  it("refuses when a survivor no longer matches the digest the set was built on", () => {
    copy("a"); copy("b");
    rebuildExactDuplicateGroups();
    const groupId = listDuplicateGroups()[0].id;

    db.prepare("UPDATE gallery_details SET content_hash = 'changed' WHERE item_id = 'b'").run();

    expect(resolveDuplicateSelection(groupId, ["b"], "u1")).toBeNull();
    expect(liveIds()).toEqual(["a", "b"]);
  });

  it("still clears the set when everything is selected, even after a file changed", () => {
    // Nothing survives, so there is no "duplicate of" relationship left to verify.
    copy("a"); copy("b");
    rebuildExactDuplicateGroups();
    const groupId = listDuplicateGroups()[0].id;

    db.prepare("UPDATE gallery_details SET content_hash = 'changed' WHERE item_id = 'b'").run();

    expect(resolveDuplicateSelection(groupId, ["a", "b"], "u1")?.deletedItemIds.sort()).toEqual(["a", "b"]);
    expect(liveIds()).toEqual([]);
  });

  it("rejects an empty selection and an unknown group", () => {
    copy("a"); copy("b");
    rebuildExactDuplicateGroups();
    const groupId = listDuplicateGroups()[0].id;

    expect(resolveDuplicateSelection(groupId, [], "u1")).toBeNull();
    expect(resolveDuplicateSelection("nope", ["a"], "u1")).toBeNull();
    expect(liveIds()).toEqual(["a", "b"]);
  });
});

describe("route payload shape", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = fastify();
    // Stubbed auth — the real session decorators are core code and out of scope.
    app.decorate("authenticate", async (request, reply) => {
      const id = request.headers["x-test-user"] as string | undefined;
      const row = id
        ? db.prepare("SELECT id, role FROM users WHERE id = ?").get(id) as { id: string; role: string } | undefined
        : undefined;
      if (!row) { reply.code(401).send({ error: "Unauthenticated" }); return; }
      request.user = row as never;
    });
    app.decorate("requireAdmin", async (request, reply) => {
      await app.authenticate(request, reply);
      if (reply.sent) return;
      if (request.user?.role !== "admin") reply.code(403).send({ error: "Admin only" });
    });
    await app.register(galleryDuplicateRoutesPlugin);
  });

  const asAdmin = { "x-test-user": "u1" };

  // The admin page assigns EITHER response straight onto its state and then renders
  // payload.groups, so a scan route returning only the status fields threw during
  // render and blanked the whole app. Both routes must carry the same payload.
  it("returns the same payload from the list and the scan route", async () => {
    asset("a", "a.jpg", { hash: "same" });
    asset("b", "b.jpg", { hash: "same" });
    rebuildExactDuplicateGroups();
    // Pre-queue a job so the scan route short-circuits instead of kicking off real
    // file I/O in the background — the shape is identical either way.
    db.prepare("INSERT INTO jobs (id, type, payload, status) VALUES ('j1', 'SCAN_GALLERY_DUPLICATES', '{}', 'pending')").run();

    const list = await app.inject({ method: "GET", url: "/api/library/gallery/duplicates", headers: asAdmin });
    const scan = await app.inject({ method: "POST", url: "/api/library/gallery/duplicates/scan", headers: asAdmin, payload: {} });

    expect(list.statusCode).toBe(200);
    expect(scan.statusCode).toBe(200);
    // The scan route adds `queued`; everything else must match key for key.
    expect(Object.keys(scan.json()).sort()).toEqual([...Object.keys(list.json()), "queued"].sort());
    expect(list.json().groups).toHaveLength(1);
    expect(scan.json().groups).toHaveLength(1);
    expect(scan.json().queued).toBe(false); // already queued — not double-queued
  });

  it("is admin-only", async () => {
    makeUser("member1");
    expect((await app.inject({ method: "GET", url: "/api/library/gallery/duplicates" })).statusCode).toBe(401);
    expect((await app.inject({
      method: "GET", url: "/api/library/gallery/duplicates", headers: { "x-test-user": "member1" }
    })).statusCode).toBe(403);
  });

  it("reports a stale set as a conflict instead of guessing", async () => {
    asset("a", "a.jpg", { hash: "same" });
    asset("b", "b.jpg", { hash: "same" });
    rebuildExactDuplicateGroups();
    const groupId = listDuplicateGroups()[0].id;
    db.prepare("UPDATE gallery_details SET content_hash = 'changed' WHERE item_id = 'b'").run();

    const response = await app.inject({
      method: "POST", url: `/api/library/gallery/duplicates/${groupId}/resolve`, headers: asAdmin, payload: {}
    });
    expect(response.statusCode).toBe(409);
    expect(db.prepare("SELECT COUNT(*) AS n FROM library_items").get()).toEqual({ n: 2 });
  });
});

describe("end-to-end scan over real files", () => {
  let sourceRoot = "";

  beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "dup-scan-"));
    sourceRoot = path.join(base, "library");
    const thumbRoot = path.join(base, "thumbs");
    fs.mkdirSync(sourceRoot);
    fs.mkdirSync(thumbRoot);
    db.prepare("INSERT OR REPLACE INTO storage_roots (id, name, path, created_by) VALUES ('sr1', 'test', ?, 'u1')").run(base);
    db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(thumbnailPathSettingKey, thumbRoot);
    db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'GAL'").run(sourceRoot);
  });

  // Write a real file and catalog it exactly as the scanner would — size AND the file's
  // own mtime, so the picker's DB-based estimate lines up with what a scan really reads.
  function file(id: string, relativePath: string, bytes: string): void {
    const absolutePath = path.join(sourceRoot, relativePath);
    fs.writeFileSync(absolutePath, bytes);
    asset(id, relativePath, { size: Buffer.byteLength(bytes), hash: null });
    db.prepare("UPDATE gallery_details SET modified_at = ? WHERE item_id = ?")
      .run(new Date(fs.statSync(absolutePath).mtimeMs).toISOString(), id);
  }

  it("hashes only size-collision candidates and groups the identical ones", async () => {
    file("a", "a.jpg", "PICTURE-ONE");
    file("b", "b.jpg", "PICTURE-ONE"); // same bytes as a
    file("c", "c.jpg", "PICTURE-TWO"); // same size as a and b, different bytes
    file("solo", "solo.jpg", "A MUCH LONGER PICTURE PAYLOAD");

    const summary = await runDuplicateScan();

    // a, b and c collide on size so all three are read; 'solo' is provably unique and
    // never touched.
    expect(summary.hashed).toBe(3);
    const soloHash = db.prepare("SELECT content_hash FROM gallery_details WHERE item_id = 'solo'").get() as { content_hash: string | null };
    expect(soloHash.content_hash).toBeNull();

    expect(summary.groups).toBe(1);
    expect(groupsByMembers()[0].members).toEqual(["a", "b"]);
  });

  // Scoping a scan is about not re-reading a huge library from disk. It must NOT narrow
  // what gets grouped — the same photo landing in two libraries is the commonest real
  // duplicate there is, and silently hiding it would be worse than a slow scan.
  it("scoped to one library, reads only that library but still groups across all", async () => {
    // 'b' lives in GAL2, which has its own folder inside the same storage root.
    fs.mkdirSync(path.join(sourceRoot, "second"));
    db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'GAL2'").run(path.join(sourceRoot, "second"));
    fs.writeFileSync(path.join(sourceRoot, "a.jpg"), "PICTURE-ONE");
    fs.writeFileSync(path.join(sourceRoot, "second", "b.jpg"), "PICTURE-ONE");
    asset("a", "a.jpg", { size: 11, hash: null });
    asset("b", "b.jpg", { size: 11, hash: null, library: "GAL2" });

    // Scanning GAL alone reads only its own file — GAL2 stays unhashed, so no set yet.
    expect((await runDuplicateScan(undefined, "GAL")).hashed).toBe(1);
    expect(db.prepare("SELECT content_hash FROM gallery_details WHERE item_id = 'b'").get())
      .toEqual({ content_hash: null });
    expect(listDuplicateGroups()).toEqual([]);

    // Scanning GAL2 reads only its file, but grouping still spans both libraries.
    expect((await runDuplicateScan(undefined, "GAL2")).hashed).toBe(1);
    expect(listDuplicateGroups()[0].members.map((m) => m.itemId).sort()).toEqual(["a", "b"]);
  });

  it("counts scan cost per library for the scope picker", async () => {
    fs.writeFileSync(path.join(sourceRoot, "a.jpg"), "PICTURE-ONE");
    fs.writeFileSync(path.join(sourceRoot, "b.jpg"), "PICTURE-ONE");
    asset("a", "a.jpg", { size: 11, hash: null });
    asset("b", "b.jpg", { size: 11, hash: null });
    asset("solo", "solo.jpg", { size: 999, hash: null, library: "GAL2" });

    const options = duplicateLibraryOptions();
    expect(options.map((o) => [o.id, o.candidateCount, o.pendingCount])).toEqual([["GAL", 2, 2], ["GAL2", 0, 0]]);
    expect(duplicateCandidateCount("GAL")).toBe(2);
    expect(duplicateCandidateCount()).toBe(2);
  });

  // The catalogue's modified_at only moves when a LIBRARY scan notices a change. If the
  // duplicate scan trusted it, a photo edited between library scans would keep a digest
  // of bytes that no longer exist — and stay grouped with a photo it no longer matches.
  // Freshness is decided by stat'ing the file instead, so no library scan is required.
  it("rehashes a file edited in place, with no library rescan in between", async () => {
    file("a", "a.jpg", "PICTURE-ONE");
    file("b", "b.jpg", "PICTURE-ONE");
    await runDuplicateScan();
    expect(listDuplicateGroups()).toHaveLength(1);

    // Edit 'b' to different content of the SAME length and leave the catalogue alone —
    // exactly what the catalog scan would not have noticed yet.
    fs.writeFileSync(path.join(sourceRoot, "b.jpg"), "PICTURE-TWO");
    fs.utimesSync(path.join(sourceRoot, "b.jpg"), new Date(), new Date(Date.now() + 1000));

    const summary = await runDuplicateScan();
    expect(summary.hashed).toBe(1); // only 'b' was re-read
    expect(summary.stale).toBe(0);  // same size, so nothing is out of step
    expect(listDuplicateGroups()).toEqual([]);
  });

  it("skips a file whose size no longer matches the catalogue and asks for a rescan", async () => {
    file("a", "a.jpg", "PICTURE-ONE");
    file("b", "b.jpg", "PICTURE-ONE");
    await runDuplicateScan();
    expect(listDuplicateGroups()).toHaveLength(1);

    // 'b' grows on disk. The catalogued size is what put it in the candidate set, so
    // that premise is now wrong and its digest can't be trusted either.
    fs.writeFileSync(path.join(sourceRoot, "b.jpg"), "PICTURE-TWO-BUT-MUCH-LONGER");

    const summary = await runDuplicateScan();
    expect(summary.stale).toBe(1);
    expect(summary.hashed).toBe(0);
    expect(db.prepare("SELECT content_hash FROM gallery_details WHERE item_id = 'b'").get())
      .toEqual({ content_hash: null });
    expect(listDuplicateGroups()).toEqual([]);
  });

  it("leaves an untouched file alone instead of re-reading it", async () => {
    file("a", "a.jpg", "PICTURE-ONE");
    file("b", "b.jpg", "PICTURE-ONE");
    expect((await runDuplicateScan()).hashed).toBe(2);
    // Nothing changed on disk, so the second run reads nothing at all.
    expect((await runDuplicateScan()).hashed).toBe(0);
    expect(listDuplicateGroups()).toHaveLength(1);
  });

  it("keeps the tagged copy, absorbs its work, and bins the rest", async () => {
    file("a", "a.jpg", "PICTURE-ONE");
    file("b", "b.jpg", "PICTURE-ONE");
    // 'b' carries user work, so it should win despite 'a' sorting first.
    db.prepare("INSERT INTO tags (id, key, display_name) VALUES ('t1', 'lake', 'Lake')").run();
    db.prepare("INSERT INTO taggables (tag_id, entity_type, entity_id) VALUES ('t1', 'library_item', 'b')").run();

    await runDuplicateScan();
    const group = listDuplicateGroups()[0];
    expect(group.keeperItemId).toBe("b");

    const result = resolveDuplicateGroup(group.id, "u1");
    expect(result?.keptItemId).toBe("b");
    expect(result?.deletedItemIds).toEqual(["a"]);
    expect(result?.failed).toEqual([]);

    // The kept copy still holds the tag, the losing row is gone from the catalog, and
    // its file has left the library folder for the Recycle Bin.
    expect(db.prepare("SELECT 1 FROM taggables WHERE tag_id='t1' AND entity_id='b'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM library_items WHERE id='a'").get()).toBeUndefined();
    expect(fs.existsSync(path.join(sourceRoot, "a.jpg"))).toBe(false);
    expect(fs.existsSync(path.join(sourceRoot, "b.jpg"))).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM trashed_items").get()).toEqual({ n: 1 });

    // One copy left, so the set is no longer a duplicate set.
    expect(listDuplicateGroups()).toEqual([]);
  });

  it("bins a near-identical copy without carrying its faces onto the keeper", async () => {
    file("big", "big.jpg", "PICTURE-ORIGINAL-LARGE");
    file("small", "small.jpg", "PICTURE-SMALL");
    db.prepare("UPDATE gallery_details SET phash = ?, width = 4000, height = 3000 WHERE item_id = 'big'")
      .run(fingerprint(1, 2));
    db.prepare("UPDATE gallery_details SET phash = ?, width = 800, height = 600 WHERE item_id = 'small'")
      .run(fingerprint(1, 2, 3));
    db.prepare("INSERT INTO gallery_people (id, name) VALUES ('p1', 'Mum')").run();
    db.prepare("INSERT INTO gallery_faces (id, item_id, person_id, box_x) VALUES ('f1', 'small', 'p1', 0.25)").run();

    await runDuplicateScan();
    const group = listDuplicateGroups().find((g) => g.kind === "near")!;
    // The small copy carries the face, so it wins the vote; override it so the face row
    // sits on the copy being removed — which is the case that must not carry over.
    expect(setDuplicateKeeper(group.id, "big")).toBe(true);

    const result = resolveDuplicateGroup(group.id, "u1");
    expect(result?.keptItemId).toBe("big");
    expect(result?.deletedItemIds).toEqual(["small"]);
    // The box was normalised against 800x600 pixels; it must not land on the 4000x3000
    // keeper. The person survives via the library, not via a mis-placed box.
    expect(db.prepare("SELECT COUNT(*) AS n FROM gallery_faces WHERE item_id = 'big'").get()).toEqual({ n: 0 });
    expect(fs.existsSync(path.join(sourceRoot, "small.jpg"))).toBe(false);
    expect(fs.existsSync(path.join(sourceRoot, "big.jpg"))).toBe(true);
  });

  it("sweeps every identical set with resolve-all", async () => {
    file("a1", "a1.jpg", "SET-ONE");
    file("a2", "a2.jpg", "SET-ONE");
    file("b1", "b1.jpg", "SET-TWO-LONGER");
    file("b2", "b2.jpg", "SET-TWO-LONGER");

    await runDuplicateScan();
    expect(listDuplicateGroups()).toHaveLength(2);

    expect(resolveAllExactGroups("u1")).toEqual({ groups: 2, deleted: 2, failed: 0, skipped: 0 });
    expect(listDuplicateGroups()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM library_items").get()).toEqual({ n: 2 });
  });

  // The admin page's library picker filters the list; the sweep follows it, so what
  // the button clears is what's on screen rather than every library at once.
  it("scoped to a library, sweeps only the sets that library takes part in", async () => {
    fs.mkdirSync(path.join(sourceRoot, "second"));
    db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'GAL2'").run(path.join(sourceRoot, "second"));

    // One set inside GAL2 only, one inside GAL only.
    fs.writeFileSync(path.join(sourceRoot, "second", "x1.jpg"), "SET-IN-GAL2");
    fs.writeFileSync(path.join(sourceRoot, "second", "x2.jpg"), "SET-IN-GAL2");
    asset("x1", "x1.jpg", { size: 11, hash: null, library: "GAL2" });
    asset("x2", "x2.jpg", { size: 11, hash: null, library: "GAL2" });
    file("y1", "y1.jpg", "SET-IN-GAL-ONE");
    file("y2", "y2.jpg", "SET-IN-GAL-ONE");

    await runDuplicateScan();
    expect(listDuplicateGroups()).toHaveLength(2);

    // GAL2's set goes; GAL's is left standing.
    expect(resolveAllExactGroups("u1", "GAL2")).toEqual({ groups: 1, deleted: 1, failed: 0, skipped: 0 });
    expect(listDuplicateGroups().flatMap((g) => g.members.map((m) => m.itemId)).sort()).toEqual(["y1", "y2"]);

    // And the unscoped sweep still takes everything that's left.
    expect(resolveAllExactGroups("u1")).toEqual({ groups: 1, deleted: 1, failed: 0, skipped: 0 });
    expect(listDuplicateGroups()).toEqual([]);
  });

  // A set spanning two libraries is swept from either side — the survivor is chosen on
  // merit, so the copy removed can be the one in the OTHER library. That's the point:
  // scoping picks which sets to act on, not which copies may go.
  it("sweeps a cross-library set from either library's scope", async () => {
    fs.mkdirSync(path.join(sourceRoot, "second"));
    db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'GAL2'").run(path.join(sourceRoot, "second"));
    fs.writeFileSync(path.join(sourceRoot, "here.jpg"), "SHARED-PICTURE");
    fs.writeFileSync(path.join(sourceRoot, "second", "there.jpg"), "SHARED-PICTURE");
    asset("here", "here.jpg", { size: 14, hash: null });
    asset("there", "there.jpg", { size: 14, hash: null, library: "GAL2" });

    await runDuplicateScan();
    expect(listDuplicateGroups()).toHaveLength(1);

    expect(resolveAllExactGroups("u1", "GAL2")).toEqual({ groups: 1, deleted: 1, failed: 0, skipped: 0 });
    expect(listDuplicateGroups()).toEqual([]);
    // Exactly one copy survives, wherever it lives.
    expect(db.prepare("SELECT COUNT(*) AS n FROM library_items WHERE deleted_at IS NULL").get()).toEqual({ n: 1 });
  });

  it("sweeping a library with no sets of its own does nothing", async () => {
    file("a1", "a1.jpg", "ONLY-IN-GAL");
    file("a2", "a2.jpg", "ONLY-IN-GAL");
    await runDuplicateScan();

    expect(resolveAllExactGroups("u1", "GAL2")).toEqual({ groups: 0, deleted: 0, failed: 0, skipped: 0 });
    expect(listDuplicateGroups()).toHaveLength(1);
  });

  it("reports scan status for the admin page", async () => {
    file("a", "a.jpg", "PICTURE-ONE");
    file("b", "b.jpg", "PICTURE-ONE");
    expect(duplicateScanStatus()).toEqual({
      lastScanAt: null,
      candidateCount: 2,
      pendingCount: 2,
      staleCount: 0,
      scanning: false,
      libraries: [
        { id: "GAL", name: "GAL", candidateCount: 2, pendingCount: 2 },
        { id: "GAL2", name: "GAL2", candidateCount: 0, pendingCount: 0 }
      ]
    });

    await runDuplicateScan();
    const after = duplicateScanStatus();
    expect(after.lastScanAt).not.toBeNull();
    // Hashing is done, so a re-scan would read nothing — but the photos are still
    // candidates. The picker shows the pending number, which is the actionable one.
    expect(after.candidateCount).toBe(2);
    expect(after.pendingCount).toBe(0);
    expect(after.libraries[0].pendingCount).toBe(0);
  });

  it("clears a digest it can no longer verify", async () => {
    file("a", "a.jpg", "PICTURE-ONE");
    file("b", "b.jpg", "PICTURE-ONE");
    await runDuplicateScan();

    fs.rmSync(path.join(sourceRoot, "b.jpg"));

    await runDuplicateScan();
    const row = db.prepare("SELECT content_hash FROM gallery_details WHERE item_id = 'b'").get() as { content_hash: string | null };
    expect(row.content_hash).toBeNull();
    expect(listDuplicateGroups()).toEqual([]);
  });
});
