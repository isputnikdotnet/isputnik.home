// Voice notes on a photo — docs/photo-review-plan.md, phase 4.
//
// Someone going through a box of prints often has more to say than she wants
// to type. A voice note is a recording kept ON the photo: the audio is an
// ordinary asset in the house's "App files" library, under
// Voice notes/<year>, exactly as story narration is kept — so it shows in the
// gallery, rides along in backups and streams like any other file — and a
// gallery_voice_notes row ties it to the photo it is about.
//
// Reach follows the PHOTO, not the audio's library: whoever may see the photo
// may hear its notes (the route streams the file itself), and whoever may
// write on the photo may record or delete one. The helper with contributor on
// the Inbox never needs access to the house library.
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { db, logActivity } from "../../../db.js";
import { validateLibrarySource } from "../shared/library-source.js";
import { normaliseRelativePath } from "../shared/storage-roots.js";
import { trashBook } from "../shared/trash.js";
import { TrashError } from "../shared/trash-settings.js";
import { scanSingleGalleryFile } from "./scanner.js";
import { uniqueGalleryFileName } from "./files.js";
import { getHouseLibrary, HOUSE_FOLDERS } from "./house-library.js";

/** Five minutes at a browser's ~64 kbit/s is a couple of megabytes; this is
 *  headroom, not a target. */
export const VOICE_NOTE_MAX_BYTES = 25 * 1024 * 1024;
export const VOICE_NOTE_EXTENSIONS = ["webm", "weba", "ogg", "oga", "opus", "m4a", "mp3", "wav"];

const MIME_BY_EXT: Record<string, string> = {
  weba: "audio/webm", webm: "audio/webm", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg",
  m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav"
};

export interface VoiceNoteView {
  id: string;
  /** Streams through the photo, so the listener needs the photo, not the library. */
  url: string;
  durationSeconds: number | null;
  recordedBy: string | null;
  createdAt: string;
}

export class VoiceNoteError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

const listStmt = db.prepare(`
  SELECT n.id, n.created_at, gd.duration_seconds, users.display_name AS recorded_by
  FROM gallery_voice_notes n
  JOIN library_items audio ON audio.id = n.audio_item_id AND audio.deleted_at IS NULL
  LEFT JOIN gallery_details gd ON gd.item_id = n.audio_item_id
  LEFT JOIN users ON users.id = n.recorded_by
  WHERE n.item_id = ?
  ORDER BY n.created_at ASC
`);

export function listVoiceNotes(itemId: string): VoiceNoteView[] {
  const rows = listStmt.all(itemId) as { id: string; created_at: string; duration_seconds: number | null; recorded_by: string | null }[];
  return rows.map((row) => ({
    id: row.id,
    url: `/api/library/gallery/assets/${itemId}/voice-notes/${row.id}/audio`,
    durationSeconds: row.duration_seconds,
    recordedBy: row.recorded_by,
    createdAt: row.created_at
  }));
}

/** MediaRecorder captures arrive as .webm; the gallery classifies .webm as
 *  video, so audio-in-webm is stored as .weba (as narration is). */
function storedExtension(extension: string): string {
  const ext = extension.toLowerCase();
  return ext === "webm" ? "weba" : ext;
}

/** Move a received recording into the house library under Voice notes/<year>,
 *  catalog it, and tie it to the photo. The caller has checked the write right
 *  on the PHOTO; the house library takes the file on the admin's standing
 *  nomination, as it does for narration. */
export async function storeVoiceNote(itemId: string, userId: string, tmpPath: string, extension: string): Promise<VoiceNoteView> {
  const photo = db.prepare(`
    SELECT library_items.id, COALESCE(item_metadata.title, library_items.folder_path) AS title
    FROM library_items LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
    WHERE library_items.id = ? AND library_items.type = 'gallery' AND library_items.deleted_at IS NULL
  `).get(itemId) as { id: string; title: string } | undefined;
  if (!photo) throw new VoiceNoteError("Photo not found.", 404);

  const library = getHouseLibrary();
  if (!library) {
    throw new VoiceNoteError("No \"App files\" library is set. An admin chooses one under Control → Library → Storage.", 409);
  }
  const root = validateLibrarySource(library.source_path);
  const ext = storedExtension(extension);
  if (!VOICE_NOTE_EXTENSIONS.includes(ext)) throw new VoiceNoteError("That is not a recording the gallery can keep.", 415);

  const dir = path.join(root, HOUSE_FOLDERS.voiceNotes, String(new Date().getFullYear()));
  fs.mkdirSync(dir, { recursive: true });
  // Named after the photo so the folder reads: "scan 001 - voice note.weba".
  const stem = (photo.title.split("/").pop() ?? photo.title).replace(/\.[^.]+$/, "").replace(/[<>:"/\\|?*]/g, "").trim() || "Photo";
  const unique = uniqueGalleryFileName(dir, `${stem} - voice note.${ext}`) ?? `Voice note ${Date.now()}.${ext}`;
  const finalPath = path.join(dir, unique);
  try {
    fs.renameSync(tmpPath, finalPath);
  } catch {
    fs.copyFileSync(tmpPath, finalPath);
    fs.rmSync(tmpPath, { force: true });
  }

  const relativePath = normaliseRelativePath(path.relative(root, finalPath));
  const audioItemId = await scanSingleGalleryFile(library.id, relativePath);
  if (!audioItemId) {
    fs.rmSync(finalPath, { force: true });
    throw new VoiceNoteError("The recording could not be cataloged.", 500);
  }

  const id = nanoid(16);
  db.prepare("INSERT INTO gallery_voice_notes (id, item_id, audio_item_id, recorded_by) VALUES (?, ?, ?, ?)")
    .run(id, itemId, audioItemId, userId);
  logActivity({
    event: "library.gallery.voice_note",
    actorUserId: userId,
    targetType: "library_item",
    targetId: itemId,
    detail: `Recorded a voice note on "${photo.title}".`
  });
  return listVoiceNotes(itemId).find((note) => note.id === id)!;
}

/** The file behind a note, for streaming — null when the note is not on this photo. */
export function voiceNoteFile(itemId: string, noteId: string): { path: string; mime: string } | null {
  const row = db.prepare(`
    SELECT libraries.source_path, gd.relative_path
    FROM gallery_voice_notes n
    JOIN library_items audio ON audio.id = n.audio_item_id AND audio.deleted_at IS NULL
    JOIN libraries ON libraries.id = audio.library_id
    JOIN gallery_details gd ON gd.item_id = audio.id
    WHERE n.id = ? AND n.item_id = ?
  `).get(noteId, itemId) as { source_path: string; relative_path: string } | undefined;
  if (!row) return null;
  let root: string;
  try { root = validateLibrarySource(row.source_path); } catch { return null; }
  const ext = row.relative_path.split(".").pop()?.toLowerCase() ?? "";
  return { path: path.join(root, ...row.relative_path.split("/")), mime: MIME_BY_EXT[ext] ?? "application/octet-stream" };
}

/** Remove a note: the tie goes, and the recording goes to the Recycle Bin like
 *  any deleted asset. Returns false when the note is not on this photo. */
export function deleteVoiceNote(itemId: string, noteId: string, userId: string): boolean {
  const row = db.prepare("SELECT audio_item_id FROM gallery_voice_notes WHERE id = ? AND item_id = ?").get(noteId, itemId) as { audio_item_id: string } | undefined;
  if (!row) return false;
  db.prepare("DELETE FROM gallery_voice_notes WHERE id = ?").run(noteId);
  try {
    trashBook(row.audio_item_id, userId);
  } catch (err) {
    // A recording already gone (or bin-locked) leaves the tie removed anyway.
    if (!(err instanceof TrashError)) throw err;
  }
  return true;
}
