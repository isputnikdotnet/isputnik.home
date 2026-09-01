// Narration recordings, stored as LIBRARY CONTENT — the v2 rule ("stories
// reference, period", docs/stories-v2-proposal.md). A clip recorded or uploaded
// in the story editor lands in the admin-nominated recordings library as a
// normal gallery audio asset, and the block references it like any other
// library content. That is what makes recordings survive story deletion,
// appear in the gallery timeline, get backed up, and stream through the
// token-scoped guest routes.
//
// This file also owns the one-time import that moves the LEGACY story-owned
// clips (story_audio, the v1 model) into the recordings library. The legacy
// read paths in audio.ts keep serving until that import has run everywhere;
// only then does audio.ts get deleted.
import fs from "node:fs";
import path from "node:path";
import { db, logActivity } from "../../db.js";
import { validateLibrarySource } from "../library/shared/library-source.js";
import { normaliseRelativePath } from "../library/shared/storage-roots.js";
import { scanSingleGalleryFile } from "../library/gallery/scanner.js";
import { uniqueGalleryFileName } from "../library/gallery/routes.js";
import { getRecordingsLibrary, type RecordingsLibrary } from "./settings.js";
import { narrationAbsolutePath, titleFromFilename, type StoryAudioRow } from "./audio.js";

/** Where recordings live inside the library, grouped by year so the folder
 *  view stays navigable. The space is fine — it's a display name on disk. */
const RECORDINGS_FOLDER = "Story recordings";

/** MediaRecorder captures arrive as .webm/.ogg; the gallery classifies .webm
 *  as VIDEO (a camera clip is the likelier owner), so audio-in-webm is stored
 *  as .weba. Everything else passes through unchanged. */
export function recordingExtension(extension: string): string {
  const ext = extension.toLowerCase();
  return ext === "webm" ? "weba" : ext;
}

export interface StoredRecording {
  itemId: string;
  title: string | null;
  durationSeconds: number | null;
}

export class RecordingError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** Move a received narration file into the recordings library and catalog it.
 *
 *  Deliberately NO per-user upload-permission check on that library: the
 *  author is authorized by their edit rights on the story, and the admin's act
 *  of nominating the library is the standing grant. The write is narrow — an
 *  audio file, size-capped upstream, into the recordings folder — nothing like
 *  a general upload right. */
export async function storeRecording(tmpPath: string, filename: string, extension: string): Promise<StoredRecording> {
  const library = getRecordingsLibrary();
  if (!library) {
    throw new RecordingError("No recordings library is set. An admin chooses one under Control → Settings → Stories.", 409);
  }
  const root = validateLibrarySource(library.source_path);
  const ext = recordingExtension(extension);

  const year = new Date().getFullYear();
  const dir = path.join(root, RECORDINGS_FOLDER, String(year));
  fs.mkdirSync(dir, { recursive: true });

  const stem = filename.replace(/\.[^.]+$/, "");
  const unique = uniqueGalleryFileName(dir, `${stem || "Recording"}.${ext}`) ?? `Recording-${Date.now()}.${ext}`;
  const finalPath = path.join(dir, unique);
  try {
    fs.renameSync(tmpPath, finalPath);
  } catch {
    // Temp dir on another filesystem — copy and drop the original.
    fs.copyFileSync(tmpPath, finalPath);
    fs.rmSync(tmpPath, { force: true });
  }

  const relativePath = normaliseRelativePath(path.relative(root, finalPath));
  const itemId = await scanSingleGalleryFile(library.id, relativePath);
  if (!itemId) {
    fs.rmSync(finalPath, { force: true });
    throw new RecordingError("The recording could not be cataloged.", 500);
  }

  const row = db.prepare(`
    SELECT item_metadata.title, gallery_details.duration_seconds
    FROM gallery_details
    LEFT JOIN item_metadata ON item_metadata.item_id = gallery_details.item_id
    WHERE gallery_details.item_id = ?
  `).get(itemId) as { title: string | null; duration_seconds: number | null } | undefined;
  return {
    itemId,
    // The scanner titles an asset by its filename; a browser capture is named
    // "recording.weba", which reads as nothing — the UI falls back then.
    title: titleFromFilename(row?.title ?? unique),
    durationSeconds: row?.duration_seconds ?? null
  };
}

/** One-time import of the legacy story-owned clips into the recordings
 *  library: file moved in and cataloged, every block pointing at the clip
 *  rewritten to the gallery item, then the clip row and file removed. A clip
 *  that fails (missing file, uncatalogable) is left in place and counted, so
 *  the action is safe to re-run. Orphaned clips (no block) are imported too —
 *  the recording is family content either way. */
export async function migrateLegacyNarrations(actorUserId: string | null): Promise<{ moved: number; failed: number; remaining: number }> {
  const library = getRecordingsLibrary();
  if (!library) throw new RecordingError("No recordings library is set.", 409);
  const root = validateLibrarySource(library.source_path);

  const clips = db.prepare("SELECT * FROM story_audio ORDER BY created_at").all() as StoryAudioRow[];
  let moved = 0;
  let failed = 0;

  for (const clip of clips) {
    try {
      const src = narrationAbsolutePath(clip);
      if (!fs.existsSync(src)) { failed += 1; continue; }
      const ext = recordingExtension(clip.storage_key.split(".").pop() ?? "weba");
      const year = clip.created_at.slice(0, 4) || String(new Date().getFullYear());
      const dir = path.join(root, RECORDINGS_FOLDER, year);
      fs.mkdirSync(dir, { recursive: true });
      const unique = uniqueGalleryFileName(dir, `${clip.title || "Narration"}.${ext}`) ?? `${clip.id}.${ext}`;
      const finalPath = path.join(dir, unique);
      // Copy, not rename: the thumbnail store may be another filesystem, and a
      // failure after the copy must leave the legacy clip fully intact.
      fs.copyFileSync(src, finalPath);

      const relativePath = normaliseRelativePath(path.relative(root, finalPath));
      const itemId = await scanSingleGalleryFile(library.id, relativePath);
      if (!itemId) {
        fs.rmSync(finalPath, { force: true });
        failed += 1;
        continue;
      }

      db.transaction(() => {
        db.prepare(`
          UPDATE story_blocks SET entity_type = 'gallery', entity_id = ?
          WHERE entity_type = 'story_audio' AND entity_id = ?
        `).run(itemId, clip.id);
        db.prepare("DELETE FROM story_audio WHERE id = ?").run(clip.id);
      })();
      fs.rmSync(src, { force: true });
      moved += 1;
    } catch {
      failed += 1;
    }
  }

  const remaining = (db.prepare("SELECT COUNT(*) n FROM story_audio").get() as { n: number }).n;
  if (moved > 0 || failed > 0) {
    logActivity({
      event: "story.narrations_migrated",
      actorUserId,
      targetType: "library",
      targetId: library.id,
      detail: `Moved ${moved} narration${moved === 1 ? "" : "s"} into "${library.name}"${failed > 0 ? `; ${failed} failed` : ""}.`,
      ipAddress: null
    });
  }
  return { moved, failed, remaining };
}

/** Legacy clips still waiting for the import — drives the admin page's badge. */
export function pendingLegacyNarrations(): number {
  return (db.prepare("SELECT COUNT(*) n FROM story_audio").get() as { n: number }).n;
}

export type { RecordingsLibrary };
