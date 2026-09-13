import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db.js";
import { appRoomMode, appRoomPath, getAppStorageSetting, resolveAppLocation } from "../src/core/app-storage.js";
import { appStorageView } from "../src/modules/library/app-storage-rooms.js";
import {
  migrateRendersIntoAppStorage,
  renameRoomFolder,
  switchRoom
} from "../src/modules/library/app-storage-switch.js";
import { setAppStoragePath } from "../src/modules/library/app-storage-path.js";
import { validateAppStoragePath, AppStorageError } from "../src/modules/library/app-storage.js";
import { copyTreeVerified, pendingTrashMoveRows, storageMoveStatus, waitForStorageMoves, STORAGE_MOVE_JOB_TYPE } from "../src/modules/library/shared/storage-move.js";
import { getHouseLibrary, setHouseLibrary } from "../src/modules/library/gallery/house-library.js";
import {
  resolveGalleryBrowseLibraryIds,
  resolveGalleryScopeLibraryIds
} from "../src/modules/library/gallery/catalog-scope.js";
import {
  configuredThumbnailPathValue,
  getRendersRoot,
  thumbnailAbsolutePath,
  thumbnailPathSettingKey
} from "../src/modules/library/shared/thumbnail.js";
import { getTrashRootSetting } from "../src/modules/library/shared/trash-settings.js";
import { trashBook } from "../src/modules/library/shared/trash.js";
import { changeTrashRoot, startTrashMove, waitForTrashMove } from "../src/modules/library/shared/trash-move.js";
import { setTrashRootSetting } from "../src/modules/library/shared/trash-settings.js";
import { mapDataDir } from "../src/modules/maps/storage.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import "./helpers/media-types.js";

// App storage (docs/app-storage-plan.md, phase 1): one folder with fixed rooms,
// every room optional, each switched from its own row, nothing moved without
// being asked. Since 4.6 the rooms are the Photo Inbox, App files, Renders and Map
// data; the bin, thumbnails and backups are tested in system-data.test.ts, and the
// bin's move (below) is driven by its own location setting.

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
    expect(resolveAppLocation("renders")).toBeNull();
    expect(resolveAppLocation("maps")).toBeNull();
    const view = appStorageView();
    expect(view.path).toBeNull();
    expect(view.lockedBy).toEqual([]);
    expect(view.rooms.map((room) => `${room.room}:${room.mode}`)).toEqual([
      "inbox:off", "house:off", "renders:own", "maps:own"
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
    // Renders, never given a place, take App storage the moment there is one
    // (3.88.0); thumbnails are not a room and stay where they are.
    expect(configuredThumbnailPathValue()).toBe(thumbs);
    expect(rooms.renders.mode).toBe("app");
    expect(rooms.renders.resolvedPath).toBe(path.join(appDir, "Renders"));
    // Map data follows the same rule, and nothing has been kept yet to lock it.
    expect(rooms.maps.mode).toBe("app");
    expect(rooms.maps.resolvedPath).toBe(path.join(appDir, "Map data"));
    expect(mapDataDir()).toBe(path.join(appDir, "Map data"));
    expect(view.lockedBy).toEqual([]);
  });

  it("never takes the thumbnails: they stay in their folder while the render buckets take their room", () => {
    setThumbs(thumbs);
    setAppStoragePath(appDir, "u1");
    expect(thumbnailAbsolutePath("LIB/ab/cd/x.webp")).toBe(path.join(thumbs, "LIB", "ab", "cd", "x.webp"));
    expect(getRendersRoot()).toBe(path.join(appDir, "Renders"));
  });

  it("the App files room keeps its former folder name on an install that made it as 'Made in the app'", () => {
    setAppStoragePath(appDir, "u1");
    expect(appRoomPath("house")).toBe(path.join(appDir, "App files"));
    // An install from before the rename has the old folder: the room is that
    // folder, its library is still read as using App storage, nothing moves.
    fs.mkdirSync(path.join(appDir, "Made in the app"));
    expect(appRoomPath("house")).toBe(path.join(appDir, "Made in the app"));
    makeLibrary("OLDHOUSE", { createdBy: "u1", type: "gallery" });
    db.prepare("UPDATE libraries SET name = 'Made in the app', source_path = ? WHERE id = 'OLDHOUSE'").run(path.join(appDir, "Made in the app"));
    expect(setHouseLibrary("OLDHOUSE", "u1").ok).toBe(true);
    expect(appStorageView().rooms.find((room) => room.room === "house")!.mode).toBe("app");
    // Once the new-name folder exists as well, the current name wins.
    fs.mkdirSync(path.join(appDir, "App files"));
    expect(appRoomPath("house")).toBe(path.join(appDir, "App files"));
  });

  it("offers to rename the former folder to App files, and does it as a library move the library follows", async () => {
    setAppStoragePath(appDir, "u1");
    const former = path.join(appDir, "Made in the app");
    fs.mkdirSync(path.join(former, "Voice notes"), { recursive: true });
    fs.writeFileSync(path.join(former, "Voice notes", "note.weba"), "AUDIO");
    makeLibrary("OLDHOUSE", { createdBy: "u1", type: "gallery" });
    db.prepare("UPDATE libraries SET name = 'Made in the app', source_path = ? WHERE id = 'OLDHOUSE'").run(former);
    expect(setHouseLibrary("OLDHOUSE", "u1").ok).toBe(true);

    const before = appStorageView().rooms.find((room) => room.room === "house")!;
    expect(before.mode).toBe("app");
    expect(before.renameTo).toBe(path.join(appDir, "App files"));
    // Only the App files row has a former name; the others never offer it.
    expect(appStorageView().rooms.filter((room) => room.renameTo !== null).map((room) => room.room)).toEqual(["house"]);

    const queued = renameRoomFolder("house", "u1");
    expect(queued.move.running).toBe(true);
    await waitForStorageMoves();

    // The files went, the library followed its folder, and the library named
    // after the old folder took the new name with it.
    expect(fs.existsSync(path.join(appDir, "App files", "Voice notes", "note.weba"))).toBe(true);
    expect(fs.existsSync(former)).toBe(false);
    const library = db.prepare("SELECT name, source_path FROM libraries WHERE id = 'OLDHOUSE'").get() as { name: string; source_path: string };
    expect(library).toEqual({ name: "App files", source_path: path.join(appDir, "App files") });
    const after = appStorageView().rooms.find((room) => room.room === "house")!;
    expect(after.mode).toBe("app");
    expect(after.resolvedPath).toBe(path.join(appDir, "App files"));
    expect(after.renameTo).toBeNull();
    expect(storageMoveStatus("house").failed).toEqual([]);

    // Nothing left to rename: refused, not repeated.
    expect(() => renameRoomFolder("house", "u1")).toThrowError(/already has its current name/);
  });

  it("the rename keeps a library's own name, and is refused for a room without a former name", () => {
    setAppStoragePath(appDir, "u1");
    fs.mkdirSync(path.join(appDir, "Made in the app"));
    makeLibrary("RANDOM", { createdBy: "u1", type: "gallery" });
    db.prepare("UPDATE libraries SET name = 'Random', source_path = ? WHERE id = 'RANDOM'").run(path.join(appDir, "Made in the app"));
    expect(setHouseLibrary("RANDOM", "u1").ok).toBe(true);
    renameRoomFolder("house", "u1");
    expect((db.prepare("SELECT name FROM libraries WHERE id = 'RANDOM'").get() as { name: string }).name).toBe("Random");
    expect(() => renameRoomFolder("renders", "u1")).toThrowError(AppStorageError);
  });

  it("on the first start after the update, an untouched Renders row carries its buckets from the thumbnail folder into App storage", async () => {
    setThumbs(thumbs);
    fs.mkdirSync(path.join(thumbs, "music", "ab"), { recursive: true });
    fs.writeFileSync(path.join(thumbs, "music", "ab", "song.mp3"), "MP3");
    fs.mkdirSync(path.join(thumbs, "LIB"), { recursive: true });
    fs.writeFileSync(path.join(thumbs, "LIB", "cover.webp"), "WEBP");
    // Without App storage there is nothing to move to.
    expect(migrateRendersIntoAppStorage()).toBeNull();
    setAppStoragePath(appDir, "u1");
    const status = migrateRendersIntoAppStorage();
    expect(status?.running).toBe(true);
    await waitForStorageMoves();
    expect(fs.existsSync(path.join(appDir, "Renders", "music", "ab", "song.mp3"))).toBe(true);
    expect(fs.existsSync(path.join(thumbs, "music"))).toBe(false);
    expect(fs.existsSync(path.join(thumbs, "LIB", "cover.webp"))).toBe(true);
    expect(getRendersRoot()).toBe(path.join(appDir, "Renders"));
    // Done once: nothing left to carry, and a row switched to "own" is left alone.
    expect(migrateRendersIntoAppStorage()).toBeNull();
    switchRoom("renders", "own", null, "u1");
    await waitForStorageMoves();
    expect(appRoomMode("renders")).toBe("own");
    expect(getRendersRoot()).toBe(thumbs);
    fs.writeFileSync(path.join(thumbs, "music", "ab", "song.mp3"), "MP3");
    expect(migrateRendersIntoAppStorage()).toBeNull();
  });
});

describe("switching rooms", () => {
  beforeEach(() => {
    setThumbs(thumbs);
    setAppStoragePath(appDir, "u1");
  });

  it("moves the render buckets as a task when the Renders room is switched on, and back when it is switched off", async () => {
    // Renders default to App storage once it exists; start from the thumbnail
    // folder, where an older install's buckets sit.
    switchRoom("renders", "own", null, "u1");
    await waitForStorageMoves();
    const musicFile = path.join(thumbs, "music", "ab", "cd", "abcd.mp3");
    fs.mkdirSync(path.dirname(musicFile), { recursive: true });
    fs.writeFileSync(musicFile, "MP3");
    fs.mkdirSync(path.join(thumbs, "LIB"), { recursive: true });
    fs.writeFileSync(path.join(thumbs, "LIB", "cover.webp"), "WEBP");

    const room = switchRoom("renders", "app", null, "u1");
    expect(room.mode).toBe("app");
    expect(room.move.running).toBe(true);
    await waitForStorageMoves();
    const renders = path.join(appDir, "Renders");
    expect(fs.existsSync(path.join(renders, "music", "ab", "cd", "abcd.mp3"))).toBe(true);
    expect(fs.existsSync(musicFile)).toBe(false);
    // Thumbnails stayed; only the render buckets went.
    expect(fs.existsSync(path.join(thumbs, "LIB", "cover.webp"))).toBe(true);
    expect(thumbnailAbsolutePath("music/ab/cd/abcd.mp3")).toBe(path.join(renders, "music", "ab", "cd", "abcd.mp3"));
    expect(thumbnailAbsolutePath("LIB/cover.webp")).toBe(path.join(thumbs, "LIB", "cover.webp"));
    expect(appStorageView().lockedBy).toEqual(["renders"]);

    switchRoom("renders", "own", null, "u1");
    await waitForStorageMoves();
    expect(fs.existsSync(musicFile)).toBe(true);
    expect(fs.existsSync(path.join(renders, "music"))).toBe(false);
    expect(appStorageView().lockedBy).toEqual([]);
    // Every move is a task on the Tasks page, timed and logged.
    // The jobs table outlives resetDb, so look at this test's two moves: the newest.
    const jobs = db.prepare("SELECT status FROM jobs WHERE type = ? AND payload LIKE '%\"room\":\"renders\"%' ORDER BY created_at").all(STORAGE_MOVE_JOB_TYPE) as { status: string }[];
    expect(jobs.length).toBeGreaterThanOrEqual(2);
    expect(jobs.slice(-2).map((job) => job.status)).toEqual(["completed", "completed"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM activity_logs WHERE event = 'storage.move.completed' AND target_id = 'renders'").get()).toEqual({ n: 2 });
  });

  describe("the Map data room", () => {
    let own = "";
    beforeEach(() => {
      own = path.join(base, "map-data");
      process.env.MAP_DATA_PATH = own;
    });
    afterEach(() => {
      delete process.env.MAP_DATA_PATH;
    });

    /** A cached tile, as the maps module lays one down. */
    const tileIn = (root: string) => {
      const file = path.join(root, "Tiles", "vector", "14", "9401", "5288.pbf.gz");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "TILE");
      return file;
    };

    it("moves the kept maps as a task when switched to its own folder, and back into App storage", async () => {
      const appMaps = path.join(appDir, "Map data");
      const inApp = tileIn(appMaps);
      // Something that is not map data, sitting in the room's folder: never carried.
      fs.writeFileSync(path.join(appMaps, "notes.txt"), "MINE");
      expect(appStorageView().lockedBy).toEqual(["maps"]);

      const room = switchRoom("maps", "own", null, "u1");
      expect(room.mode).toBe("own");
      expect(room.move.running).toBe(true);
      // The setting flips at once — new tiles land in the new place during the move.
      expect(mapDataDir()).toBe(own);
      await waitForStorageMoves();
      expect(fs.readFileSync(path.join(own, "Tiles", "vector", "14", "9401", "5288.pbf.gz"), "utf8")).toBe("TILE");
      expect(fs.existsSync(inApp)).toBe(false);
      expect(fs.readFileSync(path.join(appMaps, "notes.txt"), "utf8")).toBe("MINE");
      expect(appStorageView().lockedBy).toEqual([]);

      switchRoom("maps", "app", null, "u1");
      await waitForStorageMoves();
      expect(mapDataDir()).toBe(appMaps);
      expect(fs.existsSync(inApp)).toBe(true);
      expect(fs.existsSync(path.join(own, "Tiles"))).toBe(false);
      // Its own folder held nothing else, so it goes once emptied.
      expect(fs.existsSync(own)).toBe(false);
      expect(db.prepare("SELECT COUNT(*) AS n FROM activity_logs WHERE event = 'storage.move.completed' AND target_id = 'maps'").get()).toEqual({ n: 2 });
    });

    it("merges into tiles fetched at the new place while the move was waiting", async () => {
      tileIn(path.join(appDir, "Map data"));
      switchRoom("maps", "own", null, "u1");
      // A tile the live cache wrote at the new place before the move reached it.
      const fresh = path.join(own, "Tiles", "vector", "3", "1", "1.pbf.gz");
      fs.mkdirSync(path.dirname(fresh), { recursive: true });
      fs.writeFileSync(fresh, "NEW");
      await waitForStorageMoves();
      expect(fs.readFileSync(fresh, "utf8")).toBe("NEW");
      expect(fs.existsSync(path.join(own, "Tiles", "vector", "14", "9401", "5288.pbf.gz"))).toBe(true);
    });

    it("has no off: whether maps are kept at all is not a storage question", () => {
      expect(() => switchRoom("maps", "off", null, "u1")).toThrow(AppStorageError);
    });

    it("refuses a second change while a move runs", () => {
      tileIn(path.join(appDir, "Map data"));
      switchRoom("maps", "own", null, "u1");
      expect(() => switchRoom("maps", "app", null, "u1")).toThrow(/being moved right now/);
    });
  });

  it("a moved file that arrives short is refused, kept at the source, and listed as failed", () => {
    const source = path.join(base, "src-tree");
    const target = path.join(base, "dst-tree");
    fs.mkdirSync(path.join(source, "a"), { recursive: true });
    fs.writeFileSync(path.join(source, "a", "one.bin"), "ONE");
    fs.writeFileSync(path.join(source, "two.bin"), "TWO");
    expect(copyTreeVerified(source, target)).toBe(2);
    expect(fs.readFileSync(path.join(target, "a", "one.bin"), "utf8")).toBe("ONE");
    // A copy that lands short is not accepted: the size check catches it.
    const spy = vi.spyOn(fs, "copyFileSync").mockImplementation((from, to) => { fs.writeFileSync(to, "X"); });
    try {
      fs.writeFileSync(path.join(source, "three.bin"), "THREE");
      expect(() => copyTreeVerified(path.join(source, "three.bin"), path.join(target, "three.bin"))).toThrowError(/arrived as 1 bytes, not 5/);
      expect(fs.existsSync(path.join(target, "three.bin"))).toBe(false);
      expect(fs.existsSync(path.join(source, "three.bin"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("makes the Photo Inbox library on request, and turns it back into an ordinary library only when empty", () => {
    const room = switchRoom("inbox", "app", null, "u1");
    expect(room.mode).toBe("app");
    expect(room.library?.name).toBe("Photo Inbox");
    const lib = db.prepare("SELECT id, source_path, role FROM libraries WHERE type = 'gallery'").get() as { id: string; source_path: string; role: string | null };
    expect(lib.source_path).toBe(path.join(appDir, "Photo Inbox"));
    expect(lib.role).toBe("inbox");
    expect(appStorageView().lockedBy).toEqual(["inbox"]);

    db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES ('p1', ?, 'gallery', 'scan/a.jpg', 'ready')").run(lib.id);
    expect(() => switchRoom("inbox", "off", null, "u1")).toThrowError(/still waiting/);
    db.prepare("DELETE FROM library_items WHERE id = 'p1'").run();
    expect(switchRoom("inbox", "off", null, "u1").mode).toBe("off");
    const after = db.prepare("SELECT role FROM libraries WHERE id = ?").get(lib.id) as { role: string | null };
    expect(after.role).toBeNull();
    // Switching on again reuses the library rather than making a second one.
    switchRoom("inbox", "app", null, "u1");
    expect((db.prepare("SELECT COUNT(*) AS n FROM libraries WHERE type = 'gallery'").get() as { n: number }).n).toBe(1);
  });

  it("moves an Inbox of the admin's own into App storage, photos and all, instead of making a second one", async () => {
    // A gallery library of the admin's own, flagged as the Inbox, with photos waiting.
    const ownDir = path.join(base, "Scans");
    fs.mkdirSync(path.join(ownDir, "2026"), { recursive: true });
    fs.writeFileSync(path.join(ownDir, "2026", "a.jpg"), "JPG");
    makeLibrary("SCANS", { createdBy: "u1", type: "gallery", name: "Scans" });
    db.prepare("UPDATE libraries SET name = 'Scans', source_path = ?, role = 'inbox' WHERE id = 'SCANS'").run(ownDir);
    db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES ('p1', 'SCANS', 'gallery', '2026/a.jpg', 'ready')").run();
    expect(appStorageView().rooms.find((room) => room.room === "inbox")!.mode).toBe("own");

    const queued = switchRoom("inbox", "app", null, "u1");
    // Queued as a task: the row still reads the library at its old place until the
    // files are across and verified, then it flips.
    expect(queued.mode).toBe("own");
    expect(queued.move.running).toBe(true);
    await waitForStorageMoves();
    const room = appStorageView().rooms.find((view) => view.room === "inbox")!;
    expect(room.mode).toBe("app");
    expect(room.move.running).toBe(false);
    expect(room.move.failed).toEqual([]);
    expect(room.library).toEqual({ id: "SCANS", name: "Scans" });
    expect(room.counts.waiting).toBe(1);
    const appInbox = path.join(appDir, "Photo Inbox");
    expect((db.prepare("SELECT source_path FROM libraries WHERE id = 'SCANS'").get() as { source_path: string }).source_path).toBe(appInbox);
    expect(fs.existsSync(path.join(appInbox, "2026", "a.jpg"))).toBe(true);
    expect(fs.existsSync(ownDir)).toBe(false);
    // Still the one and only Inbox: no library was created.
    expect(db.prepare("SELECT COUNT(*) AS n FROM libraries WHERE type = 'gallery'").get()).toEqual({ n: 1 });
    // Logged as a task: started, then completed with what it carried.
    const events = db.prepare("SELECT event, detail FROM activity_logs WHERE event LIKE 'storage.move.%' AND target_id = 'inbox' ORDER BY created_at").all() as { event: string; detail: string }[];
    expect(events.map((e) => e.event)).toEqual(["storage.move.started", "storage.move.completed"]);
    expect(events[1].detail).toMatch(/Moved Scans from .* to .*: 1 carried and verified/);
    expect(db.prepare("SELECT status FROM jobs WHERE type = ? AND payload LIKE '%\"room\":\"inbox\"%' ORDER BY created_at DESC LIMIT 1").get(STORAGE_MOVE_JOB_TYPE)).toEqual({ status: "completed" });
  });

  it("across volumes a library is copied file by file, verified, and flips its path only at the end; a cancel leaves it where it was", async () => {
    const ownDir = path.join(base, "Family");
    fs.mkdirSync(path.join(ownDir, "2025"), { recursive: true });
    fs.writeFileSync(path.join(ownDir, "2025", "a.jpg"), "AAAA");
    fs.writeFileSync(path.join(ownDir, "note.m4a"), "NOTE");
    makeLibrary("FAM", { createdBy: "u1", type: "gallery" });
    db.prepare("UPDATE libraries SET name = 'Family', source_path = ? WHERE id = 'FAM'").run(ownDir);
    expect(setHouseLibrary("FAM", "u1").ok).toBe(true);
    expect(getHouseLibrary()?.id).toBe("FAM");

    // Pretend the volumes differ: every rename fails with EXDEV, so the task copies.
    const exdev = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw exdev; });
    try {
      // First, a cancel before the worker runs: the library stays put, the target is gone.
      switchRoom("house", "app", null, "u1");
      expect(storageMoveStatus("house").running).toBe(true);
      db.prepare("UPDATE jobs SET status = 'failed', error = 'Cancelled by user' WHERE type = ? AND status = 'pending'").run(STORAGE_MOVE_JOB_TYPE);
      await waitForStorageMoves();
      expect(getHouseLibrary()!.source_path).toBe(ownDir);
      expect(fs.existsSync(path.join(ownDir, "2025", "a.jpg"))).toBe(true);

      // Then the move itself.
      const queued = switchRoom("house", "app", null, "u1");
      expect(queued.mode).toBe("own");
      expect(queued.move.running).toBe(true);
      await waitForStorageMoves();
      const appHouse = path.join(appDir, "App files");
      expect(getHouseLibrary()!.source_path).toBe(appHouse);
      expect(fs.readFileSync(path.join(appHouse, "2025", "a.jpg"), "utf8")).toBe("AAAA");
      expect(fs.readFileSync(path.join(appHouse, "note.m4a"), "utf8")).toBe("NOTE");
      expect(fs.existsSync(ownDir)).toBe(false);
      const room = appStorageView().rooms.find((view) => view.room === "house")!;
      expect(room.mode).toBe("app");
      expect(room.library).toEqual({ id: "FAM", name: "Family" });
      expect(room.move.failed).toEqual([]);
      // The jobs table outlives resetDb, so look at this room's newest job only.
      const done = db.prepare("SELECT status, payload FROM jobs WHERE type = ? AND payload LIKE '%\"room\":\"house\"%' ORDER BY created_at DESC LIMIT 1").get(STORAGE_MOVE_JOB_TYPE) as { status: string; payload: string };
      expect(done.status).toBe("completed");
      expect(JSON.parse(done.payload).result.moved).toBe(2);
    } finally {
      rename.mockRestore();
    }
  });

  it("App files is left out of BROWSING wherever it lives, but stays reachable for what names its photos by id", async () => {
    const admin = { id: "u1", role: "admin" };
    // An ordinary gallery library of the admin's own, outside App storage.
    const ownDir = path.join(base, "Family");
    fs.mkdirSync(ownDir);
    makeLibrary("FAM", { createdBy: "u1", type: "gallery" });
    db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'FAM'").run(ownDir);
    grant("group", EVERYONE_GROUP_ID, "FAM", "member");
    expect(resolveGalleryBrowseLibraryIds(admin)).toEqual(["FAM"]);
    // Nominated, it is a system library: out of BROWSING before it ever moves
    // (4.6 — it used to take the move into App storage), still there when named,
    // and REACHABLE, so a story block, an album or the viewer that names one of
    // its photos by id keeps showing it.
    expect(setHouseLibrary("FAM", "u1").ok).toBe(true);
    expect(resolveGalleryBrowseLibraryIds(admin)).toEqual([]);
    expect(resolveGalleryBrowseLibraryIds(admin, ["FAM"])).toEqual(["FAM"]);
    expect(resolveGalleryScopeLibraryIds(admin)).toEqual(["FAM"]);
    // An Inbox made in its room is out of both scopes unless named.
    switchRoom("inbox", "app", null, "u1");
    await settleScans();
    const inbox = appStorageView().rooms.find((room) => room.room === "inbox")!.library!.id;
    expect(resolveGalleryScopeLibraryIds(admin)).toEqual(["FAM"]);
    expect(resolveGalleryScopeLibraryIds(admin, [inbox])).toEqual([inbox]);
    // Moving App files into App storage changes neither answer.
    switchRoom("house", "app", null, "u1");
    await waitForStorageMoves();
    expect(getHouseLibrary()!.source_path).toBe(path.join(appDir, "App files"));
    expect(resolveGalleryBrowseLibraryIds(admin)).toEqual([]);
    expect(resolveGalleryScopeLibraryIds(admin)).toEqual(["FAM"]);
  });

  it("makes and nominates the App files library, and off only clears the nomination", () => {
    const room = switchRoom("house", "app", null, "u1");
    expect(room.mode).toBe("app");
    expect(getHouseLibrary()?.source_path).toBe(path.join(appDir, "App files"));
    switchRoom("house", "off", null, "u1");
    expect(getHouseLibrary()).toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM libraries WHERE name = 'App files'").get() as { n: number }).n).toBe(1);
    switchRoom("house", "app", null, "u1");
    expect(getHouseLibrary()).not.toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM libraries WHERE name = 'App files'").get() as { n: number }).n).toBe(1);
  });

  it("library rooms take one of the admin's own gallery libraries as 'own'", () => {
    makeLibrary("mine", { createdBy: "u1", type: "gallery" });
    makeLibrary("scans", { createdBy: "u1", type: "gallery" });
    expect(() => switchRoom("inbox", "own", null, "u1")).toThrowError(AppStorageError);
    expect(() => switchRoom("house", "own", "nope", "u1")).toThrowError(/doesn't exist/);

    expect(switchRoom("house", "own", "mine", "u1")).toMatchObject({ mode: "own", library: { id: "mine" } });
    expect(getHouseLibrary()?.id).toBe("mine");
    // The house library cannot double as the Inbox.
    expect(() => switchRoom("inbox", "own", "mine", "u1")).toThrowError(/App files library/);
    expect(switchRoom("inbox", "own", "scans", "u1")).toMatchObject({ mode: "own", library: { id: "scans" } });
    const policy = db.prepare("SELECT role FROM libraries WHERE id = 'scans'").get() as { role: string | null };
    expect(policy.role).toBe("inbox");
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

  it("carries every room along: libraries move with their source path, render buckets and map data follow as tasks", async () => {
    switchRoom("house", "app", null, "u1");
    switchRoom("inbox", "app", null, "u1");
    await settleScans();
    fs.writeFileSync(path.join(appDir, "App files", "note.m4a"), "AAC");
    fs.writeFileSync(path.join(appDir, "Photo Inbox", "new.jpg"), "JPG");
    switchRoom("renders", "app", null, "u1");
    fs.mkdirSync(path.join(appDir, "Renders", "music", "ab"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "Renders", "music", "ab", "song.mp3"), "MP3");
    fs.mkdirSync(path.join(appDir, "Map data", "Tiles", "vector"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "Map data", "Tiles", "vector", "t.pbf.gz"), "TILE");
    const houseId = getHouseLibrary()!.id;
    expect(appStorageView().lockedBy.sort()).toEqual(["house", "inbox", "maps", "renders"]);

    const view = setAppStoragePath(other, "u1");
    expect(view.path).toBe(other);
    await waitForStorageMoves();

    // The libraries: folder moved, source path follows, still nominated / still the Inbox.
    expect(getHouseLibrary()!.source_path).toBe(path.join(other, "App files"));
    expect(fs.existsSync(path.join(other, "App files", "note.m4a"))).toBe(true);
    expect(fs.existsSync(path.join(appDir, "App files"))).toBe(false);
    expect(modeOf("house").mode).toBe("app");
    expect(modeOf("house").library!.id).toBe(houseId);
    expect(modeOf("inbox").mode).toBe("app");
    expect(fs.existsSync(path.join(other, "Photo Inbox", "new.jpg"))).toBe(true);
    // Renders and map data: carried as tasks, and read from the new folder.
    expect(fs.existsSync(path.join(other, "Renders", "music", "ab", "song.mp3"))).toBe(true);
    expect(getRendersRoot()).toBe(path.join(other, "Renders"));
    expect(fs.existsSync(path.join(other, "Map data", "Tiles", "vector", "t.pbf.gz"))).toBe(true);
    expect(mapDataDir()).toBe(path.join(other, "Map data"));
    // Thumbnails are not App storage's: they stayed.
    expect(configuredThumbnailPathValue()).toBe(thumbs);
  });

  it("a room told to stay leaves App storage: a library stays as the room's own library, renders go back into the thumbnail folder", async () => {
    switchRoom("house", "app", null, "u1");
    await settleScans();
    switchRoom("renders", "app", null, "u1");
    fs.mkdirSync(path.join(appDir, "Renders", "music"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "Renders", "music", "song.mp3"), "MP3");

    setAppStoragePath(other, "u1", { house: false, renders: false });
    // Only the renders leave as a task (into the thumbnail folder); nothing else moves.
    await waitForStorageMoves();

    expect(getHouseLibrary()!.source_path).toBe(path.join(appDir, "App files"));
    expect(modeOf("house").mode).toBe("own");
    expect(modeOf("renders").mode).toBe("own");
    expect(fs.existsSync(path.join(thumbs, "music", "song.mp3"))).toBe(true);
    expect(fs.existsSync(path.join(appDir, "Renders", "music"))).toBe(false);
  });

  it("map data told to stay goes back to its own folder; with nothing kept, a folder change queues no move for it", async () => {
    const own = path.join(base, "map-data");
    process.env.MAP_DATA_PATH = own;
    try {
      const jobsFor = () => (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = ? AND payload LIKE '%\"room\":\"maps\"%'").get(STORAGE_MOVE_JOB_TYPE) as { n: number }).n;
      const before = jobsFor();
      // Nothing kept: the room follows App storage to the new folder, and the Tasks
      // page gets no empty move for a feature nobody turned on.
      setAppStoragePath(other, "u1");
      expect(mapDataDir()).toBe(path.join(other, "Map data"));
      expect(jobsFor()).toBe(before);

      fs.mkdirSync(path.join(other, "Map data", "Tiles"), { recursive: true });
      fs.writeFileSync(path.join(other, "Map data", "Tiles", "t.pbf.gz"), "TILE");
      setAppStoragePath(appDir, "u1", { maps: false });
      await waitForStorageMoves();
      expect(modeOf("maps").mode).toBe("own");
      expect(mapDataDir()).toBe(own);
      expect(fs.readFileSync(path.join(own, "Tiles", "t.pbf.gz"), "utf8")).toBe("TILE");
      expect(fs.existsSync(path.join(other, "Map data"))).toBe(false);
    } finally {
      delete process.env.MAP_DATA_PATH;
    }
  });

  it("clearing the folder leaves every room where it is", async () => {
    switchRoom("house", "app", null, "u1");
    await settleScans();
    const view = setAppStoragePath(null, "u1");
    expect(view.path).toBeNull();
    expect(getHouseLibrary()!.source_path).toBe(path.join(appDir, "App files"));
    expect(getAppStorageSetting().rooms).toEqual({});
    // Choosing the old folder again is allowed: the libraries in it are its own rooms'.
    expect(setAppStoragePath(appDir, "u1").path).toBe(appDir);
  });

  it("refuses to carry a library onto a folder that exists there, and puts back what had already moved", async () => {
    switchRoom("house", "app", null, "u1");
    switchRoom("inbox", "app", null, "u1");
    await settleScans();
    await settleScans();
    fs.writeFileSync(path.join(appDir, "App files", "note.m4a"), "AAC");
    // Something already lives at the room's folder in the new place (an empty
    // folder would simply be taken over).
    fs.mkdirSync(path.join(other, "Photo Inbox"));
    fs.writeFileSync(path.join(other, "Photo Inbox", "theirs.jpg"), "JPG");
    expect(() => setAppStoragePath(other, "u1")).toThrowError(/already exists/);
    expect(getAppStorageSetting().path).toBe(appDir);
    expect(getHouseLibrary()!.source_path).toBe(path.join(appDir, "App files"));
    expect(fs.existsSync(path.join(appDir, "App files", "note.m4a"))).toBe(true);
    expect(fs.existsSync(path.join(other, "App files"))).toBe(false);
  });

  it("refuses while a library room is being scanned", async () => {
    switchRoom("house", "app", null, "u1");
    await settleScans();
    db.prepare("UPDATE libraries SET scan_status = 'scanning' WHERE id = ?").run(getHouseLibrary()!.id);
    expect(() => setAppStoragePath(other, "u1")).toThrowError(/being scanned/);
  });
});

describe("the bin move", () => {
  // One folder for every library, inside the test container and outside every library.
  let bin = "";
  beforeEach(() => {
    setThumbs(thumbs);
    bin = path.join(base, "Recycle Bin");
    fs.mkdirSync(bin);
  });

  it("carries every item to the new location, row by row, and back again", async () => {
    trashBook(makeBook("bk1"), "u1");
    trashBook(makeBook("bk2"), "u1");
    const before = binRows();
    expect(before.every((row) => row.trash_root === null && row.trash_path.startsWith(".trash/"))).toBe(true);
    expect(fs.existsSync(path.join(libSource, ".trash"))).toBe(true);

    // An original Replace file set aside beside the bin: no row, but it must travel too.
    const keptOld = path.join(libSource, ".trash", "replaced", "LIB", "bk9");
    fs.mkdirSync(keptOld, { recursive: true });
    fs.writeFileSync(path.join(keptOld, "2026-09-03T21-32-59-482Z-old.jpg"), "OLDJPG");

    changeTrashRoot(bin, "u1");
    expect(getTrashRootSetting()).toBe(bin);
    const status = await waitForTrashMove();
    expect(status.failed).toEqual([]);
    expect(status.pending).toBe(0);
    expect(status.moved).toBe(3);
    expect(fs.readFileSync(path.join(bin, "replaced", "LIB", "bk9", "2026-09-03T21-32-59-482Z-old.jpg"), "utf8")).toBe("OLDJPG");
    expect(fs.existsSync(path.join(libSource, ".trash", "replaced"))).toBe(false);
    for (const row of binRows()) {
      expect(row.trash_root).toBe(bin);
      expect(row.trash_path.startsWith("LIB/")).toBe(true);
      expect(fs.existsSync(path.join(bin, row.trash_path, row.trash_path.endsWith("bk1") ? "" : ""))).toBe(true);
    }
    expect(fs.existsSync(path.join(bin, "LIB", path.posix.basename(binRows()[0].trash_path), "bk1", "part1.mp3"))).toBe(true);
    // The emptied per-library .trash is pruned.
    expect(fs.existsSync(path.join(libSource, ".trash"))).toBe(false);

    // Back to each library's own .trash, and the files follow.
    changeTrashRoot(null, "u1");
    await waitForTrashMove();
    expect(binRows().every((row) => row.trash_root === null && row.trash_path.startsWith(".trash/"))).toBe(true);
    expect(fs.existsSync(path.join(libSource, ".trash"))).toBe(true);
    expect(fs.existsSync(path.join(bin, "LIB"))).toBe(false);
    // The replaced original came back to the library's own .trash, and the old
    // bin holds nothing of it any more.
    expect(fs.readFileSync(path.join(keptOld, "2026-09-03T21-32-59-482Z-old.jpg"), "utf8")).toBe("OLDJPG");
    expect(fs.existsSync(path.join(bin, "replaced"))).toBe(false);
  });

  it("lists a row whose files are missing as failed and leaves it where it was", async () => {
    trashBook(makeBook("bk1"), "u1");
    const row = binRows()[0];
    fs.rmSync(path.join(libSource, row.trash_path), { recursive: true, force: true });
    changeTrashRoot(bin, "u1");
    const status = await waitForTrashMove();
    expect(status.failed).toHaveLength(1);
    expect(status.failed[0].id).toBe(row.id);
    expect(binRows()[0].trash_root).toBeNull();
    expect(pendingTrashMoveRows()).toHaveLength(1);
  });

  it("restore keeps working during a move, from the row's own location", async () => {
    trashBook(makeBook("bk1"), "u1");
    setTrashRootSetting(bin, "u1");
    // Nothing moved yet; the setting says the shared folder, the row says the library's .trash.
    expect(pendingTrashMoveRows()).toHaveLength(1);
    const { restoreTrashedItem } = await import("../src/modules/library/shared/trash.js");
    await restoreTrashedItem(binRows()[0].id);
    expect(fs.existsSync(path.join(libSource, "bk1", "part1.mp3"))).toBe(true);
    expect(startTrashMove().pending).toBe(0);
  });
});
