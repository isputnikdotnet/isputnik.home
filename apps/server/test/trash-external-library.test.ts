import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { trashBook, libraryAllowsDelete } from "../src/modules/library/shared/trash.js";
import { thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import { resetDb, makeUser, makeLibrary } from "./helpers/seed.js";

// An external library is somewhere the app READS. Its files belong to something else
// — another program, a share the household fills by hand — and nothing here may
// delete out of it, whatever anyone's role says.
//
// The item routes have always checked this. The duplicate finders never did: they
// call trashBook directly, they act on sets that span libraries, and a set with one
// copy in an external library was a delete button over a file the app doesn't own.
// So the check lives in trashBook, where every path to a deletion passes through.
let sourceRoot = "";

function makePhoto(id: string): string {
  fs.writeFileSync(path.join(sourceRoot, `${id}.jpg`), "JPEGBYTES");
  db.prepare(
    "INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, 'GAL', 'gallery', ?, 'ready')"
  ).run(id, `${id}.jpg`);
  db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES (?, 'scan', ?)").run(id, id);
  return id;
}

const setPolicy = (policy: Record<string, unknown>): void => {
  db.prepare("UPDATE libraries SET policy_json = ? WHERE id = 'GAL'").run(JSON.stringify(policy));
};

beforeEach(() => {
  resetDb();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "trash-external-"));
  sourceRoot = path.join(base, "library");
  const thumbRoot = path.join(base, "thumbs");
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(thumbRoot);
  makeUser("u1", "admin");
  db.prepare("INSERT OR REPLACE INTO storage_roots (id, name, path, created_by) VALUES ('sr1', 'test', ?, 'u1')").run(base);
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(thumbnailPathSettingKey, thumbRoot);
  makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
  db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'GAL'").run(sourceRoot);
});

describe("deleting out of a library that forbids it", () => {
  it("refuses when the library is external, and changes nothing", () => {
    const id = makePhoto("p1");
    setPolicy({ mode: "external" });

    expect(() => trashBook(id, "u1")).toThrowError(/external/i);

    // The item is still catalogued, nothing reached the bin, the file never moved.
    expect(db.prepare("SELECT COUNT(*) AS n FROM library_items WHERE id = ? AND deleted_at IS NULL").get(id))
      .toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM trashed_items").get()).toEqual({ n: 0 });
    expect(fs.existsSync(path.join(sourceRoot, "p1.jpg"))).toBe(true);
    expect(fs.existsSync(path.join(sourceRoot, ".trash"))).toBe(false);
  });

  it("refuses when the library merely turns deleting off", () => {
    const id = makePhoto("p2");
    setPolicy({ mode: "managed", allowDelete: false });

    expect(() => trashBook(id, "u1")).toThrowError(/deleting turned off|can't be removed/i);
    expect(db.prepare("SELECT COUNT(*) AS n FROM trashed_items").get()).toEqual({ n: 0 });
  });

  it("still deletes from an ordinary managed library", () => {
    const id = makePhoto("p3");
    setPolicy({ mode: "managed" });

    expect(libraryAllowsDelete("GAL")).toBe(true);
    expect(() => trashBook(id, "u1")).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM trashed_items").get()).toEqual({ n: 1 });
  });

  it("treats a library with no policy at all as managed", () => {
    // The default: {} means managed, and deleting is allowed.
    expect(libraryAllowsDelete("GAL")).toBe(true);
    // And an unknown library is never deletable — the safe answer to "no such row".
    expect(libraryAllowsDelete("nope")).toBe(false);
  });
});
