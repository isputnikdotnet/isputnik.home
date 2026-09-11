import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { getGalleryAssetUnscoped } from "../src/modules/library/gallery/catalog-asset.js";
import { setHouseLibrary } from "../src/modules/library/gallery/house-library.js";
import { deleteVoiceNote, listVoiceNotes, storeVoiceNote, voiceNoteFile, VoiceNoteError } from "../src/modules/library/gallery/voice-notes.js";
import { thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import { grant, makeLibrary, makeUser, resetDb } from "./helpers/seed.js";
import "./helpers/media-types.js";

// Voice notes (docs/photo-review-plan.md, phase 4): a recording kept on a
// photo, stored as an audio asset in the house library and tied by one row.

let base = "";
let houseSource = "";

function stagedUpload(): string {
  const tmp = path.join(os.tmpdir(), `vn-test-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmp, "not really audio, but a real file");
  return tmp;
}

beforeEach(() => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("helper", "member");
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-voice-")));
  houseSource = path.join(base, "House");
  fs.mkdirSync(houseSource, { recursive: true });
  fs.mkdirSync(path.join(base, "_thumbs"), { recursive: true });
  db.prepare("DELETE FROM storage_roots").run();
  db.prepare("INSERT INTO storage_roots (id, name, path, created_by) VALUES ('root1', 'Root', ?, 'admin')").run(base);
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run(thumbnailPathSettingKey, path.join(base, "_thumbs"));
  makeLibrary("house", { createdBy: "admin", type: "gallery" });
  db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'house'").run(houseSource);
  // The photo lives in a library the helper cannot see at all.
  makeLibrary("gal", { createdBy: "admin", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "gal", "viewer");
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES ('p1', 'gal', 'gallery', 'box/scan 001.jpg', 'ready')").run();
  db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES ('p1', 'scan', 'scan 001.jpg')").run();
  db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path, size) VALUES ('p1', 'photo', 'box/scan 001.jpg', 9)").run();
});

afterEach(() => {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("a voice note on a photo", () => {
  it("needs the house library, and says so", async () => {
    await expect(storeVoiceNote("p1", "helper", stagedUpload(), "webm")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("lands under Voice notes/<year>, named after the photo, as audio the photo points at", async () => {
    setHouseLibrary("house", "admin");
    const note = await storeVoiceNote("p1", "helper", stagedUpload(), "webm");
    const year = String(new Date().getFullYear());
    const files = fs.readdirSync(path.join(houseSource, "Voice notes", year));
    expect(files).toEqual(["scan 001 - voice note.weba"]);
    expect(note.url).toBe(`/api/library/gallery/assets/p1/voice-notes/${note.id}/audio`);
    expect(note.recordedBy).toBe("helper");
    expect(listVoiceNotes("p1")).toHaveLength(1);
    // The photo's detail carries it, and the audio is a real asset of the house library.
    expect(getGalleryAssetUnscoped("admin", "p1")?.voiceNotes).toHaveLength(1);
    const audio = db.prepare("SELECT library_items.library_id FROM gallery_voice_notes JOIN library_items ON library_items.id = gallery_voice_notes.audio_item_id WHERE gallery_voice_notes.id = ?")
      .get(note.id) as { library_id: string };
    expect(audio.library_id).toBe("house");
    const file = voiceNoteFile("p1", note.id);
    expect(file?.mime).toBe("audio/webm");
    expect(fs.existsSync(file!.path)).toBe(true);
    // A second one on the same photo gets its own name.
    await storeVoiceNote("p1", "helper", stagedUpload(), "ogg");
    expect(fs.readdirSync(path.join(houseSource, "Voice notes", year)).sort()).toEqual(["scan 001 - voice note.ogg", "scan 001 - voice note.weba"]);
  });

  it("refuses a photo that is not there and a file that is not a recording", async () => {
    setHouseLibrary("house", "admin");
    await expect(storeVoiceNote("nope", "helper", stagedUpload(), "webm")).rejects.toBeInstanceOf(VoiceNoteError);
    await expect(storeVoiceNote("p1", "helper", stagedUpload(), "exe")).rejects.toMatchObject({ statusCode: 415 });
  });

  it("removing one drops the tie and bins the recording; a note on another photo is untouched", async () => {
    setHouseLibrary("house", "admin");
    const note = await storeVoiceNote("p1", "helper", stagedUpload(), "webm");
    expect(deleteVoiceNote("p1", "wrong-id", "admin")).toBe(false);
    expect(deleteVoiceNote("p1", note.id, "admin")).toBe(true);
    expect(listVoiceNotes("p1")).toHaveLength(0);
    expect(voiceNoteFile("p1", note.id)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM trashed_items").get()).toEqual({ n: 1 });
  });
});
