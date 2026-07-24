// Gallery slideshow music: USER UPLOADS only (see docs/gallery-slideshows-proposal.md,
// Phase 2). Tracks live in one table (gallery_music_tracks) and one storage location —
// the configured thumbnail store's shared "music" bucket (like the "people"/"categories"
// buckets), resolved through thumbnailAbsolutePath so the same path-safety rules apply.
// Uploads are streamed in via the shared upload primitive. (Earlier versions also
// synthesised built-in ambient beds; those were retired — see removeBuiltinMusic.)
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { parseFile } from "music-metadata";
import { db } from "../../../db.js";
import { thumbnailAbsolutePath, thumbnailStorageKey } from "../shared/thumbnail.js";

export interface MusicTrackRow {
  id: string;
  title: string;
  artist: string | null;
  builtin: number;
  storage_key: string;
  duration_seconds: number | null;
  uploaded_by: string | null;
  created_at: string;
}

const MIME_BY_EXT: Record<string, string> = {
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".aac": "audio/aac",
  ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav",
  ".flac": "audio/flac", ".weba": "audio/webm", ".webm": "audio/webm"
};
export const MUSIC_UPLOAD_EXTENSIONS = ["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac", "weba", "webm"];
export const MUSIC_MAX_BYTES = 25 * 1024 * 1024; // a slideshow bed, not an album

export function musicMimeForKey(storageKey: string): string {
  return MIME_BY_EXT[path.extname(storageKey).toLowerCase()] ?? "application/octet-stream";
}

export function getMusicTrack(id: string): MusicTrackRow | undefined {
  return db.prepare("SELECT * FROM gallery_music_tracks WHERE id = ?").get(id) as MusicTrackRow | undefined;
}

export function musicFileAbsolutePath(track: MusicTrackRow): string {
  return thumbnailAbsolutePath(track.storage_key);
}

// Client shape. `url` is the streaming endpoint; the picker and the live-preview
// <audio> both use it. Kept in one place so every response agrees.
export function summarizeTrack(row: MusicTrackRow) {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    builtin: row.builtin === 1,
    durationSeconds: row.duration_seconds,
    url: `/api/library/gallery/music/${row.id}/stream`,
    uploadedBy: row.uploaded_by
  };
}

export function listMusicTracks() {
  const rows = db.prepare(
    "SELECT * FROM gallery_music_tracks ORDER BY builtin DESC, datetime(created_at) DESC, title ASC"
  ).all() as MusicTrackRow[];
  return rows.map(summarizeTrack);
}

async function probeDurationSeconds(absPath: string): Promise<number | null> {
  try {
    const meta = await parseFile(absPath);
    const d = meta.format.duration;
    return typeof d === "number" && Number.isFinite(d) ? Math.round(d * 100) / 100 : null;
  } catch {
    return null;
  }
}

function titleFromFilename(filename: string): string {
  const base = path.basename(filename, path.extname(filename)).trim();
  return (base || "Untitled track").slice(0, 120);
}

// Move a received upload temp file into the music bucket and record it. The temp file
// is expected to already live under the thumbnail store (same filesystem) so the
// rename can't fail with EXDEV; a copy+unlink is the cross-device fallback anyway.
export async function createUserTrack(
  user: { id: string },
  tmpPath: string,
  filename: string,
  extension: string
): Promise<ReturnType<typeof summarizeTrack>> {
  const id = nanoid(16);
  const key = thumbnailStorageKey("music", id, `${id}.${extension.toLowerCase()}`);
  const abs = thumbnailAbsolutePath(key);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  try {
    fs.renameSync(tmpPath, abs);
  } catch {
    fs.copyFileSync(tmpPath, abs);
    fs.rmSync(tmpPath, { force: true });
  }
  const duration = await probeDurationSeconds(abs);
  db.prepare(
    "INSERT INTO gallery_music_tracks (id, title, artist, builtin, storage_key, duration_seconds, uploaded_by) VALUES (?, ?, NULL, 0, ?, ?, ?)"
  ).run(id, titleFromFilename(filename), key, duration, user.id);
  return summarizeTrack(getMusicTrack(id)!);
}

export type DeleteMusicResult = "ok" | "notfound" | "builtin" | "forbidden";

// Delete a user track (its file + row). Built-in beds can't be deleted; a user track
// is deletable by its uploader or an admin. Slideshows referencing it degrade to
// silent via the FK's ON DELETE SET NULL.
export function deleteMusicTrack(id: string, user: { id: string; role: string }): DeleteMusicResult {
  const row = getMusicTrack(id);
  if (!row) return "notfound";
  if (row.builtin === 1) return "builtin";
  if (user.role !== "admin" && row.uploaded_by !== user.id) return "forbidden";
  try { fs.rmSync(thumbnailAbsolutePath(row.storage_key), { force: true }); } catch { /* best-effort */ }
  db.prepare("DELETE FROM gallery_music_tracks WHERE id = ?").run(id);
  return "ok";
}

// ── Retired built-in beds ───────────────────────────────────────────────────

// Slideshows use only user-uploaded music now. Earlier versions synthesised a set
// of built-in ambient beds (rows with builtin = 1); purge any a prior version left
// behind — row + file. Slideshows that pointed at a bed degrade to silent via the
// FK's ON DELETE SET NULL. Idempotent and best-effort (safe to call on every boot).
export function removeBuiltinMusic(): void {
  const rows = db.prepare("SELECT * FROM gallery_music_tracks WHERE builtin = 1").all() as MusicTrackRow[];
  for (const row of rows) {
    try { fs.rmSync(thumbnailAbsolutePath(row.storage_key), { force: true }); } catch { /* store maybe unconfigured */ }
  }
  db.prepare("DELETE FROM gallery_music_tracks WHERE builtin = 1").run();
}

// The music-bucket directory (created lazily) — used as the upload temp dir so the
// received file lands on the same filesystem as its final home (no cross-device
// rename). Safe because thumbnailAbsolutePath validates the key stays under the root.
export function musicTempDir(): string {
  const dir = thumbnailAbsolutePath("music");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
