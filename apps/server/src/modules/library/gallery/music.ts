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
import { db, logActivity } from "../../../db.js";
import { uploadStagingDir } from "../../../core/app-storage.js";
import { thumbnailAbsolutePath, thumbnailStorageKey } from "../shared/thumbnail.js";
import { validateLibrarySource } from "../shared/library-source.js";
import { normaliseRelativePath } from "../shared/storage-roots.js";
import { trashBook } from "../shared/trash.js";
import { getHouseLibrary, HOUSE_FOLDERS } from "./house-library.js";
import { scanSingleGalleryFile } from "./scanner.js";
import { uniqueGalleryFileName } from "./files.js";
import type { GalleryDetailRow, GalleryMusicTrackRow, LibraryRow } from "../../../db/rows.js";

// Since docs/app-storage-plan.md phase 3 a track is, wherever possible, an audio
// asset of the App files library under "Slideshow music/": visible in the
// gallery, shareable, backed up with the rest. `item_id` names that asset and
// `storage_key` is then "". Tracks uploaded before a house library existed keep
// their bucket file until the importer below carries them across.

export type MusicTrackRow = GalleryMusicTrackRow;

const MIME_BY_EXT: Record<string, string> = {
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".aac": "audio/aac",
  ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav",
  ".flac": "audio/flac", ".weba": "audio/webm", ".webm": "audio/webm"
};
export const MUSIC_UPLOAD_EXTENSIONS = ["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac", "weba", "webm"];
export const MUSIC_MAX_BYTES = 25 * 1024 * 1024; // a slideshow bed, not an album
// Bounds one multi-select. A slideshow needs one track; this is generous for
// "add my whole beds folder" without letting a single request run away.
export const MUSIC_MAX_UPLOAD_FILES = 20;

export function musicMimeForKey(storageKey: string): string {
  return MIME_BY_EXT[path.extname(storageKey).toLowerCase()] ?? "application/octet-stream";
}

export function getMusicTrack(id: string): MusicTrackRow | undefined {
  return db.prepare("SELECT * FROM gallery_music_tracks WHERE id = ?").get(id) as MusicTrackRow | undefined;
}

/** Where the track's file is: the library asset when it is one, else the bucket.
 *  Throws when a library track's asset or library is gone. */
export function musicFileAbsolutePath(track: MusicTrackRow): string {
  if (!track.item_id) return thumbnailAbsolutePath(track.storage_key);
  const row = db.prepare(`
    SELECT libraries.source_path, gd.relative_path
    FROM library_items
    JOIN libraries ON libraries.id = library_items.library_id
    JOIN gallery_details gd ON gd.item_id = library_items.id
    WHERE library_items.id = ? AND library_items.deleted_at IS NULL
  `).get(track.item_id) as (Pick<LibraryRow, "source_path"> & Pick<GalleryDetailRow, "relative_path">) | undefined;
  if (!row) throw new Error("The track's audio is no longer in its library.");
  const root = validateLibrarySource(row.source_path);
  return path.join(root, ...row.relative_path.split("/"));
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
    uploadedBy: row.uploaded_by,
    /** True when the track is an asset of the App files library. */
    inLibrary: row.item_id !== null,
    itemId: row.item_id
  };
}

export function listMusicTracks() {
  const rows = db.prepare(
    "SELECT * FROM gallery_music_tracks ORDER BY builtin DESC, created_at DESC, title ASC"
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

// The name a track is listed under: the filename with its extension dropped. Two
// uploads that reduce to the same title are the same track as far as anyone using
// the picker is concerned, which is what makes this the right thing to dedupe on.
export function titleFromFilename(filename: string): string {
  const base = path.basename(filename, path.extname(filename)).trim();
  return (base || "Untitled track").slice(0, 120);
}

/** Whether a track of this title is already here. Case-insensitive: "Beach Day"
 *  and "beach day" are the same track to read, so they are the same to store. */
export function musicTitleExists(title: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM gallery_music_tracks WHERE title = ? COLLATE NOCASE").get(title)
  );
}

function moveInto(tmpPath: string, finalPath: string): void {
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  try {
    fs.renameSync(tmpPath, finalPath);
  } catch {
    fs.copyFileSync(tmpPath, finalPath);
    fs.rmSync(tmpPath, { force: true });
  }
}

/** Put a file into the house library's "Slideshow music/" folder and catalog it.
 *  Returns the asset id, or null when there is no house library or the file
 *  could not be cataloged (in which case it is left where it was). */
async function landInHouseLibrary(sourcePath: string, title: string, extension: string, copy: boolean): Promise<string | null> {
  const library = getHouseLibrary();
  if (!library) return null;
  let root: string;
  try { root = validateLibrarySource(library.source_path); } catch { return null; }
  const dir = path.join(root, HOUSE_FOLDERS.music);
  fs.mkdirSync(dir, { recursive: true });
  const unique = uniqueGalleryFileName(dir, `${title}.${extension.toLowerCase()}`) ?? `${nanoid(8)}.${extension.toLowerCase()}`;
  const finalPath = path.join(dir, unique);
  if (copy) fs.copyFileSync(sourcePath, finalPath);
  else moveInto(sourcePath, finalPath);
  const itemId = await scanSingleGalleryFile(library.id, normaliseRelativePath(path.relative(root, finalPath)));
  if (!itemId) {
    // Undo: the file goes back where it came from so nothing is lost.
    if (copy) fs.rmSync(finalPath, { force: true });
    else moveInto(finalPath, sourcePath);
    return null;
  }
  return itemId;
}

// Record a received upload: into the App files library when there is one
// (the file becomes an audio asset there), else into the music bucket as before.
export async function createUserTrack(
  user: { id: string },
  tmpPath: string,
  filename: string,
  extension: string
): Promise<ReturnType<typeof summarizeTrack>> {
  const id = nanoid(16);
  const title = titleFromFilename(filename);
  const itemId = await landInHouseLibrary(tmpPath, title, extension, false);
  if (itemId) {
    const detail = db.prepare("SELECT duration_seconds FROM gallery_details WHERE item_id = ?").get(itemId) as Pick<GalleryDetailRow, "duration_seconds"> | undefined;
    db.prepare(
      "INSERT INTO gallery_music_tracks (id, title, artist, builtin, storage_key, duration_seconds, uploaded_by, item_id) VALUES (?, ?, NULL, 0, '', ?, ?, ?)"
    ).run(id, title, detail?.duration_seconds ?? null, user.id, itemId);
    return summarizeTrack(getMusicTrack(id)!);
  }

  const key = thumbnailStorageKey("music", id, `${id}.${extension.toLowerCase()}`);
  const abs = thumbnailAbsolutePath(key);
  moveInto(tmpPath, abs);
  const duration = await probeDurationSeconds(abs);
  db.prepare(
    "INSERT INTO gallery_music_tracks (id, title, artist, builtin, storage_key, duration_seconds, uploaded_by) VALUES (?, ?, NULL, 0, ?, ?, ?)"
  ).run(id, title, key, duration, user.id);
  return summarizeTrack(getMusicTrack(id)!);
}

/** Remove `dir` and every folder under it that holds nothing; folders with files stay. */
function pruneEmptyDirs(dir: string): boolean {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  let empty = true;
  for (const entry of entries) {
    if (entry.isDirectory() && pruneEmptyDirs(path.join(dir, entry.name))) continue;
    empty = false;
  }
  if (empty) { try { fs.rmdirSync(dir); } catch { return false; } }
  return empty;
}

/** Tracks still kept as bucket files although a house library now exists. */
export function pendingBucketMusic(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM gallery_music_tracks WHERE builtin = 0 AND item_id IS NULL").get() as { n: number }).n;
}

/** Carry bucket tracks into the App files library once one exists: copy,
 *  catalog, point the row at the asset, then drop the bucket file. A track whose
 *  file is missing or will not catalog stays as it is and is counted. Runs from
 *  the gallery plugin's timer; null when there is nothing to do or nowhere to go. */
export async function importBucketMusicIfDue(): Promise<{ moved: number; failed: number } | null> {
  if (pendingBucketMusic() === 0 || !getHouseLibrary()) return null;
  const rows = db.prepare("SELECT * FROM gallery_music_tracks WHERE builtin = 0 AND item_id IS NULL ORDER BY created_at").all() as MusicTrackRow[];
  let moved = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const abs = thumbnailAbsolutePath(row.storage_key);
      if (!fs.existsSync(abs)) { failed += 1; continue; }
      const itemId = await landInHouseLibrary(abs, row.title, path.extname(row.storage_key).slice(1) || "mp3", true);
      if (!itemId) { failed += 1; continue; }
      db.prepare("UPDATE gallery_music_tracks SET item_id = ?, storage_key = '' WHERE id = ?").run(itemId, row.id);
      fs.rmSync(abs, { force: true });
      moved += 1;
    } catch {
      failed += 1;
    }
  }
  if (moved > 0) {
    // The emptied shard folders go too, or the bucket keeps "holding files" as far
    // as the Storage page's lock is concerned.
    try { pruneEmptyDirs(thumbnailAbsolutePath("music")); } catch { /* best-effort */ }
    const library = getHouseLibrary();
    logActivity({
      event: "gallery.music.imported",
      actorUserId: null,
      targetType: "library",
      targetId: library?.id ?? null,
      detail: `Moved ${moved} slideshow music track${moved === 1 ? "" : "s"} into "${library?.name ?? "the library"}"${failed > 0 ? `; ${failed} could not be moved` : ""}.`,
      ipAddress: null
    });
  }
  return { moved, failed };
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
  if (row.item_id) {
    // A library track is a gallery asset: it goes to the Recycle Bin like any
    // other, and the row goes with the asset (ON DELETE CASCADE). Throws a
    // TrashError when the library refuses.
    trashBook(row.item_id, user.id, { source: "manual" });
    db.prepare("DELETE FROM gallery_music_tracks WHERE id = ?").run(id);
    return "ok";
  }
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

// Where an upload waits: App storage's staging folder when there is one, else the
// system temp folder. Landing renames when it can and copies across volumes when
// it cannot.
export function musicTempDir(): string {
  return uploadStagingDir();
}
