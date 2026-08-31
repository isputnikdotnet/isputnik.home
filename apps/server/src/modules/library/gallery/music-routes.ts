// Music endpoints for slideshows. Listing + streaming are open to every member;
// uploading needs write access to some gallery library; deleting a track is the
// uploader or an admin (built-in beds are undeletable). Files stream with range
// support so the live-preview <audio> can seek/loop.
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { db, logActivity } from "../../../db.js";
import { canUserWriteLibrary } from "../shared/library-access.js";
import { receiveUploadBatch, UploadError } from "../../uploads/index.js";
import { parseRangeHeader, pipeFileToReply } from "../shared/document-stream.js";
import {
  listMusicTracks,
  createUserTrack,
  deleteMusicTrack,
  getMusicTrack,
  musicFileAbsolutePath,
  musicMimeForKey,
  musicTempDir,
  musicTitleExists,
  titleFromFilename,
  MUSIC_UPLOAD_EXTENSIONS,
  MUSIC_MAX_BYTES,
  MUSIC_MAX_UPLOAD_FILES
} from "./music.js";

// A user may add music when they can write to any gallery library (music is a
// gallery-wide asset that no single library owns). Admins always may.
function canAddMusic(user: { id: string; role: string }): boolean {
  if (user.role === "admin") return true;
  const libs = db.prepare("SELECT id, policy_json FROM libraries WHERE type = 'gallery'").all() as {
    id: string;
    policy_json: string;
  }[];
  return libs.some((lib) => canUserWriteLibrary(lib, user.id, user.role));
}

export async function galleryMusicRoutesPlugin(app: FastifyInstance) {
  app.get("/api/library/gallery/music", { preHandler: app.authenticate }, async () => {
    return { tracks: listMusicTracks() };
  });

  app.post("/api/library/gallery/music", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    if (!canAddMusic(user)) {
      return reply.code(403).send({ error: "You need write access to a gallery library to add music." });
    }
    let received;
    try {
      received = await receiveUploadBatch(
        request,
        { accept: MUSIC_UPLOAD_EXTENSIONS, maxBytes: MUSIC_MAX_BYTES },
        musicTempDir(),
        MUSIC_MAX_UPLOAD_FILES
      );
    } catch (err) {
      if (err instanceof UploadError) { return reply.code(err.statusCode).send({ error: err.message }); }
      return reply.code(400).send({ error: err instanceof Error ? err.message : "Upload failed." });
    }

    // A track already here under this name is skipped rather than stored a second
    // time: the picker lists tracks by title, so a duplicate would be two rows you
    // cannot tell apart. Skipping is deliberately not an error — picking a folder
    // of beds where three are already here should add the other two and say so,
    // not refuse the lot.
    const tracks = [];
    const skipped: string[] = [];
    const seen = new Set<string>();
    for (const file of received) {
      const title = titleFromFilename(file.filename);
      const key = title.toLowerCase();
      // `seen` catches duplicates WITHIN this selection too — two folders each
      // holding "Sunset.mp3" would otherwise both pass the table check, since
      // neither is committed yet when the other is examined.
      if (seen.has(key) || musicTitleExists(title)) {
        fs.rmSync(file.tmpPath, { force: true });
        skipped.push(file.filename);
        continue;
      }
      seen.add(key);
      tracks.push(await createUserTrack(user, file.tmpPath, file.filename, file.extension));
    }

    if (tracks.length > 0) {
      logActivity({
        event: "gallery.music.uploaded",
        actorUserId: user.id,
        targetType: "gallery_music",
        // One row for the batch, so adding twelve beds is one line in the log and
        // not twelve. A single upload still names the track it was.
        targetId: tracks.length === 1 ? tracks[0].id : null,
        detail: tracks.length === 1
          ? `Uploaded slideshow music "${tracks[0].title}".`
          : `Uploaded ${tracks.length} slideshow music tracks.`,
        ipAddress: request.ip
      });
    }

    // 201 when something was created, 200 when every file was already here — the
    // request succeeded either way, and the client tells the user which happened.
    return reply.code(tracks.length > 0 ? 201 : 200).send({ tracks, skipped });
  });

  app.delete("/api/library/gallery/music/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const result = deleteMusicTrack((request.params as { id: string }).id, request.user!);
    if (result === "notfound") { return reply.code(404).send({ error: "Track not found" }); }
    if (result === "builtin") { return reply.code(403).send({ error: "Built-in tracks can't be deleted." }); }
    if (result === "forbidden") { return reply.code(403).send({ error: "Only the uploader or an admin can delete this track." }); }
    return reply.send({ deleted: true });
  });

  // Stream a track (range-aware) so the preview <audio> can loop and seek.
  app.get("/api/library/gallery/music/:id/stream", { preHandler: app.authenticate }, (request, reply) => {
    const track = getMusicTrack((request.params as { id: string }).id);
    if (!track) { reply.code(404).send({ error: "Track not found" }); return; }

    let filePath: string;
    try { filePath = musicFileAbsolutePath(track); } catch { reply.code(404).send({ error: "Track not found" }); return; }
    if (!fs.existsSync(filePath)) { reply.code(404).send({ error: "Track not found" }); return; }

    const totalSize = fs.statSync(filePath).size;
    const mimeType = musicMimeForKey(track.storage_key);
    const rangeHeader = request.headers["range"];
    const range = rangeHeader ? parseRangeHeader(rangeHeader, totalSize) : null;
    if (rangeHeader && !range) {
      reply.code(416).header("Content-Range", `bytes */${totalSize}`).send({ error: "Range not satisfiable" });
      return;
    }

    reply.hijack();
    if (range) {
      reply.raw.writeHead(206, {
        "Content-Type": mimeType,
        "Content-Range": `bytes ${range.start}-${range.end}/${totalSize}`,
        "Content-Length": range.size,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=86400"
      });
      pipeFileToReply(reply, filePath, { start: range.start, end: range.end });
    } else {
      reply.raw.writeHead(200, {
        "Content-Type": mimeType,
        "Content-Length": totalSize,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=86400"
      });
      pipeFileToReply(reply, filePath);
    }
  });
}
