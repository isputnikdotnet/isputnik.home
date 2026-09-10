import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { deleteAllReplacedOriginals, deleteReplacedOriginal, listReplacedOriginals } from "../src/modules/library/gallery/replaced.js";
import { setTrashRootSetting } from "../src/modules/library/shared/trash.js";
import { resetDb, makeUser, makeLibrary } from "./helpers/seed.js";

// The originals Replace file sets aside have no rows, so the Recycle Bin page
// lists them straight from disk — under the bin root and under each library's
// own .trash — and lets them go one at a time or all at once.

let base = "";
let bin = "";
let gallery = "";

function keep(root: string, libraryId: string, itemId: string, fileName: string, bytes = "JPG"): string {
  const dir = path.join(root, "replaced", libraryId, itemId);
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, fileName);
  fs.writeFileSync(abs, bytes);
  return abs;
}

beforeEach(() => {
  resetDb();
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "replaced-")));
  bin = path.join(base, "bin");
  gallery = path.join(base, "gallery");
  fs.mkdirSync(bin);
  fs.mkdirSync(gallery);
  makeUser("u1", "admin");
  db.prepare("INSERT OR REPLACE INTO storage_roots (id, name, path, created_by) VALUES ('sr1', 'test', ?, 'u1')").run(base);
  makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
  db.prepare("UPDATE libraries SET name = 'Family', source_path = ? WHERE id = 'GAL'").run(gallery);
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES ('p1', 'GAL', 'gallery', '2026/one.jpg', 'ready')").run();
  db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES ('p1', 'scan', 'One')").run();
});

describe("replaced originals", () => {
  it("lists them from the bin root and each library's .trash, newest first, naming the photo when it still exists", () => {
    setTrashRootSetting(bin, "u1");
    keep(bin, "GAL", "p1", "2026-09-03T21-32-59-482Z-FL000021.jpg", "ABCDE");
    keep(bin, "GAL", "gone", "2026-09-08T03-35-17-484Z-img.png", "PNG");
    keep(path.join(gallery, ".trash"), "GAL", "p1", "2026-09-01T10-00-00-000Z-old.jpg");
    keep(bin, "GAL", "p1", "hand-placed.jpg");

    const list = listReplacedOriginals();
    expect(list.map((o) => o.fileName)).toEqual([
      "2026-09-08T03-35-17-484Z-img.png",
      "2026-09-03T21-32-59-482Z-FL000021.jpg",
      "2026-09-01T10-00-00-000Z-old.jpg",
      "hand-placed.jpg"
    ]);
    const first = list[1];
    expect(first).toMatchObject({
      libraryId: "GAL", libraryName: "Family", itemId: "p1", itemTitle: "One", itemExists: true,
      originalName: "FL000021.jpg", keptAt: "2026-09-03T21:32:59.482Z", size: 5, root: "bin"
    });
    expect(list[0]).toMatchObject({ itemId: "gone", itemTitle: null, itemExists: false });
    expect(list[2].root).toBe("GAL");
    expect(list[3]).toMatchObject({ keptAt: null, originalName: "hand-placed.jpg" });
  });

  it("deletes one by its key, pruning the emptied folders, and refuses a key that points elsewhere", () => {
    setTrashRootSetting(bin, "u1");
    const abs = keep(bin, "GAL", "p1", "2026-09-03T21-32-59-482Z-FL000021.jpg", "ABCDE");
    const other = path.join(base, "elsewhere.txt");
    fs.writeFileSync(other, "KEEP ME");
    const [only] = listReplacedOriginals();

    const forged = Buffer.from(JSON.stringify({ kind: "bin", relative: "../../elsewhere.txt" }), "utf8").toString("base64url");
    expect(deleteReplacedOriginal(forged)).toBeNull();
    expect(deleteReplacedOriginal("not-a-key")).toBeNull();
    expect(fs.existsSync(other)).toBe(true);

    expect(deleteReplacedOriginal(only.key)).toEqual({ fileName: "2026-09-03T21-32-59-482Z-FL000021.jpg", size: 5 });
    expect(fs.existsSync(abs)).toBe(false);
    expect(fs.existsSync(path.join(bin, "replaced", "GAL"))).toBe(false);
    expect(deleteReplacedOriginal(only.key)).toBeNull();
    expect(listReplacedOriginals()).toEqual([]);
  });

  it("empties them all and reports the count and bytes", () => {
    setTrashRootSetting(bin, "u1");
    keep(bin, "GAL", "p1", "2026-09-03T21-32-59-482Z-a.jpg", "AAAA");
    keep(path.join(gallery, ".trash"), "GAL", "p1", "2026-09-01T10-00-00-000Z-b.jpg", "BB");
    expect(deleteAllReplacedOriginals()).toEqual({ files: 2, bytes: 6 });
    expect(listReplacedOriginals()).toEqual([]);
  });
});
