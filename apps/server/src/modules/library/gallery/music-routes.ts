// Music endpoints for slideshows. Listing + streaming are open to every member;
// uploading needs write access to some gallery library; deleting a track is the
// uploader or an admin (built-in beds are undeletable). Files stream with range
// support so the live-preview <audio> can seek/loop.
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { db, logActivity } from "../../../db.js";
import { canUserWriteLibrary } from "../shared/library-access.js";
import { receiveUpload, UploadError } from "../../uploads/index.js";
import { parseRangeHeader } from "../shared/document-stream.js";
import {
  listMusicTracks,
  createUserTrack,
  deleteMusicTrack,
  getMusicTrack,
  musicFileAbsolutePath,
  musicMimeForKey,
  musicTempDir,
  MUSIC_UPLOAD_EXTENSIONS,
  MUSIC_MAX_BYTES
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
      reply.code(403).send({ error: "You need write access to a gallery library to add music." });
      return;
    }
    let received;
    try {
      received = await receiveUpload(request, { accept: MUSIC_UPLOAD_EXTENSIONS, maxBytes: MUSIC_MAX_BYTES }, musicTempDir());
    } catch (err) {
      if (err instanceof UploadError) { reply.code(err.statusCode).send({ error: err.message }); return; }
      reply.code(400).send({ error: err instanceof Error ? err.message : "Upload failed." });
      return;
    }
    const track = await createUserTrack(user, received.tmpPath, received.filename, received.extension);
    logActivity({
      event: "gallery.music.uploaded",
      actorUserId: user.id,
      targetType: "gallery_music",
      targetId: track.id,
      detail: `Uploaded slideshow music "${track.title}".`,
      ipAddress: request.ip
    });
    reply.code(201).send({ track });
  });

  app.delete("/api/library/gallery/music/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const result = deleteMusicTrack((request.params as { id: string }).id, request.user!);
    if (result === "notfound") { reply.code(404).send({ error: "Track not found" }); return; }
    if (result === "builtin") { reply.code(403).send({ error: "Built-in tracks can't be deleted." }); return; }
    if (result === "forbidden") { reply.code(403).send({ error: "Only the uploader or an admin can delete this track." }); return; }
    reply.send({ deleted: true });
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
      fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(reply.raw);
    } else {
      reply.raw.writeHead(200, {
        "Content-Type": mimeType,
        "Content-Length": totalSize,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=86400"
      });
      fs.createReadStream(filePath).pipe(reply.raw);
    }
  });
}
