import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db.js";
import {
  getAppStoragePath,
  getAppStorageSetting,
  resolveAppLocation,
  uploadStagingDir
} from "../src/core/app-storage.js";
import { saveSystemDataPath } from "../src/core/system-data.js";
import {
  appStorageView,
  changeAppStorage,
  ensureAppStorageParts,
  movePartIn,
  renameAppFilesFolder,
  turnOffAppStorage,
  turnOnAppStorage
} from "../src/modules/library/app-storage-service.js";
import { convertAppStorageSetting } from "../src/modules/library/app-storage-upgrade.js";
import { appStorageRoutesPlugin } from "../src/modules/library/app-storage-routes.js";
import { AppStorageError } from "../src/modules/library/app-storage.js";
import { copyTreeVerified, pendingTrashMoveRows, STORAGE_MOVE_JOB_TYPE, waitForStorageMoves } from "../src/modules/library/shared/storage-move.js";
import { getHouseLibrary, setHouseLibrary } from "../src/modules/library/gallery/house-library.js";
import { systemLibraryId } from "../src/modules/library/gallery/system-libraries.js";
import { getRendersRoot } from "../src/modules/library/shared/thumbnail.js";
import { validateLibrarySource } from "../src/modules/library/shared/library-source.js";
import { getTrashRootSetting, setTrashRootSetting } from "../src/modules/library/shared/trash-settings.js";
import { trashBook } from "../src/modules/library/shared/trash.js";
import { changeTrashRoot, startTrashMove, waitForTrashMove } from "../src/modules/library/shared/trash-move.js";
import { getMapSettings, saveMapSettings } from "../src/modules/maps/settings.js";
import { mapDataDir } from "../src/modules/maps/storage.js";
import { bootApp } from "./helpers/boot.js";
import { makeLibrary, makeUser, resetDb } from "./helpers/seed.js";
import "./helpers/media-types.js";

// App storage (docs/system-data-plan.md, phase 3): one switch for the Photo Inbox,
// App files, Renders and Map data. On makes them together in one folder; off
// removes them, refused while any holds something; Change moves the whole of it;
// a part outside it moves in on request. Nothing moves without being asked, and the
// 4.6 conversion moves nothing at all.

let base = "";
let system = "";
let media = "";
let ownMaps = "";
let libSource = "";

function setting(value: object): void {
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('app_storage', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(value));
}

function makeBook(id: string): string {
  fs.mkdirSync(path.join(libSource, id), { recursive: true });
  fs.writeFileSync(path.join(libSource, id, "part1.mp3"), "AUDIO");
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, 'LIB', 'audiobook', ?, 'ready')").run(id, id);
  db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES (?, 'scan', ?)").run(id, `Title ${id}`);
  return id;
}

function galleryItem(libraryId: string, id: string, relativePath: string): void {
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, ?, 'gallery', ?, 'ready')").run(id, libraryId, relativePath);
}

/** Switching on queues a scan of each library it makes; wait for them, since a
 *  library move is (rightly) refused under a running scan. */
async function settleScans() {
  for (let i = 0; i < 400; i++) {
    const n = (db.prepare("SELECT COUNT(*) AS n FROM libraries WHERE scan_status = 'scanning'").get() as { n: number }).n;
    if (n === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("a gallery scan never finished");
}

function binRows() {
  return db.prepare("SELECT id, trash_root, trash_path, source_path FROM trashed_items ORDER BY trashed_at")
    .all() as { id: string; trash_root: string | null; trash_path: string; source_path: string }[];
}

const part = (name: string) => appStorageView().parts.find((entry) => entry.part === name)!;

beforeEach(() => {
  resetDb();
  // The jobs table outlives resetDb: a move another test left queued would hold every change here.
  db.prepare("DELETE FROM jobs WHERE type = ?").run(STORAGE_MOVE_JOB_TYPE);
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "app-storage-")));
  system = path.join(base, "sys");
  media = path.join(base, "media");
  ownMaps = path.join(base, "own-maps");
  libSource = path.join(media, "library");
  for (const dir of [system, media, libSource]) fs.mkdirSync(dir, { recursive: true });
  process.env.MAP_DATA_PATH = ownMaps;
  makeUser("u1", "admin");
  saveSystemDataPath(system, "u1");
  db.prepare("INSERT OR REPLACE INTO storage_roots (id, name, path, created_by) VALUES ('sr1', 'media', ?, 'u1')").run(media);
  makeLibrary("LIB", { createdBy: "u1", type: "audiobook" });
  db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'LIB'").run(libSource);
});

afterEach(() => {
  delete process.env.MAP_DATA_PATH;
});

describe("off", () => {
  it("is off on a fresh install, with nothing made, and says where it would go", () => {
    const view = appStorageView();
    expect(view.enabled).toBe(false);
    expect(view.where).toBe("system");
    expect(view.folder).toBe(path.join(system, "app-storage"));
    expect(view.parts.map((entry) => `${entry.part}:${entry.inside}:${entry.library?.id ?? "-"}`)).toEqual([
      "inbox:false:-", "house:false:-", "renders:false:-", "maps:false:-"
    ]);
    expect(getAppStoragePath()).toBeNull();
    expect(resolveAppLocation("renders")).toBeNull();
    expect(mapDataDir()).toBe(ownMaps);
    expect(uploadStagingDir().startsWith(path.join(system, "app-storage"))).toBe(false);
  });

  it("remembers where it will live without switching anything on", () => {
    const custom = path.join(media, "iSputnik");
    changeAppStorage({ where: "custom", path: custom }, "u1");
    expect(getAppStorageSetting()).toEqual({ enabled: false, where: "custom", path: custom, outside: {} });
    expect(fs.existsSync(path.join(custom, "Photo Inbox"))).toBe(false);
  });
});

describe("switching on", () => {
  it("makes both system libraries and the four folders in system data, outside every container", async () => {
    const view = turnOnAppStorage({ where: "system" }, "u1");
    await settleScans();
    const root = path.join(system, "app-storage");
    expect(view.enabled).toBe(true);
    expect(view.folder).toBe(root);
    for (const folder of ["Photo Inbox", "App files", "Renders", "Map data"]) expect(fs.existsSync(path.join(root, folder))).toBe(true);
    expect(view.parts.every((entry) => entry.inside)).toBe(true);
    const inbox = db.prepare("SELECT source_path, name FROM libraries WHERE role = 'inbox'").get() as { source_path: string; name: string };
    expect(inbox).toEqual({ source_path: path.join(root, "Photo Inbox"), name: "Photo Inbox" });
    expect(getHouseLibrary()?.source_path).toBe(path.join(root, "App files"));
    // A library source outside any container is accepted because it is App storage's.
    expect(validateLibrarySource(inbox.source_path)).toBe(inbox.source_path);
    expect(getRendersRoot()).toBe(path.join(root, "Renders"));
    expect(mapDataDir()).toBe(path.join(root, "Map data"));
    expect(uploadStagingDir()).toBe(path.join(root, ".staging"));
    expect(() => turnOnAppStorage({ where: "system" }, "u1")).toThrowError(/already on/);
  });

  it("needs system data, and a custom folder that is not a container or inside a library", () => {
    db.prepare("DELETE FROM app_settings WHERE key = 'system_data'").run();
    expect(() => turnOnAppStorage({ where: "system" }, "u1")).toThrowError(/Choose system data first/);
    saveSystemDataPath(system, "u1");
    expect(() => turnOnAppStorage({ where: "custom", path: media }, "u1")).toThrowError(/container "media"/);
    expect(() => turnOnAppStorage({ where: "custom", path: path.join(libSource, "x") }, "u1")).toThrowError(/inside the library/);
    expect(getAppStorageSetting().enabled).toBe(false);
  });

  it("carries music waiting in the render buckets and map data kept in its own folder into App storage", async () => {
    const song = path.join(system, "thumbnails", "music", "ab", "song.mp3");
    fs.mkdirSync(path.dirname(song), { recursive: true });
    fs.writeFileSync(song, "MP3");
    fs.mkdirSync(path.join(ownMaps, "Locations"), { recursive: true });
    fs.writeFileSync(path.join(ownMaps, "Locations", "country.mmdb"), "DB");
    const custom = path.join(media, "iSputnik");
    turnOnAppStorage({ where: "custom", path: custom }, "u1");
    await settleScans();
    await waitForStorageMoves();
    expect(fs.readFileSync(path.join(custom, "Renders", "music", "ab", "song.mp3"), "utf8")).toBe("MP3");
    expect(fs.readFileSync(path.join(custom, "Map data", "Locations", "country.mmdb"), "utf8")).toBe("DB");
    expect(fs.existsSync(song)).toBe(false);
  });

  it("keeps a system library made before, wherever it is, and moves it in on request", async () => {
    const family = path.join(media, "Family");
    fs.mkdirSync(family);
    fs.writeFileSync(path.join(family, "note.m4a"), "NOTE");
    makeLibrary("FAM", { createdBy: "u1", type: "gallery" });
    db.prepare("UPDATE libraries SET name = 'Family', source_path = ? WHERE id = 'FAM'").run(family);
    expect(setHouseLibrary("FAM", "u1").ok).toBe(true);

    turnOnAppStorage({ where: "system" }, "u1");
    await settleScans();
    expect(part("house")).toMatchObject({ inside: false, folder: family, library: { id: "FAM", name: "Family" } });
    expect(part("inbox").inside).toBe(true);

    // Across volumes: every rename fails with EXDEV, so the task copies and verifies.
    const exdev = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw exdev; });
    try {
      movePartIn("house", "u1");
      await waitForStorageMoves();
    } finally {
      rename.mockRestore();
    }
    const appFiles = path.join(system, "app-storage", "App files");
    expect(getHouseLibrary()?.source_path).toBe(appFiles);
    expect(fs.readFileSync(path.join(appFiles, "note.m4a"), "utf8")).toBe("NOTE");
    expect(fs.existsSync(family)).toBe(false);
    expect(part("house").inside).toBe(true);
    const done = db.prepare("SELECT status FROM jobs WHERE type = ? AND payload LIKE '%\"room\":\"house\"%' ORDER BY created_at DESC LIMIT 1").get(STORAGE_MOVE_JOB_TYPE) as { status: string };
    expect(done.status).toBe("completed");
  });
});

describe("switching off", () => {
  beforeEach(async () => {
    turnOnAppStorage({ where: "system" }, "u1");
    await settleScans();
  });

  it("is refused while the Inbox has photos waiting, App files holds files, or the bin holds their items", () => {
    const inboxId = systemLibraryId("inbox")!;
    const houseId = systemLibraryId("app-files")!;
    galleryItem(inboxId, "p1", "scan/a.jpg");
    expect(() => turnOffAppStorage("u1")).toThrowError(/One photo is still waiting/);
    db.prepare("DELETE FROM library_items WHERE id = 'p1'").run();

    galleryItem(houseId, "f1", "Voice notes/2026/a.m4a");
    expect(() => turnOffAppStorage("u1")).toThrowError(/App files holds one file/);
    db.prepare("DELETE FROM library_items WHERE id = 'f1'").run();

    db.prepare(`INSERT INTO trashed_items (id, library_id, library_type, library_name, source_path, title, origin_path, trash_path)
      VALUES ('t1', ?, 'gallery', 'Photo Inbox', '/x', 'a.jpg', 'a.jpg', '.trash/t1')`).run(inboxId);
    expect(() => turnOffAppStorage("u1")).toThrowError(AppStorageError);
    expect(() => turnOffAppStorage("u1")).toThrowError(/Recycle Bin still holds one item/);
    expect(getAppStorageSetting().enabled).toBe(true);
  });

  it("removes the libraries, the kept maps and the folders, and keeps the sign-in location databases", async () => {
    const root = path.join(system, "app-storage");
    saveMapSettings({ cache: true, cacheLimitMb: 200 }, "u1");
    fs.mkdirSync(path.join(root, "Map data", "Tiles", "vector"), { recursive: true });
    fs.writeFileSync(path.join(root, "Map data", "Tiles", "vector", "t.pbf.gz"), "TILE");
    fs.mkdirSync(path.join(root, "Map data", "Locations"), { recursive: true });
    fs.writeFileSync(path.join(root, "Map data", "Locations", "country.mmdb"), "DB");

    const view = turnOffAppStorage("u1");
    expect(view.enabled).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM libraries WHERE role IS NOT NULL").get()).toEqual({ n: 0 });
    expect(getMapSettings().cache).toBe(false);
    expect(fs.existsSync(path.join(root, "Map data", "Tiles"))).toBe(false);
    expect(fs.existsSync(path.join(root, "Photo Inbox"))).toBe(false);

    await waitForStorageMoves();
    expect(fs.readFileSync(path.join(ownMaps, "Locations", "country.mmdb"), "utf8")).toBe("DB");
    expect(mapDataDir()).toBe(ownMaps);
    expect(() => turnOffAppStorage("u1")).toThrowError(/already off/);

    // On again makes fresh libraries rather than finding the old ones.
    turnOnAppStorage({ where: "system" }, "u1");
    await settleScans();
    expect(systemLibraryId("inbox")).not.toBeNull();
  });
});

describe("changing where it lives", () => {
  it("moves every part inside it to the new folder as tasks", async () => {
    turnOnAppStorage({ where: "system" }, "u1");
    await settleScans();
    const oldRoot = path.join(system, "app-storage");
    fs.writeFileSync(path.join(oldRoot, "App files", "note.m4a"), "AAC");
    fs.mkdirSync(path.join(oldRoot, "Renders", "music"), { recursive: true });
    fs.writeFileSync(path.join(oldRoot, "Renders", "music", "song.mp3"), "MP3");
    const houseId = getHouseLibrary()!.id;

    const custom = path.join(media, "iSputnik");
    changeAppStorage({ where: "custom", path: custom }, "u1");
    expect(getRendersRoot()).toBe(path.join(custom, "Renders"));
    await waitForStorageMoves();
    expect(getHouseLibrary()).toMatchObject({ id: houseId, source_path: path.join(custom, "App files") });
    expect(fs.readFileSync(path.join(custom, "App files", "note.m4a"), "utf8")).toBe("AAC");
    expect(fs.readFileSync(path.join(custom, "Renders", "music", "song.mp3"), "utf8")).toBe("MP3");
    expect(appStorageView().parts.every((entry) => entry.inside)).toBe(true);
  });

  it("refuses to carry a library onto a folder already holding something there", async () => {
    turnOnAppStorage({ where: "system" }, "u1");
    await settleScans();
    const custom = path.join(media, "iSputnik");
    fs.mkdirSync(path.join(custom, "Photo Inbox"), { recursive: true });
    fs.writeFileSync(path.join(custom, "Photo Inbox", "theirs.jpg"), "JPG");
    expect(() => changeAppStorage({ where: "custom", path: custom }, "u1")).toThrowError(/already exists/);
    expect(getAppStorageSetting().where).toBe("system");
  });
});

describe("parts outside it", () => {
  it("moves renders kept in the thumbnail folder in on request", async () => {
    const root = path.join(system, "app-storage");
    setting({ enabled: true, where: "system", path: null, outside: { renders: true } });
    ensureAppStorageParts();
    await settleScans();
    const song = path.join(system, "thumbnails", "music", "song.mp3");
    fs.mkdirSync(path.dirname(song), { recursive: true });
    fs.writeFileSync(song, "MP3");
    expect(part("renders")).toMatchObject({ inside: false, folder: path.join(system, "thumbnails") });
    expect(getRendersRoot()).toBe(path.join(system, "thumbnails"));

    movePartIn("renders", "u1");
    expect(getAppStorageSetting().outside).toEqual({});
    await waitForStorageMoves();
    expect(fs.existsSync(path.join(root, "Renders", "music", "song.mp3"))).toBe(true);
    expect(part("renders").inside).toBe(true);
  });

  it("renames App files from its former folder name, the library following", async () => {
    const root = path.join(system, "app-storage");
    const former = path.join(root, "Made in the app");
    fs.mkdirSync(path.join(former, "Voice notes"), { recursive: true });
    fs.writeFileSync(path.join(former, "Voice notes", "note.weba"), "AUDIO");
    makeLibrary("OLD", { createdBy: "u1", type: "gallery" });
    db.prepare("UPDATE libraries SET name = 'Made in the app', source_path = ? WHERE id = 'OLD'").run(former);
    expect(setHouseLibrary("OLD", "u1").ok).toBe(true);
    turnOnAppStorage({ where: "system" }, "u1");
    await settleScans();
    expect(part("house").renameTo).toBe(path.join(root, "App files"));

    renameAppFilesFolder("u1");
    await waitForStorageMoves();
    expect(db.prepare("SELECT name, source_path FROM libraries WHERE id = 'OLD'").get()).toEqual({ name: "App files", source_path: path.join(root, "App files") });
    expect(part("house").renameTo).toBeNull();
    expect(() => renameAppFilesFolder("u1")).toThrowError(/already has its current name/);
  });
});

describe("the 4.6 conversion", () => {
  it("turns a chosen folder on there, marking what stayed in its own place outside", () => {
    setting({ path: path.join(media, "iSputnik"), rooms: { renders: "app", maps: "own" } });
    expect(convertAppStorageSetting()).toEqual({ enabled: true, where: "custom", path: path.join(media, "iSputnik"), outside: { maps: true } });
    expect(convertAppStorageSetting()).toBeNull();
  });

  it("switches on in system data when a part is used without a folder, leaving it where it is", () => {
    makeLibrary("FAM", { createdBy: "u1", type: "gallery", role: "app-files" });
    expect(convertAppStorageSetting()).toEqual({ enabled: true, where: "system", path: null, outside: { renders: true, maps: true } });
    expect(getRendersRoot()).toBe(path.join(system, "thumbnails"));
    expect(mapDataDir()).toBe(ownMaps);
  });

  it("leaves it off when nothing used it", () => {
    expect(convertAppStorageSetting()).toEqual({ enabled: false, where: "system", path: null, outside: {} });
  });

  it("makes a missing system library at startup once it is on", async () => {
    setting({ enabled: true, where: "system", path: null, outside: {} });
    expect(ensureAppStorageParts().sort()).toEqual(["App files", "Photo Inbox"]);
    await settleScans();
    expect(ensureAppStorageParts()).toEqual([]);
  });
});

describe("the routes", () => {
  let app: FastifyInstance;
  let signIn: (userId: string) => Promise<string>;
  beforeEach(async () => {
    ({ app, signIn } = await bootApp({ plugins: [appStorageRoutesPlugin] }));
  });
  afterEach(async () => {
    await settleScans();
    await app.close();
  });

  it("switches on, says why it will not go off, and is for admins only", async () => {
    const cookie = await signIn("u1");
    const on = await app.inject({ method: "POST", url: "/api/storage/app-storage/on", headers: { cookie }, payload: { where: "system" } });
    expect(on.statusCode).toBe(200);
    expect(on.json().enabled).toBe(true);

    galleryItem(systemLibraryId("inbox")!, "p1", "a.jpg");
    const read = await app.inject({ method: "GET", url: "/api/storage/app-storage", headers: { cookie } });
    expect(read.json().offRefusal).toMatch(/still waiting/);
    const off = await app.inject({ method: "POST", url: "/api/storage/app-storage/off", headers: { cookie } });
    expect(off.statusCode).toBe(409);

    makeUser("kid");
    const kid = await signIn("kid");
    expect((await app.inject({ method: "GET", url: "/api/storage/app-storage", headers: { cookie: kid } })).statusCode).toBe(403);
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

describe("the bin move", () => {
  // One folder for every library, inside the test container and outside every library.
  let bin = "";
  beforeEach(() => {
    bin = path.join(media, "Recycle Bin");
    fs.mkdirSync(bin);
  });

  it("carries every item to the new location, row by row, and back again", async () => {
    trashBook(makeBook("bk1"), "u1");
    trashBook(makeBook("bk2"), "u1");
    expect(binRows().every((row) => row.trash_root === null && row.trash_path.startsWith(".trash/"))).toBe(true);

    // An original Replace file set aside beside the bin: no row, but it must travel too.
    const keptOld = path.join(libSource, ".trash", "replaced", "LIB", "bk9");
    fs.mkdirSync(keptOld, { recursive: true });
    fs.writeFileSync(path.join(keptOld, "old.jpg"), "OLDJPG");

    changeTrashRoot(bin, "u1");
    expect(getTrashRootSetting()).toBe(bin);
    const status = await waitForTrashMove();
    expect(status.failed).toEqual([]);
    expect(status.moved).toBe(3);
    expect(fs.readFileSync(path.join(bin, "replaced", "LIB", "bk9", "old.jpg"), "utf8")).toBe("OLDJPG");
    for (const row of binRows()) {
      expect(row.trash_root).toBe(bin);
      expect(row.trash_path.startsWith("LIB/")).toBe(true);
    }
    expect(fs.existsSync(path.join(libSource, ".trash"))).toBe(false);

    changeTrashRoot(null, "u1");
    await waitForTrashMove();
    expect(binRows().every((row) => row.trash_root === null && row.trash_path.startsWith(".trash/"))).toBe(true);
    expect(fs.readFileSync(path.join(keptOld, "old.jpg"), "utf8")).toBe("OLDJPG");
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
    expect(pendingTrashMoveRows()).toHaveLength(1);
    const { restoreTrashedItem } = await import("../src/modules/library/shared/trash.js");
    await restoreTrashedItem(binRows()[0].id);
    expect(fs.existsSync(path.join(libSource, "bk1", "part1.mp3"))).toBe(true);
    expect(startTrashMove().pending).toBe(0);
  });
});
