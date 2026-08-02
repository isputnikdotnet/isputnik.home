import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { trashBook, purgeTrashedItem } from "../src/modules/library/shared/trash.js";
import { thumbnailPathSettingKey, thumbnailStorageKey, thumbnailAbsolutePath } from "../src/modules/library/shared/thumbnail.js";
import { resetDb, makeUser, makeLibrary } from "./helpers/seed.js";

// The Recycle Bin shows what an item was, which means its cover has to survive the
// trip to the bin — everything else about the item is torn down at that moment.
let sourceRoot = "";

function coverKeyFor(itemId: string) {
  return thumbnailStorageKey("LIB", itemId, `${itemId}-cover.webp`);
}

// A catalogued audiobook with a real file on disk and a real cover in the store.
function makeBookWithCover(id: string, withCover = true): string {
  fs.mkdirSync(path.join(sourceRoot, id), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, id, "part1.mp3"), "AUDIO");
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, 'LIB', 'audiobook', ?, 'ready')")
    .run(id, id);
  db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES (?, 'scan', ?)").run(id, `Title ${id}`);
  if (withCover) {
    const absolute = thumbnailAbsolutePath(coverKeyFor(id));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, "COVERBYTES");
  }
  return id;
}

beforeEach(() => {
  resetDb();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "trash-cover-"));
  sourceRoot = path.join(base, "library");
  const thumbRoot = path.join(base, "thumbs");
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(thumbRoot);
  makeUser("u1", "admin");
  db.prepare("INSERT OR REPLACE INTO storage_roots (id, name, path, created_by) VALUES ('sr1', 'test', ?, 'u1')").run(base);
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(thumbnailPathSettingKey, thumbRoot);
  makeLibrary("LIB", { createdBy: "u1", type: "audiobook" });
  db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'LIB'").run(sourceRoot);
});

describe("recycle bin covers", () => {
  it("keeps the cover file and records its key on the bin row", () => {
    const id = makeBookWithCover("bk1");
    const key = coverKeyFor(id);

    trashBook(id, "u1");

    const row = db.prepare("SELECT cover_key FROM trashed_items").get() as { cover_key: string | null };
    expect(row.cover_key).toBe(key);
    expect(fs.existsSync(thumbnailAbsolutePath(key))).toBe(true);
  });

  it("still removes the large cover, which the bin never shows", () => {
    const id = makeBookWithCover("bk2");
    const largeKey = thumbnailStorageKey("LIB", id, `${id}-cover-large.webp`);
    const largeAbsolute = thumbnailAbsolutePath(largeKey);
    fs.mkdirSync(path.dirname(largeAbsolute), { recursive: true });
    fs.writeFileSync(largeAbsolute, "BIGCOVER");

    trashBook(id, "u1");

    expect(fs.existsSync(thumbnailAbsolutePath(coverKeyFor(id)))).toBe(true);
    expect(fs.existsSync(largeAbsolute)).toBe(false);
  });

  it("records nothing for an item with no cover on disk", () => {
    const id = makeBookWithCover("bk3", false);
    trashBook(id, "u1");
    expect((db.prepare("SELECT cover_key FROM trashed_items").get() as { cover_key: string | null }).cover_key).toBeNull();
  });

  it("deletes the kept cover when the item is purged", () => {
    const id = makeBookWithCover("bk4");
    const key = coverKeyFor(id);
    trashBook(id, "u1");
    const trashedId = (db.prepare("SELECT id FROM trashed_items").get() as { id: string }).id;

    expect(purgeTrashedItem(trashedId)).not.toBeNull();
    expect(fs.existsSync(thumbnailAbsolutePath(key))).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM trashed_items").get()).toEqual({ n: 0 });
  });
});
