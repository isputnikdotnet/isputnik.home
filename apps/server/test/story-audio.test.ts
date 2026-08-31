import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { db } from "../src/db.js";
import { thumbnailAbsolutePath, thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import {
  createStoryAudio,
  getStoryAudio,
  deleteStoryAudio,
  deleteStoryAudioFiles,
  orphanedStoryAudio,
  titleFromFilename,
  narrationMime
} from "../src/modules/stories/audio.js";
import {
  createStory,
  createBlock,
  deleteBlock,
  getBlocks,
  getChapters
} from "../src/modules/stories/stories.js";
import { resetDb, makeUser } from "./helpers/seed.js";

// Narration is the one story reference the story OWNS. These hold the part that
// is easy to get wrong: the FILE, which no foreign key will clean up.

const author = { id: "author", role: "member" };
let storyId = "";
let chapterId = "";
let store = "";

/** A stand-in upload: the routes hand createStoryAudio a temp file to move. */
async function addClip(filename = "grandma-1998.m4a") {
  const tmp = path.join(os.tmpdir(), `narration-test-${Math.random().toString(36).slice(2)}.m4a`);
  fs.writeFileSync(tmp, "not really audio, but a real file");
  return createStoryAudio(storyId, author, tmp, filename, "m4a");
}

beforeEach(() => {
  resetDb();
  makeUser("author");
  // Narration files land in the thumbnail store, like slideshow music beds.
  store = fs.mkdtempSync(path.join(os.tmpdir(), "narration-store-"));
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(thumbnailPathSettingKey, store);
  const story = createStory(author, "Minnesota", null);
  storyId = story.id;
  chapterId = getChapters(storyId)[0].id;
});

afterEach(() => {
  db.prepare("DELETE FROM app_settings WHERE key = ?").run(thumbnailPathSettingKey);
  try { fs.rmSync(store, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("storing narration", () => {
  it("moves the upload into the store and records it", async () => {
    const clip = await addClip();
    expect(getStoryAudio(clip.id)).toBeDefined();
    expect(fs.existsSync(thumbnailAbsolutePath(clip.storage_key))).toBe(true);
    expect(clip.story_id).toBe(storyId);
  });

  it("names a clip from its filename, but not a browser recording", async () => {
    expect(titleFromFilename("grandma-1998.m4a")).toBe("grandma 1998");
    // MediaRecorder output is always "recording.webm" — no name worth showing.
    expect(titleFromFilename("recording.webm")).toBeNull();
  });

  it("serves the right content type for what was uploaded", () => {
    expect(narrationMime("narration/x/y.webm")).toBe("audio/webm");
    expect(narrationMime("narration/x/y.m4a")).toBe("audio/mp4");
    expect(narrationMime("narration/x/y.zzz")).toBe("application/octet-stream");
  });
});

describe("reclaiming the file", () => {
  it("deletes the file with the clip", async () => {
    const clip = await addClip();
    const file = thumbnailAbsolutePath(clip.storage_key);
    deleteStoryAudio(clip.id);
    expect(getStoryAudio(clip.id)).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("takes the clip and its file when the narration block goes", async () => {
    const clip = await addClip();
    const block = createBlock(chapterId, storyId, "audio", { entityId: clip.id });
    const file = thumbnailAbsolutePath(clip.storage_key);

    expect(deleteBlock(block.id, storyId)).toBe(true);
    expect(getBlocks(storyId)).toHaveLength(0);
    // The row would linger and the file with it, since story_audio only
    // cascades from the STORY, never from a block.
    expect(getStoryAudio(clip.id)).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("leaves other blocks' clips alone", async () => {
    const kept = await addClip("kept.m4a");
    const going = await addClip("going.m4a");
    createBlock(chapterId, storyId, "audio", { entityId: kept.id });
    const doomed = createBlock(chapterId, storyId, "audio", { entityId: going.id });

    deleteBlock(doomed.id, storyId);
    expect(getStoryAudio(kept.id)).toBeDefined();
    expect(fs.existsSync(thumbnailAbsolutePath(kept.storage_key))).toBe(true);
  });

  it("reclaims every file a story owns", async () => {
    const one = await addClip("one.m4a");
    const two = await addClip("two.m4a");
    deleteStoryAudioFiles(storyId);
    expect(fs.existsSync(thumbnailAbsolutePath(one.storage_key))).toBe(false);
    expect(fs.existsSync(thumbnailAbsolutePath(two.storage_key))).toBe(false);
  });

  it("finds a clip no block points at any more", async () => {
    const used = await addClip("used.m4a");
    const loose = await addClip("loose.m4a");
    createBlock(chapterId, storyId, "audio", { entityId: used.id });
    expect(orphanedStoryAudio(storyId)).toEqual([loose.id]);
  });
});

describe("the block reference", () => {
  it("stamps the story_audio namespace, not a subjects type", () => {
    const block = createBlock(chapterId, storyId, "audio", { entityId: "a1" });
    expect(block.entity_type).toBe("story_audio");
    expect(block.entity_id).toBe("a1");
  });

  it("keeps a clip bound to its own story", async () => {
    const mine = await addClip();
    const other = createStory(author, "Another story", null);
    // The route's reachability check is "does this clip belong to THIS story";
    // the data makes that answerable.
    expect(getStoryAudio(mine.id)?.story_id).toBe(storyId);
    expect(getStoryAudio(mine.id)?.story_id).not.toBe(other.id);
  });

  it("cascades the rows when the story goes", async () => {
    await addClip();
    db.prepare("DELETE FROM stories WHERE id = ?").run(storyId);
    expect(db.prepare("SELECT COUNT(*) AS n FROM story_audio").get()).toEqual({ n: 0 });
  });
});
