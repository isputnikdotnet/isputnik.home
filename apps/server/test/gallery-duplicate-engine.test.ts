// The duplicate ENGINE — the parts every tier is built on, none of which belong to a
// page or a job: the size gate that keeps the scan off the disk, the ladder that picks
// which copy survives, the metadata absorption that runs before a copy is binned, and
// the folder fingerprint.
//
// These cases used to live in the two suites that covered the Duplicate photos and
// Duplicate folders pages. Those pages and their caches are gone; this work is not,
// because a cleanup's snapshot is built on exactly the same functions.
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import {
  duplicateCandidateCount,
  absorbDuplicateMetadata,
  pickKeeper
} from "../src/modules/library/gallery/duplicates/items.js";
import { fingerprintFolders, pickFolderKeeper } from "../src/modules/library/gallery/duplicates/folders.js";
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

describe("metadata absorption", () => {
  it("absorbing a near-identical copy moves tags but NOT faces", () => {
    // A resized copy's face boxes are normalised against different pixels, so carrying
    // them over would land a box in the wrong place. Tags and albums have no such
    // problem — and a byte-identical copy does move its faces, just below.
    asset("keeper", "keeper.jpg", { hash: "h-keeper", width: 4000, height: 3000 });
    asset("small", "small.jpg", { hash: "h-small", width: 800, height: 600 });
    db.prepare("INSERT INTO tags (id, key, display_name) VALUES ('t1', 'lake', 'Lake')").run();
    db.prepare("INSERT INTO taggables (tag_id, entity_type, entity_id) VALUES ('t1', 'library_item', 'small')").run();
    db.prepare("INSERT INTO gallery_people (id, name) VALUES ('p1', 'Mum')").run();
    db.prepare("INSERT INTO gallery_faces (id, item_id, person_id, box_x) VALUES ('f1', 'small', 'p1', 0.25)").run();

    absorbDuplicateMetadata("keeper", ["small"], { moveFaces: false });

    expect(db.prepare("SELECT 1 FROM taggables WHERE tag_id='t1' AND entity_id='keeper'").get()).toBeTruthy();
    expect(db.prepare("SELECT COUNT(*) AS n FROM gallery_faces WHERE item_id='keeper'").get()).toEqual({ n: 0 });
  });

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

  // The film-scanner case from the real library, and the reason this criterion exists.
  // A Fuji Frontier writes FL000003.jpg at 432×640 beside FH000003.jpg at 1215×1800 —
  // and stamps the camera make and model on the LOW-resolution index scan only. Judged
  // on metadata the preview wins and the only detailed copy of the photograph is the one
  // proposed for deletion.
  it("never keeps an index scan over the full-size photo it came from", () => {
    const full = {
      ...detail("full"), relative_path: "2004-09-09/FH000003-003.jpg",
      width: 1215, height: 1800, size: 1473848, camera_make: null, camera_model: null
    };
    const index = {
      ...detail("index"), relative_path: "2004-09-09/FL000003.jpg",
      width: 432, height: 640, size: 147278,
      camera_make: "FUJI PHOTO FILM CO., LTD.", camera_model: "SP-2000"
    };

    const choice = pickKeeper([index, full]);
    expect(choice?.keeperId).toBe("full");
    expect(choice?.reason).toContain("not a low-resolution copy");
  });

  it("outranks the work merged onto the keeper anyway", () => {
    // Tags, albums and people move to the surviving copy; pixels cannot. So a tagged
    // thumbnail still loses — unlike a tagged full-size copy, which wins above.
    const full = { ...detail("full"), width: 4000, height: 3000 };
    const thumb = { ...detail("thumb"), width: 400, height: 300, tag_count: 3, face_count: 2 };
    expect(pickKeeper([thumb, full])?.keeperId).toBe("full");
  });

  it("leaves a moderate downscale to the ordinary criteria", () => {
    // Half the pixels is not a preview — it is a photograph. 'small' carries the camera
    // info, which is a real criterion and still allowed to decide at this distance.
    const big = { ...detail("big"), width: 6000, height: 4000, camera_make: null };
    const small = { ...detail("small"), width: 4000, height: 3000, camera_make: "Canon" };
    const choice = pickKeeper([big, small]);
    expect(choice?.keeperId).toBe("small");
    expect(choice?.reason).not.toContain("low-resolution");
  });

  it("never calls a copy of unknown size a preview", () => {
    // Unknown is not small: an item whose dimensions never got read must not be thrown
    // away for having none.
    const known = { ...detail("known"), width: 4000, height: 3000 };
    const unknown = { ...detail("unknown"), width: null, height: null, tag_count: 1 };
    expect(pickKeeper([known, unknown])?.keeperId).toBe("unknown");
  });

  it("prefers the original over a file-manager copy", () => {
    const original = detail("original");
    const copy = { ...detail("copy"), relative_path: "IMG_1234 (1).jpg" };
    const choice = pickKeeper([copy, original]);
    expect(choice?.keeperId).toBe("original");
    expect(choice?.reason).toContain("not a copy");
  });

  // The scanner-software case from the dev library: "Picture 071.jpg" beside
  // "Picture 071-001.jpg". No pattern can say which of those is the original — "-001"
  // is a counter to one piece of software and part of the name to another — but set
  // the two names side by side and one is plainly the other with something appended.
  it("prefers the original over a copy whose name was extended", () => {
    const original = { ...detail("original"), relative_path: "Scans/Picture 071.jpg" };
    const copy = { ...detail("copy"), relative_path: "Scans/Picture 071-001.jpg" };
    const choice = pickKeeper([copy, original]);
    expect(choice?.keeperId).toBe("original");
    expect(choice?.reason).toContain("not a copy");
  });

  it("reads any appended suffix, not just the ones spelled out in COPY_MARKERS", () => {
    const original = { ...detail("original"), relative_path: "a/Holiday.jpg" };
    for (const suffix of ["-1", "_2", " (3)", " - Copy", "-0004"]) {
      const copy = { ...detail("copy"), relative_path: `a/Holiday${suffix}.jpg` };
      expect(pickKeeper([copy, original])?.keeperId).toBe("original");
    }
  });

  // The trap the relational rule has to avoid: "IMG_110" IS a prefix of "IMG_1109",
  // but that 9 is part of the frame number, not a counter somebody bolted on. Left to
  // the ordinary tiebreaks rather than declaring the longer name a copy.
  it("does not read a longer frame number as a copy of a shorter one", () => {
    const shorter = { ...detail("shorter"), relative_path: "a/IMG_110.jpg", size: 100 };
    const longer = { ...detail("longer"), relative_path: "a/IMG_1109.jpg", size: 900 };
    const choice = pickKeeper([shorter, longer]);
    // Decided on size, which is the next criterion — not on either being "a copy".
    expect(choice?.keeperId).toBe("longer");
    expect(choice?.reason).not.toContain("not a copy");
  });

  it("prefers an original folder over a received one", () => {
    const camera = { ...detail("camera"), relative_path: "Camera/IMG_1.jpg" };
    const received = { ...detail("received"), relative_path: "WhatsApp Images/IMG_1.jpg" };
    expect(pickKeeper([received, camera])?.keeperId).toBe("camera");
  });

  it("keeps the copy in a library nothing may be deleted from", () => {
    // GAL2 is external: the app reads it and does not own it. A copy there cannot be
    // removed at all, so naming it the loser would propose work that gets refused —
    // whatever else is true of the two files.
    db.prepare("UPDATE libraries SET policy_json = ? WHERE id = 'GAL2'").run(JSON.stringify({ mode: "external" }));
    const ordinary = { ...detail("ordinary"), tag_count: 5, width: 8000, height: 6000 };
    const external = { ...detail("external"), library_id: "GAL2", library_name: "GAL2" };

    // 'ordinary' wins on every other criterion there is, and still gives up its copy.
    const choice = pickKeeper([ordinary, external]);
    expect(choice?.keeperId).toBe("external");
    expect(choice?.reason).toContain("can't be deleted from");
  });

  it("falls back to the copy added first, deterministically", () => {
    const older = { ...detail("zzz"), discovered_at: "2023-01-01T00:00:00.000Z" };
    const newer = { ...detail("aaa"), discovered_at: "2025-01-01T00:00:00.000Z" };
    const choice = pickKeeper([newer, older]);
    expect(choice?.keeperId).toBe("zzz");
    expect(choice?.reason).toContain("added first");
  });
});


// ── Folders ─────────────────────────────────────────────────────────────────
//
// A folder has no row anywhere: it exists only as a prefix of the paths below it, and
// its fingerprint is every file underneath as "<path below the folder>\0<digest>",
// sorted and hashed. Every folder answer a cleanup gives is built on this.

// One folder holding the same two pictures, wherever you put it.
function trip(prefix: string, idPrefix: string, opts: AssetOpts = {}) {
  asset(`${idPrefix}1`, `${prefix}/one.jpg`, { hash: "pic-one", ...opts });
  asset(`${idPrefix}2`, `${prefix}/two.jpg`, { hash: "pic-two", ...opts });
}

// The fingerprint of one folder, by path.
const fingerprintOf = (folderPath: string, libraryId = "GAL") =>
  fingerprintFolders().find((print) => print.libraryId === libraryId && print.folderPath === folderPath);

describe("fingerprinting", () => {
  it("gives two differently-named folders the same fingerprint", () => {
    trip("Italy 2019", "a");
    trip("Backup/holiday-copy", "b");

    const prints = new Map(fingerprintFolders().map((print) => [print.folderPath, print.digest]));
    expect(prints.get("Italy 2019")).toBe(prints.get("Backup/holiday-copy"));
  });

  it("separates folders whose files differ, however alike the names", () => {
    trip("Italy 2019", "a");
    asset("b1", "Italy 2019 copy/one.jpg", { hash: "pic-one" });
    asset("b2", "Italy 2019 copy/two.jpg", { hash: "something-else" });

    const prints = new Map(fingerprintFolders().map((print) => [print.folderPath, print.digest]));
    expect(prints.get("Italy 2019")).not.toBe(prints.get("Italy 2019 copy"));
  });

  it("counts the names of files and subfolders, so a re-arranged tree is not the same", () => {
    asset("a1", "A/sub/one.jpg", { hash: "pic-one" });
    asset("a2", "A/sub/two.jpg", { hash: "pic-two" });
    asset("b1", "B/elsewhere/one.jpg", { hash: "pic-one" });
    asset("b2", "B/elsewhere/two.jpg", { hash: "pic-two" });

    const prints = new Map(fingerprintFolders().map((print) => [print.folderPath, print.digest]));
    // The subfolders match each other…
    expect(prints.get("A/sub")).toBe(prints.get("B/elsewhere"));
    // …but their parents hold the same photos under different paths.
    expect(prints.get("A")).not.toBe(prints.get("B"));
  });

  it("skips a folder holding anything unhashed — its contents are not fully known", () => {
    trip("Italy 2019", "a");
    asset("a3", "Italy 2019/three.jpg", { hash: null });
    trip("Backup/holiday", "b");

    const paths = fingerprintFolders().map((print) => print.folderPath);
    expect(paths).not.toContain("Italy 2019");
    // Its parent (the library root) is disqualified by the same file.
    expect(paths).not.toContain("");
  });

  it("ignores a folder holding a single photo — that is a duplicate photo, not a folder", () => {
    asset("a1", "One/only.jpg", { hash: "pic" });
    asset("b1", "Two/only.jpg", { hash: "pic" });
    expect(fingerprintFolders().map((print) => print.folderPath)).not.toContain("One");
  });

  it("leaves tombstoned photos out of the fingerprint", () => {
    trip("Italy 2019", "a");
    trip("Backup/holiday", "b");
    asset("ghost", "Italy 2019/gone.jpg", { hash: "pic-three" });
    db.prepare("UPDATE library_items SET deleted_at = '2024-06-01T00:00:00.000Z' WHERE id = 'ghost'").run();

    const prints = new Map(fingerprintFolders().map((print) => [print.folderPath, print.digest]));
    expect(prints.get("Italy 2019")).toBe(prints.get("Backup/holiday"));
  });
});

describe("which folder is kept", () => {
  it("prefers the folder whose photos carry tags and albums", () => {
    trip("Backup/holiday", "a", { discoveredAt: "2023-01-01T00:00:00.000Z" });
    trip("Italy 2019", "b", { discoveredAt: "2024-01-01T00:00:00.000Z" });
    db.prepare("INSERT INTO tags (id, key, display_name) VALUES ('t1', 'trips', 'Trips')").run();
    db.prepare("INSERT INTO taggables (tag_id, entity_type, entity_id) VALUES ('t1', 'library_item', 'b1')").run();

    // Backup/holiday was added first, but hand-filed work outranks everything.
    const pair = fingerprintFolders().filter((print) => print.folderPath.endsWith("holiday") || print.folderPath === "Italy 2019");
    expect(pickFolderKeeper(pair)?.keeper.folderPath).toBe("Italy 2019");
  });
});
