// Live Photos (docs/photo-sync-plan.md, phase 5; Gallery gaps): an iPhone keeps a
// still and a ~3-second clip for each Live Photo and sends them as two files with
// the same name — `IMG_1234.HEIC` + `IMG_1234.MOV`. They are ONE photo: the still is
// the item, the clip is its motion (gallery_details.motion_*), played in the
// lightbox; the clip is never an item of its own, in any gallery library.
//
// The rule, in every gallery library:
//   • same folder, same name apart from the extension (case ignored);
//   • the still is .heic/.heif/.jpg/.jpeg, the clip is .mov (Apple's container);
//   • the clip is short (MAX_MOTION_SECONDS) and small (MAX_MOTION_BYTES) — a camera
//     that names its ordinary videos IMG_1234.MOV too must not lose them;
//   • and where both carry Apple's content identifier (the still in its MakerNote,
//     tag 0x0011; the clip as com.apple.quicktime.content.identifier) they agree.
//     One missing (an exported or re-saved copy) is no objection.
//
// A pair on record whose clip has not changed (path, size, mtime) is taken as it
// stands, so a rescan reads nothing. Only a new candidate is probed — once.
//
// Browsers outside Safari can't decode HEVC, which is what an iPhone records, so a
// clip that isn't H.264 gets a small H.264 copy in the thumbnail store (the same
// shape as transcode.ts's web copies, made at once: it is three seconds long).
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import exifr from "exifr";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { nanoid } from "nanoid";
import { db } from "../../../db.js";
import { thumbnailAbsolutePath, thumbnailStorageKey } from "../shared/thumbnail.js";
import type { GalleryDetailRow, LibraryItemRow } from "../../../db/rows.js";

const FFMPEG_BIN: string = (ffmpegStatic as unknown as string | null) || "ffmpeg";
const FFPROBE_BIN: string = ffprobeStatic?.path || "ffprobe";

export const STILL_EXTENSIONS: ReadonlySet<string> = new Set([".heic", ".heif", ".jpg", ".jpeg"]);
export const MOTION_EXTENSIONS: ReadonlySet<string> = new Set([".mov"]);
/** Apple's clips run about three seconds; this leaves room and no more. */
export const MAX_MOTION_SECONDS = 6;
/** A 4K HEVC Live Photo clip is a few MB; anything this big is a video of its own. */
export const MAX_MOTION_BYTES = 40 * 1024 * 1024;

/** The tag of Apple's MakerNote that holds the Live Photo's content identifier. */
const APPLE_CONTENT_IDENTIFIER = 0x0011;

interface PairableFile {
  relativePath: string;
  extension: string;
  size: number;
}

const stemKeyOf = (relativePath: string): string => {
  const dir = path.posix.dirname(relativePath);
  const base = path.posix.basename(relativePath);
  const stem = base.slice(0, base.length - path.posix.extname(base).length);
  return `${dir}/${stem}`.toLowerCase();
};

/** Still → clip, by names and sizes alone: the candidates. A name with two stills
 *  (`X.HEIC` and an exported `X.JPG`) pairs the clip with the HEIC, the original. */
export function liveCandidates<T extends PairableFile>(files: T[]): Map<string, T> {
  const groups = new Map<string, { stills: T[]; motions: T[] }>();
  for (const file of files) {
    const still = STILL_EXTENSIONS.has(file.extension);
    const motion = MOTION_EXTENSIONS.has(file.extension);
    if (!still && !motion) continue;
    const key = stemKeyOf(file.relativePath);
    const group = groups.get(key) ?? { stills: [], motions: [] };
    (still ? group.stills : group.motions).push(file);
    groups.set(key, group);
  }
  const out = new Map<string, T>();
  for (const { stills, motions } of groups.values()) {
    if (stills.length === 0 || motions.length !== 1) continue;
    const motion = motions[0]!;
    if (motion.size > MAX_MOTION_BYTES) continue;
    const still = stills.find((file) => file.extension === ".heic" || file.extension === ".heif") ?? stills[0]!;
    out.set(still.relativePath, motion);
  }
  return out;
}

/** Apple's content identifier from a raw MakerNote ("Apple iOS\0", version, byte
 *  order, then an IFD whose offsets count from the note's start), or null. */
export function contentIdFromMakerNote(note: Uint8Array | null | undefined): string | null {
  if (!note || note.length < 16) return null;
  const buf = Buffer.from(note.buffer, note.byteOffset, note.byteLength);
  if (buf.toString("latin1", 0, 9) !== "Apple iOS") return null;
  const order = buf.toString("latin1", 12, 14);
  if (order !== "MM" && order !== "II") return null;
  const u16 = (at: number) => (order === "MM" ? buf.readUInt16BE(at) : buf.readUInt16LE(at));
  const u32 = (at: number) => (order === "MM" ? buf.readUInt32BE(at) : buf.readUInt32LE(at));
  try {
    const count = u16(14);
    for (let i = 0; i < count; i += 1) {
      const entry = 16 + i * 12;
      if (entry + 12 > buf.length) return null;
      if (u16(entry) !== APPLE_CONTENT_IDENTIFIER || u16(entry + 2) !== 2) continue;
      const length = u32(entry + 4);
      const start = length <= 4 ? entry + 8 : u32(entry + 8);
      if (start + length > buf.length) return null;
      const value = buf.toString("latin1", start, start + length).replace(/\0+$/, "").trim();
      return value || null;
    }
  } catch { /* a truncated note */ }
  return null;
}

/** The still's content identifier, or null (not an iPhone photo, or stripped). A
 *  Buffer, never the path — exifr's file mode leaks a FileHandle on a bad file. */
export async function readStillContentId(absolutePath: string): Promise<string | null> {
  try {
    const parsed = await exifr.parse(await fs.promises.readFile(absolutePath), {
      tiff: true, exif: true, gps: false, interop: false, ifd1: false, xmp: false, icc: false, iptc: false, makerNote: true
    }) as { makerNote?: Uint8Array } | undefined;
    return contentIdFromMakerNote(parsed?.makerNote);
  } catch {
    return null;
  }
}

export interface MotionProbe {
  contentId: string | null;
  durationSeconds: number | null;
  videoCodec: string | null;
}

/** One ffprobe of the clip: identifier, length, codec. Nulls when it can't run. */
export function probeMotion(absolutePath: string): Promise<MotionProbe> {
  return new Promise((resolve) => {
    execFile(
      FFPROBE_BIN,
      ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", absolutePath],
      { windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        const empty: MotionProbe = { contentId: null, durationSeconds: null, videoCodec: null };
        if (error) return resolve(empty);
        try {
          const json = JSON.parse(String(stdout)) as {
            streams?: { codec_type?: string; codec_name?: string }[];
            format?: { duration?: string; tags?: Record<string, string> };
          };
          const tags = json.format?.tags ?? {};
          const id = Object.entries(tags).find(([key]) => key.toLowerCase() === "com.apple.quicktime.content.identifier")?.[1];
          const duration = json.format?.duration ? Number.parseFloat(json.format.duration) : NaN;
          const video = json.streams?.find((stream) => stream.codec_type === "video");
          resolve({
            contentId: id?.trim() || null,
            durationSeconds: Number.isFinite(duration) ? duration : null,
            videoCodec: video?.codec_name?.toLowerCase() ?? null
          });
        } catch {
          resolve(empty);
        }
      }
    );
  });
}

/** Whether a candidate is a Live Photo: short enough, and the identifiers agree
 *  wherever both are there. A clip ffprobe can't read is not paired. */
export function isLivePair(stillId: string | null, motion: MotionProbe): boolean {
  if (motion.durationSeconds == null || motion.durationSeconds > MAX_MOTION_SECONDS) return false;
  if (stillId && motion.contentId && stillId.toUpperCase() !== motion.contentId.toUpperCase()) return false;
  return true;
}

/** The thumbnail-store key of a clip's H.264 copy. */
export function motionWebKey(libraryId: string, itemId: string): string {
  return thumbnailStorageKey(libraryId, itemId, `${itemId}-motion.mp4`);
}

/** An H.264 copy of a clip a browser may not decode (HEVC), or null when the clip
 *  plays as it is or ffmpeg can't make one. Three seconds: done here, not queued. */
export async function makeMotionWebCopy(libraryId: string, itemId: string, absolutePath: string, codec: string | null): Promise<string | null> {
  if (codec === "h264") return null;
  const key = motionWebKey(libraryId, itemId);
  let out: string;
  try { out = thumbnailAbsolutePath(key); } catch { return null; }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const partial = `${out}.part.mp4`;
  const ok = await new Promise<boolean>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(FFMPEG_BIN, [
        "-v", "error", "-i", absolutePath,
        "-vf", "scale='min(1280,iw)':-2",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-y", partial
      ], { windowsHide: true, stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } resolve(false); }, 60_000);
    timer.unref?.();
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
  });
  if (!ok) {
    try { fs.rmSync(partial, { force: true }); } catch { /* ignore */ }
    return null;
  }
  fs.renameSync(partial, out);
  return key;
}

// ── The bin ──────────────────────────────────────────────────────────────────

/** The clip that goes into the bin with its still (one companion per item: a
 *  print's back, when a photo has both, goes first and the clip stays behind —
 *  the next scan makes it a video of its own). */
export function motionForTrash(itemId: string): string[] {
  const row = db.prepare("SELECT motion_relative_path FROM gallery_details WHERE item_id = ?")
    .get(itemId) as Pick<GalleryDetailRow, "motion_relative_path"> | undefined;
  return row?.motion_relative_path ? [row.motion_relative_path] : [];
}

/** After a restore put both files back: the clip is the still's motion again
 *  before any scan sees it as a video. The scan probes it and fills the rest. */
export function seedRestoredMotion(libraryId: string, itemPath: string, motionPath: string): void {
  const existing = db.prepare("SELECT id FROM library_items WHERE library_id = ? AND folder_path = ?")
    .get(libraryId, itemPath) as Pick<LibraryItemRow, "id"> | undefined;
  db.transaction(() => {
    let itemId = existing?.id;
    if (!itemId) {
      itemId = nanoid(16);
      db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, ?, 'gallery', ?, 'pending')")
        .run(itemId, libraryId, itemPath);
    } else {
      db.prepare("UPDATE library_items SET deleted_at = NULL, status = 'pending' WHERE id = ?").run(itemId);
    }
    db.prepare(`
      INSERT INTO gallery_details (item_id, kind, relative_path, motion_relative_path)
      VALUES (?, 'photo', ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET motion_relative_path = excluded.motion_relative_path,
        motion_size = NULL, motion_modified_at = NULL
    `).run(itemId, itemPath, motionPath);
    db.prepare("UPDATE library_items SET deleted_at = COALESCE(deleted_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE library_id = ? AND folder_path = ? AND id <> ?")
      .run(libraryId, motionPath, itemId);
  })();
}

/** The name a clip takes beside a still that was renamed on the way (a move into a
 *  folder where the name was taken): the still's name with the clip's extension. */
export function motionNameFor(stillFileName: string, clipFileName: string): string {
  const stem = stillFileName.slice(0, stillFileName.length - path.extname(stillFileName).length);
  return `${stem}${path.extname(clipFileName)}`;
}
