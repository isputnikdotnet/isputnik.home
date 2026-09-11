import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { logActivity } from "../../db.js";
import { receiveUpload, UploadError } from "../uploads/index.js";
import {
  NARRATION_EXTENSIONS,
  NARRATION_MAX_BYTES,
  getStoryAudio,
  sendNarration,
  narrationTempDir
} from "./audio.js";
import { RecordingError, storeRecording } from "./recordings.js";
import { getStory, canViewStory } from "./access.js";
import { editableStory } from "./route-shared.js";

export function registerStoryAudioRoutes(app: FastifyInstance) {
  // Upload a narration clip for this story. The file lands in the admin-chosen
  // RECORDINGS LIBRARY as a normal gallery audio asset (v2 — stories reference,
  // period), and what comes back is that asset's id — the caller then adds an
  // `audio` block pointing at it, the same two steps a photo takes (pick, then
  // place). Without a recordings library the editor hides this affordance; a
  // direct call gets the 409 with the same explanation.
  app.post("/api/stories/:id/audio", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const story = editableStory((request.params as { id: string }).id, user, reply);
    if (!story) return reply;

    let received;
    try {
      received = await receiveUpload(
        request,
        { accept: NARRATION_EXTENSIONS, maxBytes: NARRATION_MAX_BYTES },
        narrationTempDir()
      );
    } catch (err) {
      if (err instanceof UploadError) { return reply.code(err.statusCode).send({ error: err.message }); }
      return reply.code(400).send({ error: err instanceof Error ? err.message : "Upload failed." });
    }

    try {
      const stored = await storeRecording(received.tmpPath, received.filename, received.extension);
      logActivity({
        event: "story.narration_recorded",
        actorUserId: user.id,
        targetType: "story",
        targetId: story.id,
        detail: `Added a recording to story "${story.title}".`,
        ipAddress: request.ip
      });
      return reply.code(201).send({
        audio: { id: stored.itemId, title: stored.title, durationSeconds: stored.durationSeconds }
      });
    } catch (err) {
      fs.rmSync(received.tmpPath, { force: true });
      if (err instanceof RecordingError) { return reply.code(err.statusCode).send({ error: err.message }); }
      return reply.code(500).send({ error: err instanceof Error ? err.message : "The recording could not be stored." });
    }
  });

  // Stream a narration clip to someone who can read the story. Ranged, so a
  // long recording can be scrubbed rather than only played from the top.
  app.get("/api/stories/:id/audio/:audioId", { preHandler: app.authenticate }, (request, reply) => {
    const user = request.user!;
    const { id, audioId } = request.params as { id: string; audioId: string };
    const story = getStory(id);
    if (!story || !canViewStory(story, user)) {
      reply.code(404).send({ error: "Story not found" });
      return;
    }
    // Belonging to THIS story is the authorization — a clip id from another
    // story is indistinguishable from a missing one.
    const audio = getStoryAudio(audioId);
    if (!audio || audio.story_id !== story.id) {
      reply.code(404).send({ error: "Recording not found" });
      return;
    }
    return sendNarration(request, reply, audio);
  });
}
