// Media probing for the gallery scanner: image metadata + EXIF (sharp + exifr),
// video metadata (ffprobe), and thumbnail/poster generation (sharp; ffmpeg for the
// video poster frame). ffmpeg/ffprobe are external binaries — every call degrades
// gracefully (returns nulls) when they're missing or a file can't be decoded, so a
// scan still indexes the asset (just without dimensions/thumbnail).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import exifr from "exifr";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { thumbnailAbsolutePath, thumbnailStorageKey } from "../shared/thumbnail.js";

// Prefer the bundled static binaries — they ship in node_modules, so video probing
// works on a dev box and in the Docker image without a system ffmpeg install. Fall
// back to a PATH lookup if a binary is somehow missing.
const FFMPEG_BIN: string = (ffmpegStatic as unknown as string | null) || "ffmpeg";
const FFPROBE_BIN: string = ffprobeStatic?.path || "ffprobe";

const PHOTO_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif", ".tiff", ".tif", ".bmp", ".avif"
]);
const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv", ".wmv", ".flv", ".mpg", ".mpeg", ".3gp"
]);

export type AssetKind = "photo" | "video";

export function kindForExtension(extension: string): AssetKind | null {
  const ext = extension.toLowerCase();
  if (PHOTO_EXTENSIONS.has(ext)) return "photo";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return null;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".gif": "image/gif", ".heic": "image/heic", ".heif": "image/heif", ".tiff": "image/tiff",
  ".tif": "image/tiff", ".bmp": "image/bmp", ".avif": "image/avif",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/x-m4v", ".webm": "video/webm",
  ".avi": "video/x-msvideo", ".mkv": "video/x-matroska", ".wmv": "video/x-ms-wmv",
  ".flv": "video/x-flv", ".mpg": "video/mpeg", ".mpeg": "video/mpeg", ".3gp": "video/3gpp"
};

export function mimeForExtension(extension: string): string {
  return MIME_BY_EXTENSION[extension.toLowerCase()] ?? "application/octet-stream";
}

export interface AssetMetadata {
  width: number | null;
  height: number | null;
  orientation: number | null;
  durationSeconds: number | null;
  takenAt: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
}

const EMPTY_METADATA: AssetMetadata = {
  width: null, height: null, orientation: null, durationSeconds: null,
  takenAt: null, gpsLat: null, gpsLng: null, cameraMake: null, cameraModel: null
};

// Run an external binary and capture stdout. Resolves { ok:false } on any failure
// (binary missing, non-zero exit, timeout) so callers never throw on a bad asset.
function run(command: string, args: string[], timeoutMs = 30000): Promise<{ ok: boolean; stdout: Buffer }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch {
      resolve({ ok: false, stdout: Buffer.alloc(0) });
      return;
    }
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ ok, stdout: Buffer.concat(chunks) });
    };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } done(false); }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => { clearTimeout(timer); done(false); });
    child.on("close", (code) => { clearTimeout(timer); done(code === 0); });
  });
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "string") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Photo metadata: dimensions/orientation from sharp, date/GPS/camera from EXIF.
async function readPhotoMetadata(absolutePath: string): Promise<AssetMetadata> {
  const meta: AssetMetadata = { ...EMPTY_METADATA };
  try {
    const info = await sharp(absolutePath).metadata();
    meta.width = finiteOrNull(info.width);
    meta.height = finiteOrNull(info.height);
    meta.orientation = finiteOrNull(info.orientation);
  } catch {
    // sharp has no loader for this format (BMP is the common case): ffprobe still
    // reports the dimensions of most stills, so the asset keeps width/height.
    const probed = await readVideoMetadata(absolutePath);
    meta.width = probed.width;
    meta.height = probed.height;
  }
  try {
    // Default parse reads TIFF/EXIF/GPS and adds computed latitude/longitude.
    const exif = await exifr.parse(absolutePath);
    if (exif) {
      meta.takenAt = isoOrNull(exif.DateTimeOriginal ?? exif.CreateDate ?? exif.ModifyDate);
      meta.gpsLat = finiteOrNull(exif.latitude);
      meta.gpsLng = finiteOrNull(exif.longitude);
      meta.cameraMake = typeof exif.Make === "string" ? exif.Make.trim() || null : null;
      meta.cameraModel = typeof exif.Model === "string" ? exif.Model.trim() || null : null;
      if (meta.orientation == null) meta.orientation = finiteOrNull(exif.Orientation);
    }
  } catch { /* no/!invalid EXIF */ }
  return meta;
}

// Video metadata via ffprobe (JSON). Missing ffprobe → empty metadata.
async function readVideoMetadata(absolutePath: string): Promise<AssetMetadata> {
  const meta: AssetMetadata = { ...EMPTY_METADATA };
  const probe = await run(FFPROBE_BIN, [
    "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", absolutePath
  ]);
  if (!probe.ok) return meta;
  try {
    const json = JSON.parse(probe.stdout.toString("utf8")) as {
      streams?: { codec_type?: string; width?: number; height?: number; tags?: Record<string, string> }[];
      format?: { duration?: string; tags?: Record<string, string> };
    };
    const video = json.streams?.find((s) => s.codec_type === "video");
    if (video) {
      meta.width = finiteOrNull(video.width);
      meta.height = finiteOrNull(video.height);
    }
    const duration = json.format?.duration ? Number.parseFloat(json.format.duration) : NaN;
    meta.durationSeconds = Number.isFinite(duration) ? duration : null;
    const created = json.format?.tags?.creation_time
      ?? json.streams?.find((s) => s.tags?.creation_time)?.tags?.creation_time;
    meta.takenAt = isoOrNull(created);
  } catch { /* malformed ffprobe output */ }
  return meta;
}

export function readAssetMetadata(kind: AssetKind, absolutePath: string): Promise<AssetMetadata> {
  return kind === "video" ? readVideoMetadata(absolutePath) : readPhotoMetadata(absolutePath);
}

// Extract a poster frame from a video as a JPEG buffer (ffmpeg). Seeks ~1s in to
// skip black intro frames; null when ffmpeg is unavailable or the seek fails.
async function videoPosterBuffer(absolutePath: string): Promise<Buffer | null> {
  const result = await run(FFMPEG_BIN, [
    "-v", "quiet", "-ss", "1", "-i", absolutePath,
    "-frames:v", "1", "-f", "image2", "-vcodec", "mjpeg", "pipe:1"
  ]);
  if (result.ok && result.stdout.length > 0) return result.stdout;
  // Retry from the very start for clips shorter than the 1s seek.
  const retry = await run(FFMPEG_BIN, [
    "-v", "quiet", "-i", absolutePath,
    "-frames:v", "1", "-f", "image2", "-vcodec", "mjpeg", "pipe:1"
  ]);
  return retry.ok && retry.stdout.length > 0 ? retry.stdout : null;
}

// Decode a photo sharp has no loader for (BMP is the common case — libvips'
// prebuilt binaries can't read it) into a JPEG buffer via the bundled ffmpeg.
// Near-lossless (-q:v 2) so thumbnails and face detection can work from it.
// Null when ffmpeg is missing or can't decode the file either.
export async function decodePhotoToJpeg(absolutePath: string): Promise<Buffer | null> {
  const result = await run(FFMPEG_BIN, [
    "-v", "quiet", "-i", absolutePath,
    "-frames:v", "1", "-f", "image2", "-vcodec", "mjpeg", "-q:v", "2", "pipe:1"
  ]);
  return result.ok && result.stdout.length > 0 ? result.stdout : null;
}

export interface ThumbnailKeys {
  coverKey: string;   // grid thumbnail (~400px) → item_metadata.cover_storage_key
  previewKey: string; // lightbox preview (~1600px) → gallery_details.preview_storage_key
}

// Generate a grid thumbnail + a larger preview for one asset. For photos the source
// is the file; for videos it's an ffmpeg poster frame. `rotation` is a user-applied
// clockwise angle (0/90/180/270) baked in on top of the EXIF orientation. Returns
// null when no image could be produced (e.g. an undecodable HEIC or a video with
// ffmpeg missing) — the asset is still indexed, just without artwork.
export async function generateGalleryThumbnails(
  libraryId: string,
  itemId: string,
  kind: AssetKind,
  absolutePath: string,
  rotation = 0
): Promise<ThumbnailKeys | null> {
  const source: Buffer | string | null = kind === "video" ? await videoPosterBuffer(absolutePath) : absolutePath;
  if (!source) return null;
  const render = async (input: Buffer | string): Promise<ThumbnailKeys> => {
    const coverKey = thumbnailStorageKey(libraryId, itemId, `${itemId}-cover.webp`);
    const previewKey = thumbnailStorageKey(libraryId, itemId, `${itemId}-cover-large.webp`);
    const coverPath = thumbnailAbsolutePath(coverKey);
    const previewPath = thumbnailAbsolutePath(previewKey);
    fs.mkdirSync(path.dirname(coverPath), { recursive: true });
    // rotate() applies the EXIF orientation so thumbnails are upright; a second
    // rotate(angle) then adds any manual rotation (sharp composes the two).
    const oriented = () => {
      const img = sharp(input, { failOn: "none" }).rotate();
      return rotation ? img.rotate(rotation) : img;
    };
    await Promise.all([
      oriented().resize(400, 400, { fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toFile(coverPath),
      oriented().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toFile(previewPath)
    ]);
    return { coverKey, previewKey };
  };
  try {
    return await render(source);
  } catch {
    // A photo sharp can't read (BMP et al): re-decode via ffmpeg and retry. The
    // existence guard keeps a missing file failing fast without a pointless spawn.
    if (kind === "photo" && fs.existsSync(absolutePath)) {
      const converted = await decodePhotoToJpeg(absolutePath);
      if (converted) {
        try { return await render(converted); } catch { return null; }
      }
    }
    return null;
  }
}
