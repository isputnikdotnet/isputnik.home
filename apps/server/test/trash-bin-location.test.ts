import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import {
  trashBook,
  restoreTrashedItem,
  purgeTrashedItem,
  setTrashRootSetting,
  validateTrashRootPath,
  binIsEmpty,
  binFolderFor,
  TrashError
} from "../src/modules/library/shared/trash.js";
import { thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import { resetDb, makeUser, makeLibrary } from "./helpers/seed.js";

// One bin folder for every library, chosen on the Storage page, instead of a .trash
// inside each library. The point is that nothing else walking the share sees deleted
// files as live — so the bin must end up OUTSIDE the library tree, and a restore has to
// find its way back from there.
let base = "";
let sourceRoot = "";
let binRoot = "";

function makeBook(id: string): string {
  fs.mkdirSync(path.join(sourceRoot, id), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, id, "part1.mp3"), "AUDIO");
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, 'LIB', 'audiobook', ?, 'ready')")
    .run(id, id);
  db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES (?, 'scan', ?)").run(id, `Title ${id}`);
  return id;
}

function binRow() {
  return db.prepare("SELECT * FROM trashed_items LIMIT 1").get() as
    { id: string; trash_root: string | null; trash_path: string; source_path: string };
}

beforeEach(() => {
  resetDb();
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trash-bin-")));
  sourceRoot = path.join(base, "library");
  binRoot = path.join(base, "recycle-bin");
  const thumbRoot = path.join(base, "thumbs");
  for (const dir of [sourceRoot, binRoot, thumbRoot]) fs.mkdirSync(dir);
  makeUser("u1", "admin");
  db.prepare("INSERT OR REPLACE INTO storage_roots (id, name, path, created_by) VALUES ('sr1', 'test', ?, 'u1')").run(base);
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(thumbnailPathSettingKey, thumbRoot);
  makeLibrary("LIB", { createdBy: "u1", type: "audiobook" });
  db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'LIB'").run(sourceRoot);
});

describe("Recycle Bin location", () => {
  it("keeps files in the library's own .trash by default", () => {
    trashBook(makeBook("bk1"), "u1");

    const row = binRow();
    expect(row.trash_root).toBeNull();
    expect(row.trash_path.startsWith(".trash/")).toBe(true);
    expect(fs.existsSync(path.join(sourceRoot, row.trash_path, "bk1", "part1.mp3"))).toBe(true);
    expect(binFolderFor(row as never)).toBe(path.join(sourceRoot, ".trash"));
  });

  it("puts files under <bin>/<library>/<token> when a bin folder is set", () => {
    setTrashRootSetting(binRoot, "u1");
    trashBook(makeBook("bk1"), "u1");

    const row = binRow();
    expect(row.trash_root).toBe(binRoot);
    expect(row.trash_path.startsWith("LIB/")).toBe(true);
    // Out of the library entirely — the reason the setting exists.
    expect(fs.existsSync(path.join(sourceRoot, ".trash"))).toBe(false);
    expect(fs.existsSync(path.join(binRoot, row.trash_path, "bk1", "part1.mp3"))).toBe(true);
    expect(binFolderFor(row as never)).toBe(path.join(binRoot, "LIB"));
  });

  it("restores from the bin folder back into the library", async () => {
    setTrashRootSetting(binRoot, "u1");
    trashBook(makeBook("bk1"), "u1");
    const row = binRow();

    await restoreTrashedItem(row.id);

    expect(fs.existsSync(path.join(sourceRoot, "bk1", "part1.mp3"))).toBe(true);
    expect(fs.existsSync(path.join(binRoot, row.trash_path))).toBe(false);
    // The library folder inside the bin is cleaned up once it holds nothing…
    expect(fs.existsSync(path.join(binRoot, "LIB"))).toBe(false);
    // …but the bin itself is a folder someone chose, so it stays.
    expect(fs.existsSync(binRoot)).toBe(true);
  });

  it("purges the files out of the bin folder", () => {
    setTrashRootSetting(binRoot, "u1");
    trashBook(makeBook("bk1"), "u1");
    const row = binRow();

    expect(purgeTrashedItem(row.id)).not.toBeNull();
    expect(fs.existsSync(path.join(binRoot, row.trash_path))).toBe(false);
    expect(fs.existsSync(binRoot)).toBe(true);
  });

  it("still finds a row's files after the setting changes underneath it", () => {
    setTrashRootSetting(binRoot, "u1");
    trashBook(makeBook("bk1"), "u1");
    const row = binRow();

    // The API refuses this while the bin has anything in it; the column is what makes
    // the refusal a policy rather than the only thing standing between us and lost files.
    setTrashRootSetting(null, "u1");

    expect(binFolderFor(row as never)).toBe(path.join(binRoot, "LIB"));
    expect(purgeTrashedItem(row.id)).not.toBeNull();
    expect(fs.existsSync(path.join(binRoot, row.trash_path))).toBe(false);
  });

  it("refuses a bin inside a library, or one containing a library", () => {
    expect(() => validateTrashRootPath(path.join(sourceRoot))).toThrowError(TrashError);
    expect(() => validateTrashRootPath(sourceRoot)).toThrowError(/inside the library/i);
    // base holds the library, so a bin there would contain it.
    expect(() => validateTrashRootPath(base)).toThrowError(/must not contain a library/i);
  });

  it("refuses a folder outside every storage container, or one that isn't there", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    expect(() => validateTrashRootPath(outside)).toThrowError(/configured Digital Library container/i);
    expect(() => validateTrashRootPath(path.join(base, "nope"))).toThrowError(/missing or not accessible/i);
  });

  it("knows whether the bin is empty, which is when the location may change", () => {
    expect(binIsEmpty()).toBe(true);
    trashBook(makeBook("bk1"), "u1");
    expect(binIsEmpty()).toBe(false);
    purgeTrashedItem(binRow().id);
    expect(binIsEmpty()).toBe(true);
  });
});
