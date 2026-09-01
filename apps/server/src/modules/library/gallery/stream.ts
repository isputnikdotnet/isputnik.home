// Serve the original photo/video/audio for an asset, with HTTP range support so
// the browser's <video>/<audio> elements can seek. Mirrors the audiobook file
// streamer (reply.hijack() + parseRangeHeader + pipe(reply.raw)). Photos are
// usually served whole; videos and recordings arrive as 206 partial responses.
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { db, logActivity } from "../../../db.js";
import { pathIsInside } from "../shared/storage-roots.js";
import { canUserAccessBook } from "../shared/library-access.js";
import { parseRangeHeader, pipeFileToReply } from "../shared/document-stream.js";
import { thumbnailAbsolutePath } from "../shared/thumbnail.js";

/**
 * Content-Disposition naming the asset's own file. Without it the browser names
 * a save after the URL's last segment — the route ends in /file, so every photo
 * lands as "file", then "file (1)", "file (2)".
 *
 * `webCopy` means the transcoded H.264 stand-in is being served, which is a
 * different container from the original, so the name says .mp4.
 */
export function assetDisposition(relativePath: string, opts: { attachment: boolean; webCopy?: boolean }): string {
  // Split on "/" rather than path.basename: relative_path is always stored
  // "/"-delimited, and on Windows basename would also cut at a backslash — which
  // is a legal character in a Linux filename, so the name would differ between a
  // dev machine and the container.
  const original = relativePath.split("/").pop() ?? relativePath;
  const name = opts.webCopy ? `${original.replace(/\.[^.]+$/, "")}.mp4` : original;
  // A quote or backslash would close the quoted string early; non-ASCII rides
  // along in the RFC 5987 filename* form, which every current browser prefers.
  const ascii = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `${opts.attachment ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function galleryStreamPlugin(app: FastifyInstance) {
  app.get("/api/library/gallery/assets/:id/file", { preHandler: app.authenticate }, (request, reply) => {
    const { id } = request.params as { id: string };

    const row = db.prepare(`
      SELECT gallery_details.relative_path, gallery_details.mime_type, gallery_details.web_video_key,
             libraries.source_path, libraries.id AS id, item_metadata.title AS title
      FROM gallery_details
      JOIN library_items ON library_items.id = gallery_details.item_id
      JOIN libraries ON libraries.id = library_items.library_id
      LEFT JOIN item_metadata ON item_metadata.item_id = gallery_details.item_id
      WHERE gallery_details.item_id = ? AND library_items.deleted_at IS NULL
    `).get(id) as { relative_path: string; mime_type: string | null; web_video_key: string | null; source_path: string; id: string; title: string | null } | undefined;

    if (!row) {
      reply.code(404).send({ error: "Asset not found" });
      return;
    }

    const user = request.user!;
    if (!canUserAccessBook(id, row, user.id, user.role, "gallery")) {
      reply.code(404).send({ error: "Asset not found" });
      return;
    }

    // ?web=1 serves the browser-playable H.264 copy (transcode.ts) for inline playback of
    // a video the browser can't decode; downloads and everything else keep the original.
    const wantWeb = typeof (request.query as { web?: string }).web === "string" && row.web_video_key;
    let filePath: string;
    let mimeType: string;
    if (wantWeb) {
      try { filePath = thumbnailAbsolutePath(row.web_video_key!); } catch { reply.code(404).send({ error: "Asset not found" }); return; }
      mimeType = "video/mp4";
      if (!fs.existsSync(filePath)) { reply.code(404).send({ error: "Asset not found" }); return; }
    } else {
      filePath = path.join(row.source_path, ...row.relative_path.split("/"));
      mimeType = row.mime_type ?? "application/octet-stream";
      if (!pathIsInside(filePath, row.source_path) || !fs.existsSync(filePath)) {
        reply.code(404).send({ error: "Asset not found" });
        return;
      }
    }

    const stat = fs.statSync(filePath);
    const totalSize = stat.size;
    const rangeHeader = request.headers["range"];
    const range = rangeHeader ? parseRangeHeader(rangeHeader, totalSize) : null;

    if (rangeHeader && !range) {
      reply.code(416).header("Content-Range", `bytes */${totalSize}`).send({ error: "Range not satisfiable" });
      return;
    }

    // This endpoint also serves inline views/playback, so only audit an explicit
    // download (client appends ?download=1) — and only at the start of the transfer
    // so a ranged video download logs once, not per chunk.
    const wantsDownload = typeof (request.query as { download?: string }).download === "string";
    if (wantsDownload && (!range || range.start === 0)) {
      const mime = row.mime_type ?? "";
      const noun = mime.startsWith("video") ? "video" : mime.startsWith("audio") ? "recording" : "photo";
      const title = row.title ?? path.basename(row.relative_path);
      logActivity({
        event: "library.gallery.downloaded",
        actorUserId: user.id,
        targetType: "gallery",
        targetId: id,
        detail: `Downloaded ${noun} "${title}".`,
        ipAddress: request.ip
      });
    }

    // "inline" on the non-download path so the photo still displays in the page,
    // while "Save image as…" and the video element's own menu still offer the real
    // name instead of "file".
    const disposition = assetDisposition(row.relative_path, { attachment: wantsDownload, webCopy: Boolean(wantWeb) });

    reply.hijack();
    if (range) {
      reply.raw.writeHead(206, {
        "Content-Type": mimeType,
        "Content-Range": `bytes ${range.start}-${range.end}/${totalSize}`,
        "Content-Length": range.size,
        "Accept-Ranges": "bytes",
        "Content-Disposition": disposition,
        "Cache-Control": "private, no-cache"
      });
      pipeFileToReply(reply, filePath, { start: range.start, end: range.end });
    } else {
      reply.raw.writeHead(200, {
        "Content-Type": mimeType,
        "Content-Length": totalSize,
        "Accept-Ranges": "bytes",
        "Content-Disposition": disposition,
        "Cache-Control": "private, no-cache"
      });
      pipeFileToReply(reply, filePath);
    }
  });
}
