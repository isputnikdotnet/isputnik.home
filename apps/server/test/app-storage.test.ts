import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { parsePolicy } from "../src/core/permissions.js";
import { appRoomMode, getAppStorageSetting, resolveAppLocation, setAppRoomMode } from "../src/core/app-storage.js";
import {
  appStorageView,
  moveRenderBuckets,
  setAppStoragePath,
  switchRoom,
  validateAppStoragePath,
  AppStorageError
} from "../src/modules/library/app-storage.js";
import { getHouseLibrary } from "../src/modules/library/gallery/house-library.js";
import {
  configuredThumbnailPathValue,
  getRendersRoot,
  thumbnailAbsolutePath,
  thumbnailPathSettingKey
} from "../src/modules/library/shared/thumbnail.js";
import { getTrashRootSetting, trashBook } from "../src/modules/library/shared/trash.js";
import { pendingTrashMoveRows, startTrashMove, waitForTrashMove } from "../src/modules/library/shared/trash-move.js";
import { backupDir } from "../src/modules/backups/index.js";
import { resetDb, makeUser, makeLibrary } from "./helpers/seed.js";

// App storage (docs/app-storage-plan.md, phase 1): one folder with fixed rooms,
// every room optional, each switched from its own row, nothing moved without
// being asked — and the two moves that ARE made (the bin, the render buckets).

let base = "";
let appDir = "";
let thumbs = "";
let libSource = "";

function setThumbs(dir: string) {
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(thumbnailPathSettingKey, dir);
}

function makeBook(id: string): string {
  fs.mkdirSync(path.join(libSource, id), { recursive: true });
  fs.writeFileSync(path.join(libSource, id, "part1.mp3"), "AUDIO");
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, 'LIB', 'audiobook', ?, 'ready')").run(id, id);
  db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES (?, 'scan', ?)").run(id, `Title ${id}`);
  return id;
}

function binRows() {
  return db.prepare("SELECT id, trash_root, trash_path, source_path FROM trashed_items ORDER BY trashed_at")
    .all() as { id: string; trash_root: string | null; trash_path: string; source_path: string }[];
}

beforeEach(() => {
  resetDb();
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "app-storage-")));
  appDir = path.join(base, "iSputnik");
  thumbs = path.join(base, "thumbs");
  libSource = path.join(base, "library");
  for (const dir of [appDir, thumbs, libSource]) fs.mkdirSync(dir);
  makeUser("u1", "admin");
  db.prepare("INSERT OR REPLACE INTO storage_roots (id, name, path, created_by) VALUES ('sr1', 'test', ?, 'u1')").run(base);
  makeLibrary("LIB", { createdBy: "u1", type: "audiobook" });
  db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'LIB'").run(libSource);
});

describe("the setting and the resolver", () => {
  it("is unset by default, and nothing resolves into it", () => {
    expect(getAppStorageSetting()).toEqual({ path: null, rooms: {} });
    setThumbs(thumbs);
    expect(resolveAppLocation("thumbnails", thumbs)).toBe(thumbs);
    expect(resolveAppLocation("trash", null)).toBeNull();
    expect(resolveAppLocation("renders", null)).toBeNull();
    expect(resolveAppLocation("backups", "/b")).toBe("/b");
    const view = appStorageView();
    expect(view.path).toBeNull();
    expect(view.lockedBy).toEqual([]);
    expect(view.rooms.map((room) => `${room.room}:${room.mode}`)).toEqual([
      "trash:off", "inbox:off", "house:off", "thumbnails:own", "renders:own", "backups:own"
    ]);
  });

  it("validates the folder like a library source: inside a container, not the container, outside every library", () => {
    expect(() => validateAppStoragePath(path.join(base, "nope"))).toThrowError(/missing or not accessible/);
    expect(() => validateAppStoragePath(base)).toThrowError(/not the container itself/);
    expect(() => validateAppStoragePath(libSource)).toThrowError(/inside the library/);
    expect(() => validateAppStoragePath(fs.mkdtempSync(path.join(os.tmpdir(), "outside-")))).toThrowError(/container/);
    expect(validateAppStoragePath(appDir)).toBe(appDir);
  });

  it("choosing the folder records it and changes no room that has its own place", () => {
    setThumbs(thumbs);
    const view = setAppStoragePath(appDir, "u1");
    expect(view.path).toBe(appDir);
    expect(view.ready).toBe(true);
    const rooms = Object.fromEntries(view.rooms.map((room) => [room.room, room]));
    // Thumbnails keep their own folder; renders follow them; the bin stays per-library
    // because a library already exists (decision 9 flips the default on fresh installs only).
    expect(rooms.thumbnails.mode).toBe("own");
    expect(rooms.thumbnails.resolvedPath).toBe(thumbs);
    expect(rooms.renders.mode).toBe("own");
    expect(rooms.trash.mode).toBe("off");
    expect(rooms.trash.appPath).toBe(path.join(appDir, "Recycle Bin"));
    expect(view.lockedBy).toEqual([]);
  });

  it("thumbnails default to App storage when nothing of their own was ever set", () => {
    setAppStoragePath(appDir, "u1");
    expect(configuredThumbnailPathValue()).toBe(path.join(appDir, "Thumbnails"));
    expect(appStorageView().rooms.find((room) => room.room === "thumbnails")!.mode).toBe("app");
    // A key resolves under it, and the render buckets follow the thumbnails.
    expect(thumbnailAbsolutePath("LIB/ab/cd/x.webp")).toBe(path.join(appDir, "Thumbnails", "LIB", "ab", "cd", "x.webp"));
    expect(getRendersRoot()).toBe(path.join(appDir, "Thumbnails"));
  });

  it("a fresh install with no library gets the Recycle Bin room switched on", () => {
    db.prepare("DELETE FROM libraries").run();
    setAppStoragePath(appDir, "u1");
    expect(appRoomMode("trash")).toBe("app");
    expect(getTrashRootSetting()).toBe(path.join(appDir, "Recycle Bin"));
  });
});

describe("switching rooms", () => {
  beforeEach(() => {
    setThumbs(thumbs);
    setAppStoragePath(appDir, "u1");
  });

  it("moves the render buckets when the Renders room is switched on, and back when it is switched off", () => {
    const musicFile = path.join(thumbs, "music", "ab", "cd", "abcd.mp3");
    fs.mkdirSync(path.dirname(musicFile), { recursive: true });
    fs.writeFileSync(musicFile, "MP3");
    fs.mkdirSync(path.join(thumbs, "LIB"), { recursive: true });
    fs.writeFileSync(path.join(thumbs, "LIB", "cover.webp"), "WEBP");

    const room = switchRoom("renders", "app", null, "u1");
    expect(room.mode).toBe("app");
    const renders = path.join(appDir, "Renders");
    expect(fs.existsSync(path.join(renders, "music", "ab", "cd", "abcd.mp3"))).toBe(true);
    expect(fs.existsSync(musicFile)).toBe(false);
    // Thumbnails stayed; only the render buckets went.
    expect(fs.existsSync(path.join(thumbs, "LIB", "cover.webp"))).toBe(true);
    expect(thumbnailAbsolutePath("music/ab/cd/abcd.mp3")).toBe(path.join(renders, "music", "ab", "cd", "abcd.mp3"));
    expect(thumbnailAbsolutePath("LIB/cover.webp")).toBe(path.join(thumbs, "LIB", "cover.webp"));
    expect(appStorageView().lockedBy).toEqual(["renders"]);

    switchRoom("renders", "own", null, "u1");
    expect(fs.existsSync(musicFile)).toBe(true);
    expect(fs.existsSync(path.join(renders, "music"))).toBe(false);
    expect(appStorageView().lockedBy).toEqual([]);
  });

  it("refuses to move render buckets onto a folder that already has one", () => {
    fs.mkdirSync(path.join(thumbs, "music"), { recursive: true });
    fs.mkdirSync(path.join(appDir, "Renders", "music"), { recursive: true });
    expect(() => moveRenderBuckets(thumbs, path.join(appDir, "Renders"))).toThrowError(/already exists/);
  });

  it("switching thumbnails to App storage carries the render buckets with them", () => {
    fs.mkdirSync(path.join(thumbs, "narration"), { recursive: true });
    fs.writeFileSync(path.join(thumbs, "narration", "clip.m4a"), "AAC");
    switchRoom("thumbnails", "app", null, "u1");
    expect(configuredThumbnailPathValue()).toBe(path.join(appDir, "Thumbnails"));
    expect(fs.existsSync(path.join(appDir, "Thumbnails", "narration", "clip.m4a"))).toBe(true);
    expect(fs.existsSync(path.join(thumbs, "narration"))).toBe(false);
    // Back to its own folder: the own setting is rewritten, the buckets return.
    switchRoom("thumbnails", "own", thumbs, "u1");
    expect(configuredThumbnailPathValue()).toBe(thumbs);
    expect(fs.existsSync(path.join(thumbs, "narration", "clip.m4a"))).toBe(true);
  });

  it("backups switch without moving anything", () => {
    const before = backupDir();
    switchRoom("backups", "app", null, "u1");
    expect(backupDir()).toBe(path.join(appDir, "Backups"));
    expect(fs.existsSync(path.join(appDir, "Backups"))).toBe(true);
    switchRoom("backups", "own", null, "u1");
    expect(backupDir()).toBe(before);
  });

  it("makes the Photo Inbox library on request, and turns it back into an ordinary library only when empty", () => {
    const room = switchRoom("inbox", "app", null, "u1");
    expect(room.mode).toBe("app");
    expect(room.library?.name).toBe("Photo Inbox");
    const lib = db.prepare("SELECT id, source_path, policy_json FROM libraries WHERE type = 'gallery'").get() as { id: string; source_path: string; policy_json: string };
    expect(lib.source_path).toBe(path.join(appDir, "Photo Inbox"));
    expect(parsePolicy(lib.policy_json).inbox).toBe(true);
    expect(appStorageView().lockedBy).toEqual(["inbox"]);

    db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES ('p1', ?, 'gallery', 'scan/a.jpg', 'ready')").run(lib.id);
    expect(() => switchRoom("inbox", "off", null, "u1")).toThrowError(/still waiting/);
    db.prepare("DELETE FROM library_items WHERE id = 'p1'").run();
    expect(switchRoom("inbox", "off", null, "u1").mode).toBe("off");
    const after = db.prepare("SELECT policy_json FROM libraries WHERE id = ?").get(lib.id) as { policy_json: string };
    expect(parsePolicy(after.policy_json).inbox).not.toBe(true);
    // Switching on again reuses the library rather than making a second one.
    switchRoom("inbox", "app", null, "u1");
    expect((db.prepare("SELECT COUNT(*) AS n FROM libraries WHERE type = 'gallery'").get() as { n: number }).n).toBe(1);
  });

  it("makes and nominates the Made in the app library, and off only clears the nomination", () => {
    const room = switchRoom("house", "app", null, "u1");
    expect(room.mode).toBe("app");
    expect(getHouseLibrary()?.source_path).toBe(path.join(appDir, "Made in the app"));
    switchRoom("house", "off", null, "u1");
    expect(getHouseLibrary()).toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM libraries WHERE name = 'Made in the app'").get() as { n: number }).n).toBe(1);
    switchRoom("house", "app", null, "u1");
    expect(getHouseLibrary()).not.toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM libraries WHERE name = 'Made in the app'").get() as { n: number }).n).toBe(1);
  });

  it("library rooms send 'own' to Settings → Gallery rather than doing it here", () => {
    expect(() => switchRoom("inbox", "own", null, "u1")).toThrowError(AppStorageError);
    expect(() => switchRoom("house", "own", null, "u1")).toThrowError(/Settings/);
  });

  it("locks the folder while a room keeps files in it, and frees it again", () => {
    switchRoom("house", "app", null, "u1");
    expect(() => setAppStoragePath(null, "u1")).toThrowError(/in use by Made in the app/);
    fs.mkdirSync(path.join(base, "other"));
    expect(() => setAppStoragePath(path.join(base, "other"), "u1")).toThrowError(/in use/);
    switchRoom("house", "off", null, "u1");
    // The library is still there, at the room's path, which choosing again allows.
    expect(setAppStoragePath(null, "u1").path).toBeNull();
    expect(setAppStoragePath(appDir, "u1").path).toBe(appDir);
  });
});

describe("the bin move", () => {
  beforeEach(() => {
    setThumbs(thumbs);
    setAppStoragePath(appDir, "u1");
  });

  it("carries every item to the new location, row by row, and back again", async () => {
    trashBook(makeBook("bk1"), "u1");
    trashBook(makeBook("bk2"), "u1");
    const before = binRows();
    expect(before.every((row) => row.trash_root === null && row.trash_path.startsWith(".trash/"))).toBe(true);
    expect(fs.existsSync(path.join(libSource, ".trash"))).toBe(true);

    switchRoom("trash", "app", null, "u1");
    const bin = path.join(appDir, "Recycle Bin");
    expect(getTrashRootSetting()).toBe(bin);
    const status = await waitForTrashMove();
    expect(status.failed).toEqual([]);
    expect(status.pending).toBe(0);
    expect(status.moved).toBe(2);
    for (const row of binRows()) {
      expect(row.trash_root).toBe(bin);
      expect(row.trash_path.startsWith("LIB/")).toBe(true);
      expect(fs.existsSync(path.join(bin, row.trash_path, row.trash_path.endsWith("bk1") ? "" : ""))).toBe(true);
    }
    expect(fs.existsSync(path.join(bin, "LIB", path.posix.basename(binRows()[0].trash_path), "bk1", "part1.mp3"))).toBe(true);
    // The emptied per-library .trash is pruned.
    expect(fs.existsSync(path.join(libSource, ".trash"))).toBe(false);
    expect(appStorageView().lockedBy).toEqual(["trash"]);

    // Off: back to each library's own .trash, and the files follow.
    switchRoom("trash", "off", null, "u1");
    await waitForTrashMove();
    expect(binRows().every((row) => row.trash_root === null && row.trash_path.startsWith(".trash/"))).toBe(true);
    expect(fs.existsSync(path.join(libSource, ".trash"))).toBe(true);
    expect(fs.existsSync(path.join(bin, "LIB"))).toBe(false);
    expect(appStorageView().lockedBy).toEqual([]);
  });

  it("lists a row whose files are missing as failed and leaves it where it was", async () => {
    trashBook(makeBook("bk1"), "u1");
    const row = binRows()[0];
    fs.rmSync(path.join(libSource, row.trash_path), { recursive: true, force: true });
    switchRoom("trash", "app", null, "u1");
    const status = await waitForTrashMove();
    expect(status.failed).toHaveLength(1);
    expect(status.failed[0].id).toBe(row.id);
    expect(binRows()[0].trash_root).toBeNull();
    expect(pendingTrashMoveRows()).toHaveLength(1);
  });

  it("restore keeps working during a move, from the row's own location", async () => {
    trashBook(makeBook("bk1"), "u1");
    setAppRoomMode("trash", "app", "u1");
    // Nothing moved yet; the setting says App storage, the row says the library's .trash.
    expect(pendingTrashMoveRows()).toHaveLength(1);
    const { restoreTrashedItem } = await import("../src/modules/library/shared/trash.js");
    await restoreTrashedItem(binRows()[0].id);
    expect(fs.existsSync(path.join(libSource, "bk1", "part1.mp3"))).toBe(true);
    expect(startTrashMove().pending).toBe(0);
  });
});
