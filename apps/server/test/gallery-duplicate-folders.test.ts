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
  pickFolderKeeper
} from "../src/modules/library/gallery/duplicate-folders.js";
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
