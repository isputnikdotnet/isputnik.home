// Duplicate FOLDERS — whole folders holding the same files under different names.
// Covers the fingerprint (contents count, the folder's own name does not, subfolder
// names do), the all-files-hashed gate, nested suppression, keeper choice, dismissal,
// and the re-validation that runs before anything is removed.
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import {
  fingerprintFolders,
  fingerprintOf,
  rebuildDuplicateFolderGroups,
  listDuplicateFolderGroups,
  setDuplicateFolderKeeper,
  ignoreDuplicateFolderGroup,
  resolveDuplicateFolderGroup,
  pickFolderKeeper,
  rebuildContainedFolders,
  listContainedFolders,
  ignoreContainedFolder,
  resolveContainedFolder
} from "../src/modules/library/gallery/duplicate-folders.js";
import {
  setFolderPreferences,
  rebuildExactDuplicateGroups,
  listDuplicateGroups
} from "../src/modules/library/gallery/duplicates.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

interface AssetOpts {
  library?: string;
  size?: number;
  hash?: string | null;
  discoveredAt?: string;
}

// A ready gallery asset carrying the digest the hashing pass would have left behind,
// so folder grouping can be tested without touching a filesystem.
function asset(id: string, relativePath: string, opts: AssetOpts = {}): string {
  const { library = "GAL", size = 1000, hash = `h-${id}`, discoveredAt = "2024-01-01T00:00:00.000Z" } = opts;
  db.prepare(`
    INSERT INTO library_items (id, library_id, type, folder_path, status, discovered_at)
    VALUES (?, ?, 'gallery', ?, 'ready', ?)
  `).run(id, library, relativePath, discoveredAt);
  db.prepare(`
    INSERT INTO gallery_details (item_id, kind, relative_path, size, content_hash, content_hash_at, modified_at)
    VALUES (?, 'photo', ?, ?, ?, 'm1', 'm1')
  `).run(id, relativePath, size, hash);
  return id;
}

// One folder holding the same two pictures, wherever you put it.
function trip(prefix: string, idPrefix: string, opts: AssetOpts = {}) {
  asset(`${idPrefix}1`, `${prefix}/one.jpg`, { hash: "pic-one", ...opts });
  asset(`${idPrefix}2`, `${prefix}/two.jpg`, { hash: "pic-two", ...opts });
}

const groupPaths = () =>
  listDuplicateFolderGroups().map((group) => ({
    keeper: group.members.find((member) => member.isKeeper)?.folderPath,
    members: group.members.map((member) => `${member.libraryId}:${member.folderPath}`).sort()
  }));

beforeEach(() => {
  resetDb();
  makeUser("u1", "admin");
  makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
  makeLibrary("GAL2", { createdBy: "u1", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
  grant("group", EVERYONE_GROUP_ID, "GAL2", "member");
});

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

describe("grouping", () => {
  it("groups folders with matching contents across libraries", () => {
    trip("Italy 2019", "a");
    trip("Trips/italy", "b", { library: "GAL2" });

    const totals = rebuildDuplicateFolderGroups();
    expect(totals.groups).toBe(1);
    expect(totals.extraFolders).toBe(1);
    expect(totals.reclaimableBytes).toBe(2000);
    expect(groupPaths()).toEqual([{ keeper: "Italy 2019", members: ["GAL2:Trips/italy", "GAL:Italy 2019"] }]);
  });

  it("reports only the topmost pairing, not every subfolder inside it", () => {
    asset("a1", "Photos/2019/one.jpg", { hash: "pic-one" });
    asset("a2", "Photos/2019/two.jpg", { hash: "pic-two" });
    asset("b1", "Backup/2019/one.jpg", { hash: "pic-one" });
    asset("b2", "Backup/2019/two.jpg", { hash: "pic-two" });

    rebuildDuplicateFolderGroups();
    // Photos and Backup pair up, and so do Photos/2019 and Backup/2019 — only the
    // parents are worth acting on, because removing one takes its subfolders with it.
    expect(groupPaths()).toEqual([{ keeper: "Photos", members: ["GAL:Backup", "GAL:Photos"] }]);
  });

  it("rebuilds from scratch, so a removed folder stops being reported", () => {
    trip("Italy 2019", "a");
    trip("Backup/holiday", "b");
    rebuildDuplicateFolderGroups();
    expect(listDuplicateFolderGroups()).toHaveLength(1);

    db.prepare("DELETE FROM library_items WHERE id IN ('b1', 'b2')").run();
    rebuildDuplicateFolderGroups();
    expect(listDuplicateFolderGroups()).toEqual([]);
  });
});

describe("keeper choice", () => {
  it("prefers the folder whose photos carry tags and albums", () => {
    trip("Backup/holiday", "a", { discoveredAt: "2023-01-01T00:00:00.000Z" });
    trip("Italy 2019", "b", { discoveredAt: "2024-01-01T00:00:00.000Z" });
    db.prepare("INSERT INTO tags (id, key, display_name) VALUES ('t1', 'trips', 'Trips')").run();
    db.prepare("INSERT INTO taggables (tag_id, entity_type, entity_id) VALUES ('t1', 'library_item', 'b1')").run();

    // Backup/holiday was added first, but hand-filed work outranks everything.
    const pair = fingerprintFolders().filter((print) => print.folderPath.endsWith("holiday") || print.folderPath === "Italy 2019");
    expect(pickFolderKeeper(pair)?.keeper.folderPath).toBe("Italy 2019");
  });

  it("passes over a downloads folder and a folder named like a copy", () => {
    trip("Downloads/italy", "a", { discoveredAt: "2023-01-01T00:00:00.000Z" });
    trip("Italy 2019", "b", { discoveredAt: "2024-01-01T00:00:00.000Z" });

    rebuildDuplicateFolderGroups();
    expect(groupPaths()[0].keeper).toBe("Italy 2019");
  });

  it("falls back to the folder added first when nothing separates them", () => {
    trip("B-folder", "a", { discoveredAt: "2023-05-01T00:00:00.000Z" });
    trip("A-folder", "b", { discoveredAt: "2024-05-01T00:00:00.000Z" });

    rebuildDuplicateFolderGroups();
    const [group] = listDuplicateFolderGroups();
    expect(group.members.find((member) => member.isKeeper)?.folderPath).toBe("B-folder");
    expect(group.keeperReason).toContain("added first");
  });

  it("carries a hand-picked keeper across a rebuild", () => {
    trip("Italy 2019", "a");
    trip("Backup/holiday", "b");
    rebuildDuplicateFolderGroups();
    const [group] = listDuplicateFolderGroups();

    expect(setDuplicateFolderKeeper(group.id, { libraryId: "GAL", folderPath: "Backup/holiday" })).toBe(true);
    rebuildDuplicateFolderGroups();
    const [rebuilt] = listDuplicateFolderGroups();
    expect(rebuilt.members.find((member) => member.isKeeper)?.folderPath).toBe("Backup/holiday");
    expect(rebuilt.keeperSource).toBe("manual");
  });
});

describe("dismissal", () => {
  it("keeps a dismissed pair apart on every future scan", () => {
    trip("Italy 2019", "a");
    trip("Backup/holiday", "b");
    rebuildDuplicateFolderGroups();
    const [group] = listDuplicateFolderGroups();

    expect(ignoreDuplicateFolderGroup(group.id)).toBe(true);
    expect(listDuplicateFolderGroups()).toEqual([]);
    rebuildDuplicateFolderGroups();
    expect(listDuplicateFolderGroups()).toEqual([]);
  });
});

describe("resolution", () => {
  const setup = () => {
    trip("Italy 2019", "a");
    trip("Backup/holiday", "b");
    rebuildDuplicateFolderGroups();
    return listDuplicateFolderGroups()[0];
  };

  // The move to the Recycle Bin is trashBook's own suite (it needs a real library
  // folder on disk); what matters here is that every photo is accounted for and that
  // its hand-filed work reaches its counterpart BEFORE anything is removed.
  it("hands each photo's tags to the file at the same path in the kept folder", () => {
    const group = setup();
    db.prepare("INSERT INTO tags (id, key, display_name) VALUES ('t1', 'trips', 'Trips')").run();
    db.prepare("INSERT INTO taggables (tag_id, entity_type, entity_id) VALUES ('t1', 'library_item', 'b1')").run();

    const result = resolveDuplicateFolderGroup(group.id, [{ libraryId: "GAL", folderPath: "Backup/holiday" }], "u1");
    expect(result?.deletedFolders).toEqual([{ libraryId: "GAL", folderPath: "Backup/holiday" }]);
    // b1 and b2 each either went to the bin or reported why not — none was skipped.
    expect((result?.deletedItemIds.length ?? 0) + (result?.failed.length ?? 0)).toBe(2);
    expect(result?.failed.map((entry) => entry.error)).not.toContain("No matching photo in the folder being kept.");

    // b1's tag landed on the file at the same path inside the kept folder. (b1 keeps
    // its own row here only because the trash step can't run without a real library
    // folder; in production its rows cascade away with it.)
    const tagged = db.prepare(
      "SELECT entity_id FROM taggables WHERE tag_id = 't1' AND entity_type = 'library_item'"
    ).all() as { entity_id: string }[];
    expect(tagged.map((row) => row.entity_id)).toContain("a1");
  });

  it("refuses when a folder has changed since the scan", () => {
    const group = setup();
    asset("b3", "Backup/holiday/extra.jpg", { hash: "pic-three" });

    expect(resolveDuplicateFolderGroup(group.id, [{ libraryId: "GAL", folderPath: "Backup/holiday" }], "u1")).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM library_items WHERE deleted_at IS NULL").get()).toEqual({ n: 5 });
  });

  it("refuses to delete the folder being kept, and folders outside the set", () => {
    const group = setup();
    expect(resolveDuplicateFolderGroup(group.id, [{ libraryId: "GAL", folderPath: "Italy 2019" }], "u1")).toBeNull();
    expect(resolveDuplicateFolderGroup(group.id, [{ libraryId: "GAL", folderPath: "Somewhere/else" }], "u1")).toBeNull();
  });

  it("re-derives the fingerprint from the database, not from the stored group", () => {
    const group = setup();
    // The stored digest is a cache; what matters is what the folders hold now.
    db.prepare("UPDATE gallery_duplicate_folder_groups SET digest = 'stale' WHERE id = ?").run(group.id);
    expect(fingerprintOf({ libraryId: "GAL", folderPath: "Italy 2019" })?.digest)
      .toBe(fingerprintOf({ libraryId: "GAL", folderPath: "Backup/holiday" })?.digest);
    expect(resolveDuplicateFolderGroup(group.id, [{ libraryId: "GAL", folderPath: "Backup/holiday" }], "u1")).not.toBeNull();
  });
});

// ── Contained folders ───────────────────────────────────────────────────────
//
// "Every photo in here also sits over there." The case the equal-contents test can
// never see: a folder copied INTO itself, where the parent's fingerprint counts the
// child's files and so always holds strictly more.

const contained = () =>
  listContainedFolders().map((row) => `${row.folder.folderPath} ⊂ ${row.target.folderPath}`);

describe("contained folders", () => {
  it("finds a folder copied into itself", () => {
    // The exact shape of D:\…\2017-12-10 and its 2017-12-10 child.
    asset("p1", "2017-12-10/DSC01818.JPG", { hash: "pic-1" });
    asset("p2", "2017-12-10/DSC01819.JPG", { hash: "pic-2" });
    asset("c1", "2017-12-10/2017-12-10/DSC01818.JPG", { hash: "pic-1" });
    asset("c2", "2017-12-10/2017-12-10/DSC01819.JPG", { hash: "pic-2" });

    // Not an equal-contents pair: the parent holds 4 files, the child 2.
    rebuildDuplicateFolderGroups();
    expect(listDuplicateFolderGroups()).toEqual([]);

    expect(rebuildContainedFolders().folders).toBe(1);
    expect(contained()).toEqual(["2017-12-10/2017-12-10 ⊂ 2017-12-10"]);
    expect(listContainedFolders()[0].extraCount).toBe(0);
  });

  it("finds a folder whose photos are a subset of a bigger one", () => {
    trip("Trip", "a");
    trip("Archive/trip", "b");
    asset("extra", "Archive/trip/three.jpg", { hash: "pic-three" });

    rebuildDuplicateFolderGroups();
    rebuildContainedFolders();
    // Trip ⊂ Archive/trip, which holds one photo more.
    expect(contained()).toEqual(["Trip ⊂ Archive/trip"]);
    expect(listContainedFolders()[0].extraCount).toBe(1);
  });

  it("says nothing about a folder holding one photo that exists nowhere else", () => {
    trip("Trip", "a");
    asset("only", "Trip/unique.jpg", { hash: "pic-unique" });
    trip("Archive/trip", "b");

    rebuildContainedFolders();
    // Trip can't go — "unique" would be lost. The other direction still holds, and
    // saying so is the whole point: Archive/trip is the one that can go.
    expect(contained().filter((row) => row.startsWith("Trip ⊂"))).toEqual([]);
    expect(contained()).toEqual(["Archive ⊂ Trip"]);
  });

  it("respects how many copies a folder holds of the same picture", () => {
    asset("a1", "Twice/one.jpg", { hash: "pic-one" });
    asset("a2", "Twice/one-again.jpg", { hash: "pic-one" });
    asset("b1", "Once/one.jpg", { hash: "pic-one" });
    asset("b2", "Once/other.jpg", { hash: "pic-two" });

    rebuildContainedFolders();
    // "Once" holds pic-one only once, so it can't cover a folder needing two.
    expect(contained()).toEqual([]);
  });

  it("reports the topmost folder, not every subfolder inside it", () => {
    // Photos holds four pictures flat; Copy holds the same four with two of them in a
    // subfolder — so no two folders are equal, and both Copy and Copy/inner are
    // covered by Photos. Only Copy is worth a row: removing it takes inner with it.
    for (const [id, name] of [["b1", "a"], ["b2", "b"], ["b3", "c"], ["b4", "d"]]) {
      asset(id, `Photos/${name}.jpg`, { hash: `pic-${name}` });
    }
    asset("a1", "Copy/c.jpg", { hash: "pic-c" });
    asset("a2", "Copy/d.jpg", { hash: "pic-d" });
    asset("a3", "Copy/inner/a.jpg", { hash: "pic-a" });
    asset("a4", "Copy/inner/b.jpg", { hash: "pic-b" });

    rebuildDuplicateFolderGroups();
    expect(listDuplicateFolderGroups()).toEqual([]);
    rebuildContainedFolders();
    // Copy and Photos hold the same four pictures, so each covers the other — offering
    // both would delete every copy between them. One row only, and it's Copy that goes.
    expect(contained()).toEqual(["Copy ⊂ Photos"]);
  });

  it("never offers both sides of a mutual cover — that would delete everything", () => {
    // Same photos, different layout: each folder covers the other.
    asset("a1", "Album/one.jpg", { hash: "pic-one" });
    asset("a2", "Album/two.jpg", { hash: "pic-two" });
    asset("b1", "Downloads/sub/one.jpg", { hash: "pic-one" });
    asset("b2", "Downloads/sub/two.jpg", { hash: "pic-two" });

    rebuildContainedFolders();
    const rows = listContainedFolders();
    expect(rows).toHaveLength(1);
    // The downloads copy is the one that goes, never the album.
    expect(rows[0].folder.folderPath).toBe("Downloads");
  });

  it("stays quiet when an equal-contents set already answers the question", () => {
    // Copy/trip and Photos/trip hold exactly the same photos, so the equal-contents
    // tier offers them with a keeper choice. Reporting their parents as "contained"
    // as well would be a second, weaker answer to the same question.
    asset("a1", "Copy/trip/one.jpg", { hash: "pic-one" });
    asset("a2", "Copy/trip/two.jpg", { hash: "pic-two" });
    asset("b1", "Photos/trip/one.jpg", { hash: "pic-one" });
    asset("b2", "Photos/trip/two.jpg", { hash: "pic-two" });
    asset("b3", "Photos/extra.jpg", { hash: "pic-three" });

    rebuildDuplicateFolderGroups();
    expect(listDuplicateFolderGroups()).toHaveLength(1);
    rebuildContainedFolders();
    expect(contained()).toEqual([]);
  });

  it("defers to the equal-contents tier when the folders match exactly", () => {
    trip("Italy 2019", "a");
    trip("Backup/holiday", "b");

    rebuildDuplicateFolderGroups();
    rebuildContainedFolders();
    expect(listDuplicateFolderGroups()).toHaveLength(1);
    expect(contained()).toEqual([]);
  });

  it("keeps a dismissed folder dismissed", () => {
    asset("p1", "Trip/one.jpg", { hash: "pic-1" });
    asset("p2", "Trip/two.jpg", { hash: "pic-2" });
    asset("c1", "Trip/Trip/one.jpg", { hash: "pic-1" });
    asset("c2", "Trip/Trip/two.jpg", { hash: "pic-2" });
    rebuildContainedFolders();

    expect(ignoreContainedFolder(listContainedFolders()[0].id)).toBe(true);
    expect(contained()).toEqual([]);
    rebuildContainedFolders();
    expect(contained()).toEqual([]);
  });

  it("hands each photo's tags to its copy in the folder being kept", () => {
    asset("p1", "Trip/one.jpg", { hash: "pic-1" });
    asset("p2", "Trip/two.jpg", { hash: "pic-2" });
    asset("c1", "Trip/Trip/one.jpg", { hash: "pic-1" });
    asset("c2", "Trip/Trip/two.jpg", { hash: "pic-2" });
    rebuildContainedFolders();
    db.prepare("INSERT INTO tags (id, key, display_name) VALUES ('t1', 'trips', 'Trips')").run();
    db.prepare("INSERT INTO taggables (tag_id, entity_type, entity_id) VALUES ('t1', 'library_item', 'c1')").run();

    const result = resolveContainedFolder(listContainedFolders()[0].id, "u1");
    expect(result?.removed.folderPath).toBe("Trip/Trip");
    expect(result?.keptIn.folderPath).toBe("Trip");
    // c1's tag went to p1 — the copy at the same relative path.
    const tagged = db.prepare(
      "SELECT entity_id FROM taggables WHERE tag_id = 't1' AND entity_type = 'library_item'"
    ).all() as { entity_id: string }[];
    expect(tagged.map((row) => row.entity_id)).toContain("p1");
  });

  it("refuses once a photo here no longer has a copy over there", () => {
    asset("p1", "Trip/one.jpg", { hash: "pic-1" });
    asset("p2", "Trip/two.jpg", { hash: "pic-2" });
    asset("c1", "Trip/Trip/one.jpg", { hash: "pic-1" });
    asset("c2", "Trip/Trip/two.jpg", { hash: "pic-2" });
    rebuildContainedFolders();
    const row = listContainedFolders()[0];

    db.prepare("UPDATE gallery_details SET content_hash = 'changed' WHERE item_id = 'p2'").run();
    expect(resolveContainedFolder(row.id, "u1")).toBeNull();
  });
});

// ── Preferred folders ───────────────────────────────────────────────────────

describe("preferred folders", () => {
  it("keeps the folder the admin chose, over the one that would otherwise win", () => {
    trip("Italy 2019", "a", { discoveredAt: "2023-01-01T00:00:00.000Z" });
    trip("Backup/holiday", "b", { discoveredAt: "2024-01-01T00:00:00.000Z" });

    rebuildDuplicateFolderGroups();
    expect(groupPaths()[0].keeper).toBe("Italy 2019");

    setFolderPreferences([{ libraryId: "GAL", folderPath: "Backup", mode: "keep" }]);
    rebuildDuplicateFolderGroups();
    const [group] = listDuplicateFolderGroups();
    expect(group.members.find((member) => member.isKeeper)?.folderPath).toBe("Backup/holiday");
    expect(group.keeperReason).toContain("chose to keep");
  });

  it("never proposes removing a folder the admin chose to keep", () => {
    asset("p1", "Trip/one.jpg", { hash: "pic-1" });
    asset("p2", "Trip/two.jpg", { hash: "pic-2" });
    asset("c1", "Trip/Trip/one.jpg", { hash: "pic-1" });
    asset("c2", "Trip/Trip/two.jpg", { hash: "pic-2" });

    setFolderPreferences([{ libraryId: "GAL", folderPath: "Trip/Trip", mode: "keep" }]);
    rebuildContainedFolders();
    expect(contained()).toEqual([]);
  });
});

// ── Clearing a folder out ───────────────────────────────────────────────────
//
// The inverse instruction: "these photos are filed properly elsewhere, so let this
// folder's copies go." It has to be safe against the obvious fear — that marking a
// folder means losing the photos only IT has.

describe("clearing a folder out", () => {
  it("loses to every other folder in a set, even one named like a copy", () => {
    trip("Consolidated", "a", { discoveredAt: "2024-01-01T00:00:00.000Z" });
    trip("Backup/holiday", "b", { discoveredAt: "2023-01-01T00:00:00.000Z" });

    setFolderPreferences([{ libraryId: "GAL", folderPath: "Consolidated", mode: "clear" }]);
    rebuildDuplicateFolderGroups();
    expect(groupPaths()[0].keeper).toBe("Backup/holiday");
  });

  it("offers the folder for removal once its photos are all elsewhere", () => {
    trip("Old drop", "a");
    trip("Trips/italy", "b");
    asset("b3", "Trips/italy/three.jpg", { hash: "pic-three" });

    setFolderPreferences([{ libraryId: "GAL", folderPath: "Old drop", mode: "clear" }]);
    rebuildDuplicateFolderGroups();
    rebuildContainedFolders();
    expect(contained()).toEqual(["Old drop ⊂ Trips/italy"]);
  });

  it("still keeps a copy when every folder in the set is being cleared out", () => {
    trip("A", "a");
    trip("B", "b");

    setFolderPreferences([
      { libraryId: "GAL", folderPath: "A", mode: "clear" },
      { libraryId: "GAL", folderPath: "B", mode: "clear" }
    ]);
    rebuildDuplicateFolderGroups();
    const [group] = listDuplicateFolderGroups();
    // No preferred survivor, so the ordinary criteria decide — one folder is still kept.
    expect(group.members.filter((member) => member.isKeeper)).toHaveLength(1);
  });

  it("never points photos at a folder being cleared out", () => {
    // Both Keepsafe and Old drop cover Inner, but one of them is on its way out.
    // Each covering folder holds a different extra, so no two are equal-contents —
    // that would be answered by the other tier instead.
    asset("i1", "Inner/one.jpg", { hash: "pic-one" });
    asset("i2", "Inner/two.jpg", { hash: "pic-two" });
    trip("Old drop", "a");
    asset("a3", "Old drop/extra-a.jpg", { hash: "pic-a" });
    trip("Keepsafe", "k");
    asset("k3", "Keepsafe/extra-k.jpg", { hash: "pic-k" });

    setFolderPreferences([{ libraryId: "GAL", folderPath: "Old drop", mode: "clear" }]);
    rebuildContainedFolders();
    const row = listContainedFolders().find((entry) => entry.folder.folderPath === "Inner");
    expect(row?.target.folderPath).toBe("Keepsafe");
  });

  it("reads the most specific instruction, so an exception inside a kept folder holds", () => {
    trip("Photos/keepers", "a", { discoveredAt: "2024-01-01T00:00:00.000Z" });
    trip("Photos/unsorted", "b", { discoveredAt: "2023-01-01T00:00:00.000Z" });

    setFolderPreferences([
      { libraryId: "GAL", folderPath: "Photos", mode: "keep" },
      { libraryId: "GAL", folderPath: "Photos/unsorted", mode: "clear" }
    ]);
    rebuildDuplicateFolderGroups();
    expect(groupPaths()[0].keeper).toBe("Photos/keepers");
  });

  it("says so when it keeps a copy inside a folder being cleared out", () => {
    // Both copies inside the cleared folder: one is still kept (clearing never empties
    // a folder), and the reason has to admit it or the setting reads as ignored.
    asset("a1", "Duplicates/one.jpg", { hash: "pic-one" });
    asset("a2", "Duplicates/anothercopy/one.jpg", { hash: "pic-one" });

    setFolderPreferences([{ libraryId: "GAL", folderPath: "Duplicates", mode: "clear" }]);
    rebuildExactDuplicateGroups();
    const [group] = listDuplicateGroups();
    expect(group.keeperReason).toContain("clearing out");
  });

  it("lets a more specific clear-out beat the folder it sits in", () => {
    asset("a1", "Duplicates/one.jpg", { hash: "pic-one", discoveredAt: "2024-06-01T00:00:00.000Z" });
    asset("a2", "Duplicates/anothercopy/one.jpg", { hash: "pic-one", discoveredAt: "2023-01-01T00:00:00.000Z" });

    // The inner folder is the longest match for the inner copy, so it loses even
    // though it was added first — which is what marking the inner folder is for.
    setFolderPreferences([
      { libraryId: "GAL", folderPath: "Duplicates", mode: "keep" },
      { libraryId: "GAL", folderPath: "Duplicates/anothercopy", mode: "clear" }
    ]);
    rebuildExactDuplicateGroups();
    const [group] = listDuplicateGroups();
    expect(group.members.find((member) => member.isKeeper)?.path).toBe("Duplicates/one.jpg");
  });
});

describe("no pair reported twice", () => {
  it("defers to the equal-contents set even when the folder is being cleared out", () => {
    // Two folders, same contents, one marked for clearing. The equal-contents set
    // already offers exactly this removal — and honours the mark in its keeper choice —
    // so a containment row for the same pair would be the same answer twice.
    trip("Duplicates", "a");
    trip("anothercopy", "b");
    setFolderPreferences([{ libraryId: "GAL", folderPath: "Duplicates", mode: "clear" }]);

    rebuildDuplicateFolderGroups();
    rebuildContainedFolders();

    expect(listDuplicateFolderGroups()).toHaveLength(1);
    expect(listContainedFolders()).toEqual([]);
    // And the mark decides which of the two goes.
    expect(groupPaths()[0].keeper).toBe("anothercopy");
  });
});

describe("stale results can't be displayed", () => {
  it("hides a contained row for a pair the equal-contents tier already answers", () => {
    // The shape a version upgrade leaves behind: both caches persist independently, so
    // a row written before the deferral rule existed would show the same two folders
    // twice — once per section — until something happened to rebuild.
    trip("Duplicates", "a");
    trip("anothercopy", "b");
    rebuildDuplicateFolderGroups();
    rebuildContainedFolders();
    expect(listContainedFolders()).toEqual([]);

    // Write the stale row straight into the table, as an older build would have.
    db.prepare(`
      INSERT INTO gallery_duplicate_contained_folders
        (id, library_id, folder_path, target_library_id, target_folder_path, item_count, bytes, extra_count)
      VALUES ('stale', 'GAL', 'Duplicates', 'GAL', 'anothercopy', 2, 2000, 0)
    `).run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM gallery_duplicate_contained_folders").get()).toEqual({ n: 1 });

    // Stored, but never shown — the read filters it as the rebuild would have.
    expect(listContainedFolders()).toEqual([]);
  });

  it("still shows a contained row the equal-contents tier says nothing about", () => {
    asset("p1", "Trip/one.jpg", { hash: "pic-1" });
    asset("p2", "Trip/two.jpg", { hash: "pic-2" });
    asset("c1", "Trip/Trip/one.jpg", { hash: "pic-1" });
    asset("c2", "Trip/Trip/two.jpg", { hash: "pic-2" });

    rebuildDuplicateFolderGroups();
    rebuildContainedFolders();
    expect(listContainedFolders().map((row) => row.folder.folderPath)).toEqual(["Trip/Trip"]);
  });
});
