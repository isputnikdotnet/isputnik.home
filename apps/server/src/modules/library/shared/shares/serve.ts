import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import sharp from "sharp";
import { renderInTurn, thumbnailAbsolutePath } from "../thumbnail.js";
import { parseRangeHeader, pipeFileToReply } from "../document-stream.js";
import { decodePhotoToJpeg } from "../../gallery/media.js";

export const coverMimeByExt: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp"
};

// Serve a stored thumbnail (cover/preview) by storage key for guest routes.
export async function sendThumbnail(reply: FastifyReply, storageKey: string): Promise<FastifyReply> {
  try {
    const absolutePath = thumbnailAbsolutePath(storageKey);
    const bytes = await fsp.readFile(absolutePath);
    return reply
      .type(coverMimeByExt[path.extname(storageKey).toLowerCase()] ?? "application/octet-stream")
      .header("Content-Length", bytes.byteLength)
      .header("Cache-Control", "public, max-age=3600")
      .send(bytes);
  } catch {
    return reply.code(404).send({ error: "Image not found" });
  }
}

// Stream a single file from disk with range support, inline or as an attachment.
// Token-gated callers have already authorized access, so there is no per-user check
// here (unlike the authenticated document-stream helper).
export function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: { absolutePath: string; mimeType: string; fileName: string; download: boolean }
): void {
  const stat = fs.statSync(opts.absolutePath);
  const totalSize = stat.size;
  const asciiName = opts.fileName.replace(/[^\x20-\x7E]/g, "_");
  const disposition = opts.download ? "attachment" : "inline";
  const rangeHeader = request.headers["range"];
  const range = rangeHeader ? parseRangeHeader(rangeHeader, totalSize) : null;

  if (rangeHeader && !range) {
    reply.code(416).header("Content-Range", `bytes */${totalSize}`).send({ error: "Range not satisfiable" });
    return;
  }

  reply.hijack();
  const baseHeaders = {
    "Content-Type": opts.mimeType,
    "Content-Disposition": `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(opts.fileName)}`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-cache"
  };
  if (range) {
    reply.raw.writeHead(206, { ...baseHeaders, "Content-Range": `bytes ${range.start}-${range.end}/${totalSize}`, "Content-Length": range.size });
    pipeFileToReply(reply, opts.absolutePath, { start: range.start, end: range.end });
  } else {
    reply.raw.writeHead(200, { ...baseHeaders, "Content-Length": totalSize });
    pipeFileToReply(reply, opts.absolutePath);
  }
}

// A guest link hands its recipient the file itself. For a photo that means the
// camera original, which carries EXIF — including the GPS coordinates of
// wherever it was taken, typically the family's home. The catalog JSON already
// withholds coordinates and the thumbnails are metadata-free sharp re-encodes,
// but the download routes below streamed the original bytes untouched, quietly
// undoing that. Re-encode a shared photo through sharp on the way out: sharp
// drops all metadata unless asked to keep it, and .rotate() bakes the EXIF
// orientation into the pixels first so the stripped copy still displays upright.
// The common formats keep their format (and so their extension); exotic ones
// collapse to a high-quality JPEG. Videos are left as-is for now — stripping the
// location atom from a video needs an ffmpeg remux, a heavier change tracked as
// a follow-up — so only "photo" items divert here.
// Re-encode a shared photo, dropping all metadata. `animated: true` keeps GIF /
// animated-WebP frames; .rotate() bakes the EXIF orientation in so the stripped
// copy still displays upright. The common formats keep their format; exotic ones
// collapse to a high-quality JPEG. Returns null when the photo can't be decoded
// AT ALL — the caller must NOT then serve the original, or its EXIF/GPS leaks.
// Never throws.
//
// This is reachable unauthenticated (a guest link, or a browser prefetching a grid
// of full-size photos), so both sharp passes go through renderInTurn: two pipelines
// over the same undecodable file kill the process outright (see thumbnail.ts). The
// original is handed to sharp as a Buffer, never by path, so libvips holds no handle
// on a file the owner may be moving or trashing (CLAUDE.md). The ffmpeg rescue runs
// outside the queue — it is slow, and it isn't libvips.
type StrippedImage = { buffer: Buffer; contentType: string };

async function inTurn<T>(render: () => Promise<T>): Promise<T> {
  let result!: T;
  await renderInTurn([async () => { result = await render(); }]);
  return result;
}

export async function stripImageMetadata(absolutePath: string): Promise<StrippedImage | null> {
  let original: Buffer;
  try {
    original = await fsp.readFile(absolutePath);
  } catch {
    return null;
  }
  try {
    return await inTurn(async (): Promise<StrippedImage> => {
      const probe = await sharp(original, { failOn: "none" }).metadata();
      const format = probe.format;
      // Read every frame ONLY for the animated containers we re-emit as animated
      // (GIF/WebP), so their animation survives. A multi-page TIFF/AVIF must stay
      // single-page — otherwise sharp stacks its pages into one tall JPEG.
      const animated = (format === "gif" || format === "webp") && (probe.pages ?? 1) > 1;
      const pipeline = sharp(original, { failOn: "none", animated }).rotate();
      switch (format) {
        case "png":
          return { buffer: await pipeline.png().toBuffer(), contentType: "image/png" };
        case "webp":
          return { buffer: await pipeline.webp({ quality: 90 }).toBuffer(), contentType: "image/webp" };
        case "gif":
          return { buffer: await pipeline.gif().toBuffer(), contentType: "image/gif" };
        default:
          return { buffer: await pipeline.jpeg({ quality: 90, mozjpeg: true }).toBuffer(), contentType: "image/jpeg" };
      }
    });
  } catch {
    // sharp can't decode it — HEIC/HEIF is the common case (iPhone's default, and
    // exactly where the home GPS rides): the bundled libheif has no HEVC decoder.
    // Re-decode via ffmpeg to a clean JPEG, the same rescue the thumbnailer uses,
    // then strip that through sharp to be certain nothing rode along.
    const jpeg = await decodePhotoToJpeg(absolutePath);
    if (!jpeg) return null;
    try {
      return await inTurn(async () => ({
        buffer: await sharp(jpeg, { failOn: "none" }).rotate().jpeg({ quality: 90, mozjpeg: true }).toBuffer(),
        contentType: "image/jpeg"
      }));
    } catch {
      return null;
    }
  }
}

// The extension a stripped photo should carry, so a re-encoded file doesn't keep
// a lying extension (a TIFF re-encoded to JPEG must download as .jpg, not .tiff).
export function extForContentType(contentType: string): string {
  return contentType === "image/png"
    ? ".png"
    : contentType === "image/webp"
      ? ".webp"
      : contentType === "image/gif"
        ? ".gif"
        : ".jpg";
}

export function withExtension(fileName: string, ext: string): string {
  const current = path.extname(fileName).toLowerCase();
  const already = ext === ".jpg" ? current === ".jpg" || current === ".jpeg" : current === ext;
  return already ? fileName : `${fileName.slice(0, fileName.length - current.length)}${ext}`;
}

// Send one shared gallery file: a photo goes out metadata-stripped (and, if it
// can't be decoded at all, is refused rather than leaked), a video streams as the
// original via sendFile with ranges.
export async function sendGalleryFile(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: { absolutePath: string; mimeType: string | null; fileName: string; kind: string; download: boolean }
): Promise<FastifyReply | void> {
  if (opts.kind !== "photo") {
    return sendFile(request, reply, {
      absolutePath: opts.absolutePath,
      mimeType: opts.mimeType ?? "application/octet-stream",
      fileName: opts.fileName,
      download: opts.download
    });
  }
  const stripped = await stripImageMetadata(opts.absolutePath);
  if (!stripped) {
    // Undecodable even via ffmpeg — refuse rather than serve the original with its
    // EXIF/GPS intact, which is the whole point of stripping.
    return reply.code(415).send({ error: "This photo can't be shared." });
  }
  const fileName = withExtension(opts.fileName, extForContentType(stripped.contentType));
  const asciiName = fileName.replace(/[^\x20-\x7E]/g, "_");
  const disposition = opts.download ? "attachment" : "inline";
  return reply
    .header("Content-Type", stripped.contentType)
    .header(
      "Content-Disposition",
      `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
    )
    .header("Content-Length", stripped.buffer.byteLength)
    .header("Cache-Control", "private, no-cache")
    .send(stripped.buffer);
}
