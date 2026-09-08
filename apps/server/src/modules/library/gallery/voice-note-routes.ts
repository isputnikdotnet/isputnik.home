// Voice notes on a photo — docs/photo-review-plan.md, phase 4. See voice-notes.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { logActivity } from "../../../db.js";
import { receiveUpload, UploadError } from "../../uploads/index.js";
import { canUserAccessBook, canUserWriteAsset, getLibraryForBook } from "../shared/library-access.js";
import { parseRangeHeader, pipeFileToReply } from "../shared/document-stream.js";
import {
  deleteVoiceNote, listVoiceNotes, storeVoiceNote, voiceNoteFile, VoiceNoteError,
  VOICE_NOTE_EXTENSIONS, VOICE_NOTE_MAX_BYTES
} from "./voice-notes.js";

function tempDir(): string {
  const dir = path.join(os.tmpdir(), "isputnik-voice-notes");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function galleryVoiceNoteRoutesPlugin(app: FastifyInstance) {
  // Record: one file, kept on the photo. The write right on the PHOTO — the
  // library's edit right, or an album sent with a question — is what allows
  // it; the house library takes the file on the admin's standing nomination.
  app.post("/api/library/gallery/assets/:id/voice-notes", { preHandler: app.authenticate }, async (request, reply) => {
    const itemId = (request.params as { id: string }).id;
    const user = request.user!;
    const lib = getLibraryForBook(itemId);
    if (!lib || lib.type !== "gallery" || !canUserWriteAsset(itemId, lib, user.id, user.role)) {
      return reply.code(403).send({ error: "Write access required to record a voice note on this photo." });
    }
    let received;
    try {
      received = await receiveUpload(request, { accept: VOICE_NOTE_EXTENSIONS, maxBytes: VOICE_NOTE_MAX_BYTES }, tempDir());
    } catch (err) {
      const status = err instanceof UploadError ? err.statusCode : 400;
      return reply.code(status).send({ error: err instanceof Error ? err.message : "Upload failed." });
    }
    try {
      const note = await storeVoiceNote(itemId, user.id, received.tmpPath, received.extension);
      return reply.code(201).send({ note, notes: listVoiceNotes(itemId) });
    } catch (err) {
      fs.rmSync(received.tmpPath, { force: true });
      if (err instanceof VoiceNoteError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  // Listen: streams the recording to whoever may see the photo, Range and all,
  // the house pattern for binary (reply.hijack() + pipe).
  app.get("/api/library/gallery/assets/:id/voice-notes/:noteId/audio", { preHandler: app.authenticate }, async (request, reply) => {
    const { id: itemId, noteId } = request.params as { id: string; noteId: string };
    const user = request.user!;
    const lib = getLibraryForBook(itemId);
    if (!lib || lib.type !== "gallery" || !canUserAccessBook(itemId, lib, user.id, user.role, "gallery")) {
      return reply.code(404).send({ error: "Voice note not found" });
    }
    const file = voiceNoteFile(itemId, noteId);
    if (!file || !fs.existsSync(file.path)) return reply.code(404).send({ error: "Voice note not found" });

    const total = fs.statSync(file.path).size;
    const range = request.headers.range ? parseRangeHeader(request.headers.range, total) : null;
    if (request.headers.range && !range) {
      return reply.code(416).header("Content-Range", `bytes */${total}`).send();
    }
    reply.hijack();
    if (range) {
      reply.raw.writeHead(206, {
        "Content-Type": file.mime,
        "Content-Length": range.end - range.start + 1,
        "Content-Range": `bytes ${range.start}-${range.end}/${total}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600"
      });
      pipeFileToReply(reply, file.path, range);
      return reply;
    }
    reply.raw.writeHead(200, {
      "Content-Type": file.mime,
      "Content-Length": total,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600"
    });
    pipeFileToReply(reply, file.path);
    return reply;
  });

  app.delete("/api/library/gallery/assets/:id/voice-notes/:noteId", { preHandler: app.authenticate, config: { destructive: true } }, async (request, reply) => {
    const { id: itemId, noteId } = request.params as { id: string; noteId: string };
    const user = request.user!;
    const lib = getLibraryForBook(itemId);
    if (!lib || lib.type !== "gallery" || !canUserWriteAsset(itemId, lib, user.id, user.role)) {
      return reply.code(403).send({ error: "Write access required to remove a voice note from this photo." });
    }
    if (!deleteVoiceNote(itemId, noteId, user.id)) return reply.code(404).send({ error: "Voice note not found" });
    logActivity({
      event: "library.gallery.voice_note_removed",
      actorUserId: user.id,
      targetType: "library_item",
      targetId: itemId,
      detail: "Removed a voice note from a photo.",
      ipAddress: request.ip
    });
    return reply.send({ removed: true, notes: listVoiceNotes(itemId) });
  });
}
