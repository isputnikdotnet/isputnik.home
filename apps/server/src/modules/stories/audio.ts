// Narration for a story — the voice half of it. Every product in this space
// converged on recorded voice (FamilySearch's audio memories, Remento's
// speech-to-story, MyHeritage's Photo Storyteller), and it is the one thing a
// written page can't carry: how someone said it.
//
// Unlike every other story reference, narration is OWNED by the story rather
// than pointed at in the library. It was recorded for this story, so it
// cascades with it, and the file is reclaimed when the block goes.
//
// Files live in the thumbnail store under a 'narration' bucket, the arrangement
// gallery_music_tracks already uses for slideshow beds.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { nanoid } from "nanoid";
import { db } from "../../db.js";
import { thumbnailAbsolutePath, thumbnailStorageKey } from "../library/shared/thumbnail.js";
import { probeDurationSeconds } from "../library/gallery/slideshow-render.js";

/** How a narration block points at its clip. Not a subjects-registry type:
 *  the clip belongs to the story, not to the library. */
export const STORY_AUDIO_ENTITY_TYPE = "story_audio";

// Browser-recordable and commonly-uploaded voice formats. webm/ogg are what
// MediaRecorder produces; the rest are what a phone or a desktop hands over.
export const NARRATION_EXTENSIONS = ["webm", "weba", "ogg", "oga", "opus", "mp3", "m4a", "aac", "wav", "flac"];

/** A spoken passage, not a record collection. */
export const NARRATION_MAX_BYTES = 40 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  webm: "audio/webm", weba: "audio/webm", ogg: "audio/ogg", oga: "audio/ogg",
  opus: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac",
  wav: "audio/wav", flac: "audio/flac"
};

export interface StoryAudioRow {
  id: string;
  story_id: string;
  storage_key: string;
  title: string | null;
  duration_seconds: number | null;
  uploaded_by: string | null;
  created_at: string;
}

export function getStoryAudio(audioId: string): StoryAudioRow | undefined {
  return db.prepare("SELECT * FROM story_audio WHERE id = ?").get(audioId) as StoryAudioRow | undefined;
}

/** Narration for many blocks at once, keyed by clip id. */
export function storyAudioByIds(ids: string[]): Map<string, StoryAudioRow> {
  const out = new Map<string, StoryAudioRow>();
  if (ids.length === 0) return out;
  const rows = db.prepare(
    `SELECT * FROM story_audio WHERE id IN (${ids.map(() => "?").join(", ")})`
  ).all(...ids) as StoryAudioRow[];
  for (const row of rows) out.set(row.id, row);
  return out;
}

export function narrationMime(storageKey: string): string {
  return MIME_BY_EXT[storageKey.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

export function narrationAbsolutePath(row: StoryAudioRow): string {
  return thumbnailAbsolutePath(row.storage_key);
}

export function narrationTempDir(): string {
  return path.join(os.tmpdir(), "isputnik-narration");
}

/** Move a received upload into the narration bucket and record it. */
export async function createStoryAudio(
  storyId: string,
  user: { id: string },
  tmpPath: string,
  filename: string,
  extension: string
): Promise<StoryAudioRow> {
  const id = nanoid(16);
  const key = thumbnailStorageKey("narration", id, `${id}.${extension.toLowerCase()}`);
  const abs = thumbnailAbsolutePath(key);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  try {
    fs.renameSync(tmpPath, abs);
  } catch {
    // Different filesystem — copy and drop the original.
    fs.copyFileSync(tmpPath, abs);
    fs.rmSync(tmpPath, { force: true });
  }
  const duration = await probeDurationSeconds(abs);
  db.prepare(`
    INSERT INTO story_audio (id, story_id, storage_key, title, duration_seconds, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, storyId, key, titleFromFilename(filename), duration, user.id);
  return getStoryAudio(id)!;
}

/** "grandma-1998.m4a" → "grandma 1998". A recording made in the browser has no
 *  name worth showing, so those fall back to null and the UI names them. */
export function titleFromFilename(filename: string): string | null {
  const base = filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  if (!base || /^recording$/i.test(base)) return null;
  return base.slice(0, 120);
}

/** Delete a clip's row and its file. Called when its block goes, and when the
 *  whole story does — the row would cascade, but the file would not. */
export function deleteStoryAudio(audioId: string): void {
  const row = getStoryAudio(audioId);
  if (!row) return;
  try {
    fs.rmSync(thumbnailAbsolutePath(row.storage_key), { force: true });
  } catch {
    /* best-effort: a missing file shouldn't block the delete */
  }
  db.prepare("DELETE FROM story_audio WHERE id = ?").run(audioId);
}

/** Reclaim every clip a story owns. The rows cascade with the story; this is
 *  what stops the files being left behind on disk. */
export function deleteStoryAudioFiles(storyId: string): void {
  const rows = db.prepare("SELECT storage_key FROM story_audio WHERE story_id = ?")
    .all(storyId) as { storage_key: string }[];
  for (const row of rows) {
    try {
      fs.rmSync(thumbnailAbsolutePath(row.storage_key), { force: true });
    } catch {
      /* best-effort */
    }
  }
}

/** Clips no block points at any more — a narration whose block was deleted
 *  some other way. Swept on story delete and by the block delete path. */
export function orphanedStoryAudio(storyId: string): string[] {
  return (db.prepare(`
    SELECT story_audio.id FROM story_audio
    WHERE story_audio.story_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM story_blocks
        JOIN story_chapters ON story_chapters.id = story_blocks.chapter_id
        WHERE story_chapters.story_id = story_audio.story_id
          AND story_blocks.entity_type = '${STORY_AUDIO_ENTITY_TYPE}'
          AND story_blocks.entity_id = story_audio.id
      )
  `).all(storyId) as { id: string }[]).map((row) => row.id);
}
