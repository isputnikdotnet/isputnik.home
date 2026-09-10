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
import { folderMoveStatus, waitForFolderMove } from "../src/modules/library/shared/folder-move.js";
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

/** A library room's switch enqueues a scan of the new library; wait for it to
 *  finish, since moving a library under a running scan is (rightly) refused. */
async function settleScans() {
  for (let i = 0; i < 400; i++) {
    const n = (db.prepare("SELECT COUNT(*) AS n FROM libraries WHERE scan_status = 'scanning'").get() as { n: number }).n;
    if (n === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('a gallery scan never finished');
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

  it("switching thumbnails to App storage carries the whole store across in the background, merging what a scan wrote meanwhile", async () => {
    fs.mkdirSync(path.join(thumbs, "narration"), { recursive: true });
    fs.writeFileSync(path.join(thumbs, "narration", "clip.m4a"), "AAC");
    fs.mkdirSync(path.join(thumbs, "LIB", "ab"), { recursive: true });
    fs.writeFileSync(path.join(thumbs, "LIB", "ab", "old.webp"), "OLD");
    // Something a scan wrote into the new folder before the mover reached this bucket.
    fs.mkdirSync(path.join(appDir, "Thumbnails", "LIB", "ab"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "Thumbnails", "LIB", "ab", "new.webp"), "NEW");

    switchRoom("thumbnails", "app", null, "u1");
    expect(configuredThumbnailPathValue()).toBe(path.join(appDir, "Thumbnails"));
    const status = await waitForFolderMove();
    expect(status.failed).toEqual([]);
    expect(status.pending).toBe(0);
    expect(fs.existsSync(path.join(appDir, "Thumbnails", "narration", "clip.m4a"))).toBe(true);
    expect(fs.existsSync(path.join(appDir, "Thumbnails", "LIB", "ab", "old.webp"))).toBe(true);
    expect(fs.existsSync(path.join(appDir, "Thumbnails", "LIB", "ab", "new.webp"))).toBe(true);
    expect(fs.existsSync(path.join(thumbs, "narration"))).toBe(false);
    expect(fs.existsSync(path.join(thumbs, "LIB"))).toBe(false);

    // Back to its own folder: the own setting is rewritten, everything returns.
    fs.mkdirSync(thumbs, { recursive: true });
    switchRoom("thumbnails", "own", thumbs, "u1");
    expect(configuredThumbnailPathValue()).toBe(thumbs);
    await waitForFolderMove();
    expect(fs.existsSync(path.join(thumbs, "narration", "clip.m4a"))).toBe(true);
    expect(fs.existsSync(path.join(thumbs, "LIB", "ab", "new.webp"))).toBe(true);
  });

  it("refuses a second thumbnail change while the move runs", async () => {
    fs.mkdirSync(path.join(thumbs, "LIB"), { recursive: true });
    fs.writeFileSync(path.join(thumbs, "LIB", "a.webp"), "A");
    switchRoom("thumbnails", "app", null, "u1");
    if (folderMoveStatus().running) {
      expect(() => switchRoom("thumbnails", "own", thumbs, "u1")).toThrowError(/being moved/);
    }
    await waitForFolderMove();
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

  it("library rooms take one of the admin's own gallery libraries as 'own'", () => {
    makeLibrary("mine", { createdBy: "u1", type: "gallery" });
    makeLibrary("scans", { createdBy: "u1", type: "gallery" });
    expect(() => switchRoom("inbox", "own", null, "u1")).toThrowError(AppStorageError);
    expect(() => switchRoom("house", "own", "nope", "u1")).toThrowError(/doesn't exist/);

    expect(switchRoom("house", "own", "mine", "u1")).toMatchObject({ mode: "own", library: { id: "mine" } });
    expect(getHouseLibrary()?.id).toBe("mine");
    // The house library cannot double as the Inbox.
    expect(() => switchRoom("inbox", "own", "mine", "u1")).toThrowError(/Made in the app library/);
    expect(switchRoom("inbox", "own", "scans", "u1")).toMatchObject({ mode: "own", library: { id: "scans" } });
    const policy = db.prepare("SELECT policy_json FROM libraries WHERE id = 'scans'").get() as { policy_json: string };
    expect(parsePolicy(policy.policy_json).inbox).toBe(true);
    expect(appStorageView().libraries.map((library) => `${library.id}:${library.inbox}`).sort()).toEqual(["mine:false", "scans:true"]);
  });

});

describe("changing the folder while rooms use it", () => {
  let other = "";

  beforeEach(() => {
    setThumbs(thumbs);
    setAppStoragePath(appDir, "u1");
    other = path.join(base, "other");
    fs.mkdirSync(other);
  });

  const modeOf = (room: string) => appStorageView().rooms.find((view) => view.room === room)!;

  it("carries every room along: libraries move with their source path, render buckets and backups move now, the bin and thumbnails follow in the background", async () => {
    switchRoom("house", "app", null, "u1");
    switchRoom("inbox", "app", null, "u1");
    await settleScans();
    fs.writeFileSync(path.join(appDir, "Made in the app", "note.m4a"), "AAC");
    fs.writeFileSync(path.join(appDir, "Photo Inbox", "new.jpg"), "JPG");
    switchRoom("renders", "app", null, "u1");
    fs.mkdirSync(path.join(appDir, "Renders", "music", "ab"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "Renders", "music", "ab", "song.mp3"), "MP3");
    switchRoom("backups", "app", null, "u1");
    fs.writeFileSync(path.join(appDir, "Backups", "b1.zip"), "ZIP");
    switchRoom("thumbnails", "app", null, "u1");
    await waitForFolderMove();
    fs.mkdirSync(path.join(appDir, "Thumbnails", "LIB"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "Thumbnails", "LIB", "cover.webp"), "WEBP");
    switchRoom("trash", "app", null, "u1");
    trashBook(makeBook("bk1"), "u1");
    await waitForTrashMove();
    const houseId = getHouseLibrary()!.id;
    expect(appStorageView().lockedBy.sort()).toEqual(["backups", "house", "inbox", "renders", "thumbnails", "trash"]);

    const view = setAppStoragePath(other, "u1");
    expect(view.path).toBe(other);
    await waitForFolderMove();
    await waitForTrashMove();

    // The libraries: folder moved, source path follows, still nominated / still the Inbox.
    expect(getHouseLibrary()!.source_path).toBe(path.join(other, "Made in the app"));
    expect(fs.existsSync(path.join(other, "Made in the app", "note.m4a"))).toBe(true);
    expect(fs.existsSync(path.join(appDir, "Made in the app"))).toBe(false);
    expect(modeOf("house").mode).toBe("app");
    expect(modeOf("house").library!.id).toBe(houseId);
    expect(modeOf("inbox").mode).toBe("app");
    expect(fs.existsSync(path.join(other, "Photo Inbox", "new.jpg"))).toBe(true);
    // Renders, backups: moved now.
    expect(fs.existsSync(path.join(other, "Renders", "music", "ab", "song.mp3"))).toBe(true);
    expect(getRendersRoot()).toBe(path.join(other, "Renders"));
    expect(fs.existsSync(path.join(other, "Backups", "b1.zip"))).toBe(true);
    expect(backupDir()).toBe(path.join(other, "Backups"));
    expect(fs.existsSync(path.join(appDir, "Backups", "b1.zip"))).toBe(false);
    // Thumbnails and the bin: carried by their background moves.
    expect(configuredThumbnailPathValue()).toBe(path.join(other, "Thumbnails"));
    expect(fs.existsSync(path.join(other, "Thumbnails", "LIB", "cover.webp"))).toBe(true);
    expect(getTrashRootSetting()).toBe(path.join(other, "Recycle Bin"));
    expect(binRows().every((row) => row.trash_root === path.join(other, "Recycle Bin"))).toBe(true);
    expect(pendingTrashMoveRows()).toEqual([]);
    expect(modeOf("trash").mode).toBe("app");
  });

  it("a room told to stay leaves App storage: the bin and thumbnails keep their old folder as their own, a library stays as the room's own library, renders and backups go back to their default place", async () => {
    switchRoom("house", "app", null, "u1");
    await settleScans();
    switchRoom("renders", "app", null, "u1");
    fs.mkdirSync(path.join(appDir, "Renders", "music"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "Renders", "music", "song.mp3"), "MP3");
    switchRoom("backups", "app", null, "u1");
    fs.writeFileSync(path.join(appDir, "Backups", "b1.zip"), "ZIP");
    switchRoom("thumbnails", "app", null, "u1");
    await waitForFolderMove();
    switchRoom("trash", "app", null, "u1");
    trashBook(makeBook("bk1"), "u1");
    await waitForTrashMove();

    setAppStoragePath(other, "u1", { house: false, renders: false, backups: false, thumbnails: false, trash: false });
    expect(folderMoveStatus().running).toBe(false);
    expect(pendingTrashMoveRows()).toEqual([]);

    expect(getHouseLibrary()!.source_path).toBe(path.join(appDir, "Made in the app"));
    expect(modeOf("house").mode).toBe("own");
    expect(modeOf("thumbnails").mode).toBe("own");
    expect(configuredThumbnailPathValue()).toBe(path.join(appDir, "Thumbnails"));
    expect(modeOf("trash").mode).toBe("own");
    expect(getTrashRootSetting()).toBe(path.join(appDir, "Recycle Bin"));
    expect(binRows().every((row) => row.trash_root === path.join(appDir, "Recycle Bin"))).toBe(true);
    // Renders went back inside the (old, now own) thumbnail folder; backups to the backup folder.
    expect(modeOf("renders").mode).toBe("own");
    expect(fs.existsSync(path.join(appDir, "Thumbnails", "music", "song.mp3"))).toBe(true);
    expect(fs.existsSync(path.join(appDir, "Renders", "music"))).toBe(false);
    expect(modeOf("backups").mode).toBe("own");
    expect(fs.existsSync(path.join(backupDir(), "b1.zip"))).toBe(true);
    expect(backupDir()).not.toBe(path.join(appDir, "Backups"));
    fs.rmSync(path.join(backupDir(), "b1.zip"));
  });

  it("clearing the folder leaves every room where it is", async () => {
    switchRoom("house", "app", null, "u1");
    await settleScans();
    switchRoom("thumbnails", "app", null, "u1");
    const view = setAppStoragePath(null, "u1");
    expect(view.path).toBeNull();
    expect(getHouseLibrary()!.source_path).toBe(path.join(appDir, "Made in the app"));
    expect(configuredThumbnailPathValue()).toBe(path.join(appDir, "Thumbnails"));
    expect(getAppStorageSetting().rooms).toEqual({});
    // Choosing the old folder again is allowed: the libraries in it are its own rooms'.
    expect(setAppStoragePath(appDir, "u1").path).toBe(appDir);
  });

  it("refuses to carry a library onto a folder that exists there, and puts back what had already moved", async () => {
    switchRoom("house", "app", null, "u1");
    switchRoom("inbox", "app", null, "u1");
    await settleScans();
    await settleScans();
    fs.writeFileSync(path.join(appDir, "Made in the app", "note.m4a"), "AAC");
    fs.mkdirSync(path.join(other, "Photo Inbox"));
    expect(() => setAppStoragePath(other, "u1")).toThrowError(/already exists/);
    expect(getAppStorageSetting().path).toBe(appDir);
    expect(getHouseLibrary()!.source_path).toBe(path.join(appDir, "Made in the app"));
    expect(fs.existsSync(path.join(appDir, "Made in the app", "note.m4a"))).toBe(true);
    expect(fs.existsSync(path.join(other, "Made in the app"))).toBe(false);
  });

  it("refuses while a library room is being scanned", async () => {
    switchRoom("house", "app", null, "u1");
    await settleScans();
    db.prepare("UPDATE libraries SET scan_status = 'scanning' WHERE id = ?").run(getHouseLibrary()!.id);
    expect(() => setAppStoragePath(other, "u1")).toThrowError(/being scanned/);
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
