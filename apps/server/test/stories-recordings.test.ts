// The v2 narration flow: recordings land in the admin-nominated gallery
// library as ordinary audio assets, and the one-time import moves the legacy
// story-owned clips (story_audio) there too. Real files on a temp storage
// root — storeRecording and the import both walk the same path an upload does
// (validateLibrarySource → move → scanSingleGalleryFile).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { db } from "../src/db.js";
import { thumbnailAbsolutePath, thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import { normalizeLibrarySettings } from "../src/modules/library/shared/library-settings.js";
import {
  ensureAudioScanExtensions,
  getRecordingsLibrary,
  setStoriesSettings
} from "../src/modules/stories/settings.js";
import {
  RecordingError,
  migrateLegacyNarrations,
  pendingLegacyNarrations,
  recordingExtension,
  storeRecording
} from "../src/modules/stories/recordings.js";
import { createStoryAudio } from "../src/modules/stories/audio.js";
import { createStory, getBlocks, getChapters } from "../src/modules/stories/stories.js";
import { resetDb, makeUser } from "./helpers/seed.js";

const author = { id: "author", role: "member" };
let rootDir = "";
let libSource = "";
let thumbDir = "";

beforeEach(() => {
  resetDb();
  makeUser("author");

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-recordings-"));
  rootDir = fs.realpathSync(base);
  libSource = path.join(rootDir, "Recordings");
  thumbDir = path.join(rootDir, "_thumbs");
  fs.mkdirSync(libSource, { recursive: true });
  fs.mkdirSync(thumbDir, { recursive: true });

  db.prepare("DELETE FROM storage_roots").run();
  db.prepare("INSERT INTO storage_roots (id, name, path, created_by) VALUES ('root1', 'Root', ?, 'author')").run(rootDir);
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run(thumbnailPathSettingKey, thumbDir);
  db.prepare("INSERT INTO libraries (id, name, type, source_path, created_by) VALUES ('REC', 'Recordings', 'gallery', ?, 'author')")
    .run(libSource);
});

afterEach(() => {
  try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function stagedUpload(): string {
  const tmp = path.join(os.tmpdir(), `rec-test-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmp, "not really audio, but a real file");
  return tmp;
}

describe("the recordings-library setting", () => {
  it("resolves the nominated library, and a deleted one reads as not set", () => {
    setStoriesSettings({ recordingsLibraryId: "REC" }, "author");
    expect(getRecordingsLibrary()?.id).toBe("REC");
    db.prepare("DELETE FROM libraries WHERE id = 'REC'").run();
    expect(getRecordingsLibrary()).toBeNull();
  });

  it("opts the chosen library into audio scan extensions, preserving its own", () => {
    db.prepare("UPDATE libraries SET settings_json = ? WHERE id = 'REC'")
      .run(JSON.stringify({ scan_extensions: ["jpg", "mp4"], default_language: "be" }));
    expect(ensureAudioScanExtensions("REC")).toBe(true);
    const settings = normalizeLibrarySettings(
      "gallery",
      (db.prepare("SELECT settings_json FROM libraries WHERE id = 'REC'").get() as { settings_json: string }).settings_json
    );
    expect(settings.scan_extensions).toEqual(expect.arrayContaining(["jpg", "mp4", "mp3", "weba", "m4a"]));
    // The unrelated key survived the merge.
    expect(settings.default_language).toBe("be");
    expect(ensureAudioScanExtensions("missing")).toBe(false);
  });
});

describe("storing a recording", () => {
  it("refuses without a recordings library", async () => {
    const tmp = stagedUpload();
    await expect(storeRecording(tmp, "recording.webm", "webm")).rejects.toBeInstanceOf(RecordingError);
    fs.rmSync(tmp, { force: true });
  });

  it("lands the file under Story recordings/<year> as a cataloged audio asset", async () => {
    setStoriesSettings({ recordingsLibraryId: "REC" }, "author");
    const stored = await storeRecording(stagedUpload(), "recording.webm", "webm");

    const year = String(new Date().getFullYear());
    // A MediaRecorder .webm capture is stored as .weba — the gallery classes
    // .webm as video.
    const finalPath = path.join(libSource, "Story recordings", year, "recording.weba");
    expect(fs.existsSync(finalPath)).toBe(true);
    expect(recordingExtension("webm")).toBe("weba");
    expect(recordingExtension("m4a")).toBe("m4a");

    const detail = db.prepare("SELECT kind FROM gallery_details WHERE item_id = ?").get(stored.itemId) as { kind: string };
    expect(detail.kind).toBe("audio");
    // "recording" is no title worth showing; the UI falls back.
    expect(stored.title).toBeNull();

    // A second capture with the same browser filename disambiguates.
    await storeRecording(stagedUpload(), "recording.webm", "webm");
    expect(fs.existsSync(path.join(libSource, "Story recordings", year, "recording (2).weba"))).toBe(true);
  });
});

describe("the legacy import", () => {
  it("moves clips into the library, rewrites their blocks, and empties story_audio", async () => {
    setStoriesSettings({ recordingsLibraryId: "REC" }, "author");
    const story = createStory(author, "Minnesota", null);
    const chapterId = getChapters(story.id)[0].id;

    const tmp = stagedUpload();
    const clip = await createStoryAudio(story.id, author, tmp, "grandma-1998.m4a", "m4a");
    db.prepare("INSERT INTO story_blocks (id, chapter_id, position, kind, entity_type, entity_id) VALUES ('b1', ?, 1, 'audio', 'story_audio', ?)")
      .run(chapterId, clip.id);
    const legacyFile = thumbnailAbsolutePath(clip.storage_key);
    expect(pendingLegacyNarrations()).toBe(1);

    const result = await migrateLegacyNarrations("author");
    expect(result).toMatchObject({ moved: 1, failed: 0, remaining: 0 });

    const block = getBlocks(story.id).find((row) => row.id === "b1")!;
    expect(block.entity_type).toBe("gallery");
    const detail = db.prepare("SELECT kind, relative_path FROM gallery_details WHERE item_id = ?")
      .get(block.entity_id) as { kind: string; relative_path: string };
    expect(detail.kind).toBe("audio");
    // Named from the clip's title, filed under the clip's own year.
    expect(detail.relative_path).toBe(`Story recordings/${clip.created_at.slice(0, 4)}/grandma 1998.m4a`);
    expect(fs.existsSync(legacyFile)).toBe(false);
    expect(pendingLegacyNarrations()).toBe(0);
  });

  it("leaves a clip with a missing file in place and counts it", async () => {
    setStoriesSettings({ recordingsLibraryId: "REC" }, "author");
    const story = createStory(author, "Minnesota", null);
    const clip = await createStoryAudio(story.id, author, stagedUpload(), "lost.m4a", "m4a");
    fs.rmSync(thumbnailAbsolutePath(clip.storage_key), { force: true });

    const result = await migrateLegacyNarrations("author");
    expect(result).toMatchObject({ moved: 0, failed: 1, remaining: 1 });
    expect(pendingLegacyNarrations()).toBe(1);
  });
});
