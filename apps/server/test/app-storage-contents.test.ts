import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { appStorageContents, deleteOrphanAppFile, folderStats } from "../src/modules/library/app-storage-contents.js";
import { setAppStoragePath } from "../src/modules/library/app-storage.js";
import { HOUSE_FOLDERS, setHouseLibrary } from "../src/modules/library/gallery/house-library.js";
import { thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

// The Contents page beside Storage: every room counted, and the App files
// library listed folder by folder with what owns each file — orphans marked,
// and only orphans deletable.

let base = "";
let appDir = "";
let house = "";

function item(id: string, relativePath: string, size: number, kind = "audio"): void {
  const abs = path.join(house, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "X".repeat(size));
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status, discovered_at) VALUES (?, 'HOUSE', 'gallery', ?, 'ready', ?)")
    .run(id, relativePath, `2026-09-0${id.length % 9 + 1}T00:00:00.000Z`);
  db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES (?, 'scan', ?)").run(id, path.basename(relativePath));
  db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path, size) VALUES (?, ?, ?, ?)").run(id, kind, relativePath, size);
}

beforeEach(() => {
  resetDb();
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "contents-")));
  appDir = path.join(base, "iSputnik");
  fs.mkdirSync(appDir);
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run(thumbnailPathSettingKey, path.join(base, "thumbs"));
  makeUser("u1", "admin");
  db.prepare("INSERT OR REPLACE INTO storage_roots (id, name, path, created_by) VALUES ('sr1', 'test', ?, 'u1')").run(base);
  setAppStoragePath(appDir, "u1");
  house = path.join(appDir, "App files");
  makeLibrary("HOUSE", { createdBy: "u1", type: "gallery" });
  fs.mkdirSync(house, { recursive: true });
  db.prepare("UPDATE libraries SET name = 'App files', source_path = ? WHERE id = 'HOUSE'").run(house);
  grant("group", EVERYONE_GROUP_ID, "HOUSE", "member");
  expect(setHouseLibrary("HOUSE", "u1").ok).toBe(true);
});

describe("App storage contents", () => {
  it("counts a folder's files and bytes", () => {
    const dir = path.join(base, "walk");
    fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(dir, "one.bin"), "12345");
    fs.writeFileSync(path.join(dir, "a", "b", "two.bin"), "12");
    expect(folderStats(dir)).toEqual({ files: 2, bytes: 7, complete: true });
    expect(folderStats(null)).toEqual({ files: 0, bytes: 0, complete: true });
  });

  it("lists every room and the App files library by folder, naming owners and marking orphans", () => {
    // A recording that narrates a story, and one whose story is gone.
    item("rec1", `${HOUSE_FOLDERS.recordings}/story-a.m4a`, 10);
    item("rec2", `${HOUSE_FOLDERS.recordings}/lost.m4a`, 20);
    db.prepare("INSERT INTO stories (id, title, created_by, kind, status) VALUES ('S1', 'Canada', 'u1', 'free', 'published')").run();
    db.prepare("INSERT INTO story_chapters (id, story_id, position, title) VALUES ('C1', 'S1', 1, 'One')").run();
    db.prepare("INSERT INTO story_blocks (id, chapter_id, position, kind, entity_type, entity_id) VALUES ('B1', 'C1', 1, 'audio', 'gallery', 'rec1')").run();
    // A music track, and a voice note on a photo of another library.
    item("mus1", `${HOUSE_FOLDERS.music}/song.mp3`, 30);
    db.prepare("INSERT INTO gallery_music_tracks (id, title, artist, builtin, storage_key, item_id) VALUES ('T1', 'Song', NULL, 0, '', 'mus1')").run();
    makeLibrary("FAM", { createdBy: "u1", type: "gallery" });
    db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'FAM'").run(path.join(base, "family"));
    db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES ('p1', 'FAM', 'gallery', '2020/kids.jpg', 'ready')").run();
    db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES ('p1', 'scan', 'Kids')").run();
    db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path, size) VALUES ('p1', 'photo', '2020/kids.jpg', 5)").run();
    item("vn1", `${HOUSE_FOLDERS.voiceNotes}/2026/note.m4a`, 40);
    db.prepare("INSERT INTO gallery_voice_notes (id, item_id, audio_item_id, recorded_by) VALUES ('V1', 'p1', 'vn1', 'u1')").run();
    // Something uploaded by hand into the library.
    item("up1", "2026/2026-09-04/clip.mp4", 50, "video");

    const contents = appStorageContents();
    expect(contents.path).toBe(appDir);
    const rooms = Object.fromEntries(contents.rooms.map((room) => [room.room, room]));
    expect(rooms.house).toMatchObject({ mode: "app", files: 5, bytes: 150, library: { id: "HOUSE", name: "App files" } });
    expect(rooms.trash.files).toBe(0);
    expect(contents.appFiles.library).toMatchObject({ id: "HOUSE", path: house });

    const folders = Object.fromEntries(contents.appFiles.folders.map((folder) => [folder.key, folder]));
    expect(Object.keys(folders)).toEqual(["recordings", "voiceNotes", "music", "other"]);
    expect(folders.recordings).toMatchObject({ files: 2, bytes: 30, orphans: 1 });
    // Orphans first inside a folder.
    expect(folders.recordings.entries.map((e) => [e.itemId, e.orphan, e.owner?.title ?? null])).toEqual([
      ["rec2", true, null],
      ["rec1", false, "Canada"]
    ]);
    expect(folders.recordings.entries[1].owner).toEqual({ type: "story", id: "S1", title: "Canada" });
    expect(folders.music.entries[0].owner).toEqual({ type: "track", id: "T1", title: "Song" });
    expect(folders.voiceNotes.entries[0].owner).toEqual({ type: "photo", id: "p1", title: "Kids", folder: "2020", libraryId: "FAM" });
    expect(folders.other).toMatchObject({ files: 1, orphans: 0 });
    expect(folders.other.entries[0]).toMatchObject({ itemId: "up1", owner: null, orphan: false });
  });

  it("deletes an orphan to the Recycle Bin and refuses anything owned or outside the app's folders", () => {
    item("rec1", `${HOUSE_FOLDERS.recordings}/story-a.m4a`, 10);
    item("rec2", `${HOUSE_FOLDERS.recordings}/lost.m4a`, 20);
    item("up1", "2026/clip.mp4", 50, "video");
    db.prepare("INSERT INTO stories (id, title, created_by, kind, status) VALUES ('S1', 'Canada', 'u1', 'free', 'published')").run();
    db.prepare("INSERT INTO story_chapters (id, story_id, position, title) VALUES ('C1', 'S1', 1, 'One')").run();
    db.prepare("INSERT INTO story_blocks (id, chapter_id, position, kind, entity_type, entity_id) VALUES ('B1', 'C1', 1, 'audio', 'gallery', 'rec1')").run();

    expect(() => deleteOrphanAppFile("rec1", "u1")).toThrowError(/still belongs/);
    expect(() => deleteOrphanAppFile("up1", "u1")).toThrowError(/not in one of the app's folders/);
    expect(() => deleteOrphanAppFile("nope", "u1")).toThrowError(/not in the App files library/);

    expect(deleteOrphanAppFile("rec2", "u1")).toEqual({ relativePath: `${HOUSE_FOLDERS.recordings}/lost.m4a` });
    expect(db.prepare("SELECT COUNT(*) AS n FROM trashed_items WHERE id = 'rec2' OR title = 'lost.m4a'").get()).toEqual({ n: 1 });
    expect(fs.existsSync(path.join(house, HOUSE_FOLDERS.recordings, "lost.m4a"))).toBe(false);
    const after = appStorageContents();
    expect(after.appFiles.folders.find((f) => f.key === "recordings")).toMatchObject({ files: 1, orphans: 0 });
  });
});
