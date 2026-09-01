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

// LEGACY narration: story-owned clips (v1). No new clips can be created from
// the routes any more — recordings land in the recordings library (see
// stories-recordings.test.ts) — but existing rows keep serving until the
// one-time import moves them, and these hold that read/reclaim path: the FILE,
// which no foreign key will clean up.

const author = { id: "author", role: "member" };
let storyId = "";
let chapterId = "";
let store = "";

/** A legacy audio block, as v1 wrote it. createBlock stamps 'gallery' now, so
 *  the pre-import shape has to be inserted the way an old database holds it. */
function legacyAudioBlock(entityId: string): { id: string } {
  const id = `blk-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    "INSERT INTO story_blocks (id, chapter_id, position, kind, entity_type, entity_id) VALUES (?, ?, 99, 'audio', 'story_audio', ?)"
  ).run(id, chapterId, entityId);
  return { id };
}

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

  it("takes the clip and its file when the legacy narration block goes", async () => {
    const clip = await addClip();
    const block = legacyAudioBlock(clip.id);
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
    legacyAudioBlock(kept.id);
    const doomed = legacyAudioBlock(going.id);

    deleteBlock(doomed.id, storyId);
    expect(getStoryAudio(kept.id)).toBeDefined();
    expect(fs.existsSync(thumbnailAbsolutePath(kept.storage_key))).toBe(true);
  });

  it("never reclaims a gallery-backed recording with its block", () => {
    // A v2 audio block references library content; deleting the block must not
    // touch anything beyond the block row itself.
    const block = createBlock(chapterId, storyId, "audio", { entityId: "some-gallery-item" });
    expect(block.entity_type).toBe("gallery");
    expect(deleteBlock(block.id, storyId)).toBe(true);
    expect(getBlocks(storyId)).toHaveLength(0);
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
    legacyAudioBlock(used.id);
    expect(orphanedStoryAudio(storyId)).toEqual([loose.id]);
  });
});

describe("the block reference", () => {
  it("stamps new audio blocks as gallery references (the v2 model)", () => {
    const block = createBlock(chapterId, storyId, "audio", { entityId: "a1" });
    expect(block.entity_type).toBe("gallery");
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
