// Thumbnail-store cleanup when a library is deleted: removeThumbnailsForLibrary
// (the delete-route cleanup) and sweepOrphanLibraryThumbnails (the startup mop-up
// for buckets orphaned before the delete routes removed files).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import {
  thumbnailPathSettingKey, removeThumbnailsForLibrary, sweepOrphanLibraryThumbnails
} from "../src/modules/library/shared/thumbnail.js";
import { resetDb, makeUser, makeLibrary } from "./helpers/seed.js";

describe("library thumbnail cleanup", () => {
  let root: string;

  beforeEach(() => {
    resetDb();
    makeUser("u1");
    root = fs.mkdtempSync(path.join(os.tmpdir(), "thumb-cleanup-"));
    db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(thumbnailPathSettingKey, root);
  });

  afterEach(() => {
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(thumbnailPathSettingKey);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const file = (...segments: string[]) => {
    const abs = path.join(root, ...segments);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "x");
    return abs;
  };

  describe("removeThumbnailsForLibrary", () => {
    it("deletes the library's bucket and leaves other buckets alone", () => {
      const gone = file("LIB1", "aa", "bb", "item1-cover.webp");
      file("LIB1", "aa", "bb", "item1-cover-large.webp");
      file("LIB1", "cc", "dd", "face1-face.webp");
      const otherLib = file("LIB2", "aa", "bb", "item2-cover.webp");
      const person = file("people", "aa", "bb", "author-photo.webp");

      removeThumbnailsForLibrary("LIB1");

      expect(fs.existsSync(gone)).toBe(false);
      expect(fs.existsSync(path.join(root, "LIB1"))).toBe(false);
      expect(fs.existsSync(otherLib)).toBe(true);
      expect(fs.existsSync(person)).toBe(true);
    });

    it("refuses ids that would escape or delete the store root", () => {
      const inside = file("LIB1", "aa", "bb", "item1-cover.webp");

      removeThumbnailsForLibrary("");
      removeThumbnailsForLibrary("..");
      removeThumbnailsForLibrary(".");

      expect(fs.existsSync(root)).toBe(true);
      expect(fs.existsSync(inside)).toBe(true);
    });

    // Skipped if a THUMBNAIL_PATH env fallback exists — the store would then still
    // resolve and this test's premise (unconfigured store) doesn't hold.
    it.skipIf(!!process.env.THUMBNAIL_PATH)("is a safe no-op when the thumbnail store is not configured", () => {
      db.prepare("DELETE FROM app_settings WHERE key = ?").run(thumbnailPathSettingKey);
      expect(() => removeThumbnailsForLibrary("LIB1")).not.toThrow();
    });
  });

  describe("sweepOrphanLibraryThumbnails", () => {
    // Library-id-shaped bucket names (nanoid(16) alphabet, 16 chars).
    const LIVE_ID = "LiveLib_16chars0";
    const ORPHAN_ID = "GoneLib_16chars0";
    const ORPHAN_MIXED_ID = "MixdLib_16chars0";

    it("removes only id-shaped, all-webp buckets with no matching library", () => {
      makeLibrary(LIVE_ID, { createdBy: "u1", type: "gallery" });
      const live = file(LIVE_ID, "aa", "bb", "item1-cover.webp");
      const orphan = file(ORPHAN_ID, "aa", "bb", "item2-cover.webp");
      file(ORPHAN_ID, "cc", "dd", "face2-face.webp");
      // An orphaned-looking bucket holding a non-thumbnail file is left untouched.
      const mixed = file(ORPHAN_MIXED_ID, "aa", "notes.txt");
      // Shared buckets and non-id-shaped directories are never candidates.
      const person = file("people", "aa", "bb", "author-photo.webp");
      const category = file("categories", "aa", "bb", "cat.webp");
      const shortName = file("stray", "old.webp");

      expect(sweepOrphanLibraryThumbnails()).toBe(1);

      expect(fs.existsSync(path.join(root, ORPHAN_ID))).toBe(false);
      expect(fs.existsSync(orphan)).toBe(false);
      expect(fs.existsSync(live)).toBe(true);
      expect(fs.existsSync(mixed)).toBe(true);
      expect(fs.existsSync(person)).toBe(true);
      expect(fs.existsSync(category)).toBe(true);
      expect(fs.existsSync(shortName)).toBe(true);
    });

    it("returns 0 on an empty or clean store", () => {
      expect(sweepOrphanLibraryThumbnails()).toBe(0);
      makeLibrary(LIVE_ID, { createdBy: "u1", type: "gallery" });
      file(LIVE_ID, "aa", "bb", "item1-cover.webp");
      expect(sweepOrphanLibraryThumbnails()).toBe(0);
    });

    it.skipIf(!!process.env.THUMBNAIL_PATH)("is a safe no-op when the thumbnail store is not configured", () => {
      db.prepare("DELETE FROM app_settings WHERE key = ?").run(thumbnailPathSettingKey);
      expect(sweepOrphanLibraryThumbnails()).toBe(0);
    });
  });
});
