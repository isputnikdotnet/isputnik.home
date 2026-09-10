import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { planFolderMove, queueFolderMove, normaliseFolder } from "../src/modules/library/gallery/folder-move.js";
import { folderMoveStatuses, waitForStorageMoves, STORAGE_MOVE_JOB_TYPE } from "../src/modules/library/shared/storage-move.js";
import { thumbnailAbsolutePath, thumbnailPathSettingKey, thumbnailStorageKey } from "../src/modules/library/shared/thumbnail.js";
import { setFolderLock, listFolderLocks } from "../src/modules/library/shared/folder-locks.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

// Moving a folder of one gallery library into another (gallery/folder-move.ts):
// the files travel as a storage move task; the items keep their ids and are
// re-pointed with their thumbnails, previews, face crops and folder locks.

let base = "";
let thumbs = "";
let src = "";
let dst = "";

function makeGallery(id: string, name: string, dir: string, extraPolicy: Record<string, unknown> = {}): void {
  makeLibrary(id, { createdBy: "u1", type: "gallery" });
  fs.mkdirSync(dir, { recursive: true });
  db.prepare("UPDATE libraries SET name = ?, source_path = ?, policy_json = ? WHERE id = ?")
    .run(name, dir, JSON.stringify({ mode: "managed", ...extraPolicy }), id);
  grant("group", EVERYONE_GROUP_ID, id, "member");
}

function makePhoto(libraryId: string, dir: string, id: string, relativePath: string): void {
  const abs = path.join(dir, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `JPEG-${id}`);
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, ?, 'gallery', ?, 'ready')").run(id, libraryId, relativePath);
  const cover = thumbnailStorageKey(libraryId, id, `${id}-cover.webp`);
  const preview = thumbnailStorageKey(libraryId, id, `${id}-cover-large.webp`);
  for (const key of [cover, preview]) {
    const file = thumbnailAbsolutePath(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "WEBP");
  }
  db.prepare("INSERT INTO item_metadata (item_id, source, title, cover_storage_key) VALUES (?, 'scan', ?, ?)").run(id, id, cover);
  db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path, size, preview_storage_key) VALUES (?, 'photo', ?, 9, ?)").run(id, relativePath, preview);
}

beforeEach(() => {
  resetDb();
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folder-move-")));
  thumbs = path.join(base, "thumbs");
  src = path.join(base, "random");
  dst = path.join(base, "phone");
  fs.mkdirSync(thumbs);
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run(thumbnailPathSettingKey, thumbs);
  makeUser("u1", "admin");
  db.prepare("INSERT OR REPLACE INTO storage_roots (id, name, path, created_by) VALUES ('sr1', 'test', ?, 'u1')").run(base);
  makeGallery("RANDOM", "Random", src);
  makeGallery("PHONE", "Current Phone", dst);
  makePhoto("RANDOM", src, "v1", "2026/2026-09-04/clip-one.mp4");
  makePhoto("RANDOM", src, "v2", "2026/2026-09-05/clip-two.mp4");
  makePhoto("RANDOM", src, "m1", "Slideshow music/song.mp3");
  // A face crop on one of them, and a lock on the dated folder.
  const face = thumbnailStorageKey("RANDOM", "face1", "face1-face.webp");
  fs.mkdirSync(path.dirname(thumbnailAbsolutePath(face)), { recursive: true });
  fs.writeFileSync(thumbnailAbsolutePath(face), "FACE");
  db.prepare("INSERT INTO gallery_faces (id, item_id, thumb_storage_key, assignment) VALUES ('face1', 'v1', ?, 'auto')").run(face);
  setFolderLock("RANDOM", "2026/2026-09-05", true, "u1");
});

describe("moving a folder to another library", () => {
  it("normalises folder paths and refuses the root, a photo Inbox and an existing destination", () => {
    expect(normaliseFolder("\\2026\\")).toBe("2026");
    expect(normaliseFolder("..")).toBeNull();
    expect(() => planFolderMove("RANDOM", "", "PHONE")).toThrowError(/Choose a folder/);
    expect(() => planFolderMove("RANDOM", "2026", "RANDOM")).toThrowError(/already in/);
    makeGallery("INBOX", "Inbox", path.join(base, "inbox"), { inbox: true });
    expect(() => planFolderMove("RANDOM", "2026", "INBOX")).toThrowError(/Photo Inbox/);
    fs.mkdirSync(path.join(dst, "2026"));
    fs.writeFileSync(path.join(dst, "2026", "theirs.jpg"), "X");
    expect(() => planFolderMove("RANDOM", "2026", "PHONE")).toThrowError(/already has/);
    const plan = planFolderMove("RANDOM", "Slideshow music", "PHONE");
    expect(plan).toMatchObject({ folder: "Slideshow music", items: 1, from: path.join(src, "Slideshow music"), to: path.join(dst, "Slideshow music") });
  });

  it("moves the folder as a task and re-points items, thumbnails, face crops and locks; other folders stay", async () => {
    const { plan, status } = queueFolderMove("RANDOM", "2026", "PHONE", "u1");
    expect(plan.items).toBe(2);
    expect(status.running).toBe(true);
    await waitForStorageMoves();

    const items = db.prepare("SELECT id, library_id, folder_path FROM library_items WHERE id IN ('v1','v2','m1') ORDER BY id").all() as { id: string; library_id: string; folder_path: string }[];
    expect(items).toEqual([
      { id: "m1", library_id: "RANDOM", folder_path: "Slideshow music/song.mp3" },
      { id: "v1", library_id: "PHONE", folder_path: "2026/2026-09-04/clip-one.mp4" },
      { id: "v2", library_id: "PHONE", folder_path: "2026/2026-09-05/clip-two.mp4" }
    ]);
    expect(fs.readFileSync(path.join(dst, "2026", "2026-09-04", "clip-one.mp4"), "utf8")).toBe("JPEG-v1");
    expect(fs.existsSync(path.join(src, "2026"))).toBe(false);
    expect(fs.existsSync(path.join(src, "Slideshow music", "song.mp3"))).toBe(true);
    // Thumbnails, preview and the face crop moved to the new library's bucket, keys with them.
    const cover = (db.prepare("SELECT cover_storage_key AS k FROM item_metadata WHERE item_id = 'v1'").get() as { k: string }).k;
    expect(cover.startsWith("PHONE/")).toBe(true);
    expect(fs.existsSync(thumbnailAbsolutePath(cover))).toBe(true);
    const details = db.prepare("SELECT relative_path, preview_storage_key FROM gallery_details WHERE item_id = 'v2'").get() as { relative_path: string; preview_storage_key: string };
    expect(details.relative_path).toBe("2026/2026-09-05/clip-two.mp4");
    expect(details.preview_storage_key.startsWith("PHONE/")).toBe(true);
    expect(fs.existsSync(thumbnailAbsolutePath(details.preview_storage_key))).toBe(true);
    const face = (db.prepare("SELECT thumb_storage_key AS k FROM gallery_faces WHERE id = 'face1'").get() as { k: string }).k;
    expect(face.startsWith("PHONE/")).toBe(true);
    expect(fs.existsSync(thumbnailAbsolutePath(face))).toBe(true);
    // The lock followed the folder.
    expect(listFolderLocks("RANDOM").map((lock) => lock.folderPath)).toEqual([]);
    expect(listFolderLocks("PHONE").map((lock) => lock.folderPath)).toEqual(["2026/2026-09-05"]);
    // Logged, done, and a scoped scan of the new home queued.
    expect(db.prepare("SELECT status FROM jobs WHERE type = ? AND payload LIKE '%\"kind\":\"folder\"%' ORDER BY created_at DESC LIMIT 1").get(STORAGE_MOVE_JOB_TYPE)).toEqual({ status: "completed" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM activity_logs WHERE event = 'library.gallery.folder_moved'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'SCAN_GALLERY_LIBRARY' AND payload LIKE '%\"libraryId\":\"PHONE\"%' AND payload LIKE '%\"folder\":\"2026\"%'").get()).toEqual({ n: 1 });
    expect(folderMoveStatuses()[0]).toMatchObject({ running: false, status: "completed", libraryId: "RANDOM", targetLibraryId: "PHONE", folder: "2026" });
  });

  it("across volumes copies file by file and re-points only when everything is across", async () => {
    const exdev = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    const real = fs.renameSync;
    // Only the folder's rename is refused; thumbnails still rename inside their store.
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from).startsWith(src)) throw exdev;
      return real(from, to);
    });
    try {
      queueFolderMove("RANDOM", "2026", "PHONE", "u1");
      await waitForStorageMoves();
      expect(fs.readFileSync(path.join(dst, "2026", "2026-09-05", "clip-two.mp4"), "utf8")).toBe("JPEG-v2");
      expect(fs.existsSync(path.join(src, "2026"))).toBe(false);
      expect((db.prepare("SELECT library_id FROM library_items WHERE id = 'v1'").get() as { library_id: string }).library_id).toBe("PHONE");
    } finally {
      spy.mockRestore();
    }
  });
});
