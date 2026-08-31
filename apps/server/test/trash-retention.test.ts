import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import {
  trashBook,
  purgeExpiredTrash,
  setTrashRetentionDays,
  setCleanupRetentionDays,
  getCleanupRetentionDays
} from "../src/modules/library/shared/trash.js";
import { thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import { resetDb, makeUser, makeLibrary } from "./helpers/seed.js";

// Two clocks — the bin's own, and a shorter one for duplicate cleanup, which can put
// thousands of files in the bin at once. What matters is WHEN each is read: the date is
// decided as the item goes in, so changing a setting afterwards cannot reach back and
// shorten a promise already made.
let sourceRoot = "";

function makeBook(id: string): string {
  fs.mkdirSync(path.join(sourceRoot, id), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, id, "part1.mp3"), "AUDIO");
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, 'LIB', 'audiobook', ?, 'ready')")
    .run(id, id);
  db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES (?, 'scan', ?)").run(id, `Title ${id}`);
  return id;
}

function binRow(itemTitle: string) {
  return db.prepare("SELECT source, expires_at FROM trashed_items WHERE title = ?").get(itemTitle) as
    { source: string; expires_at: string | null };
}

// Days from now, as the bin row stores it.
function daysFromNow(expiresAt: string): number {
  return Math.round((Date.parse(expiresAt) - Date.now()) / 86_400_000);
}

beforeEach(() => {
  resetDb();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "trash-retention-"));
  sourceRoot = path.join(base, "library");
  const thumbRoot = path.join(base, "thumbs");
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(thumbRoot);
  makeUser("u1", "admin");
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(thumbnailPathSettingKey, thumbRoot);
  db.prepare("INSERT OR REPLACE INTO storage_roots (id, name, path, created_by) VALUES ('sr1', 'test', ?, 'u1')").run(base);
  makeLibrary("LIB", { createdBy: "u1", type: "audiobook" });
  db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'LIB'").run(sourceRoot);
});

describe("recycle bin retention", () => {
  it("stamps a hand delete with the bin's own window", () => {
    setTrashRetentionDays(30);
    trashBook(makeBook("bk1"), "u1");

    const row = binRow("Title bk1");
    expect(row.source).toBe("manual");
    expect(daysFromNow(row.expires_at!)).toBe(30);
  });

  it("gives duplicate cleanup its own, shorter clock", () => {
    setTrashRetentionDays(30);
    setCleanupRetentionDays(7);

    trashBook(makeBook("bk1"), "u1");
    trashBook(makeBook("bk2"), "u1", { source: "duplicate_cleanup" });

    expect(daysFromNow(binRow("Title bk1").expires_at!)).toBe(30);
    const cleanup = binRow("Title bk2");
    expect(cleanup.source).toBe("duplicate_cleanup");
    expect(daysFromNow(cleanup.expires_at!)).toBe(7);
  });

  it("follows the bin when duplicate cleanup has no clock of its own", () => {
    setTrashRetentionDays(21);
    expect(getCleanupRetentionDays()).toBeNull();

    trashBook(makeBook("bk1"), "u1", { source: "duplicate_cleanup" });

    expect(daysFromNow(binRow("Title bk1").expires_at!)).toBe(21);
  });

  it("keeps an item for ever when its window is 0", () => {
    setTrashRetentionDays(30);
    setCleanupRetentionDays(0); // explicitly chosen, which is not the same as unset
    trashBook(makeBook("bk1"), "u1", { source: "duplicate_cleanup" });

    expect(binRow("Title bk1").expires_at).toBeNull();
    expect(purgeExpiredTrash()).toEqual({ purged: 0, eligible: 0 });
  });

  it("purges on the date the item carries, not on today's setting", () => {
    setTrashRetentionDays(30);
    trashBook(makeBook("bk1"), "u1");
    trashBook(makeBook("bk2"), "u1");

    // One is now past its date; the other is not. Shortening the window afterwards
    // must not condemn the second — it was deleted under a promise of 30 days.
    db.prepare("UPDATE trashed_items SET expires_at = datetime('now', '-1 day') WHERE title = 'Title bk1'").run();
    setTrashRetentionDays(1);

    expect(purgeExpiredTrash()).toEqual({ purged: 1, eligible: 1 });
    const left = db.prepare("SELECT title FROM trashed_items").all() as { title: string }[];
    expect(left.map((row) => row.title)).toEqual(["Title bk2"]);
  });
});
