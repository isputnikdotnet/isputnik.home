import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseBody } from "../../core/shared.js";
import { getChapter, createChapter, updateChapter, deleteChapter, reorderChapters } from "./chapters.js";
import { editableStory, entityId, optionalDate, referenceIsReachable, reorderSchema } from "./route-shared.js";

const chapterSchema = z.object({
  title: z.string().trim().max(160).nullable().optional(),
  date: optionalDate,
  endDate: optionalDate,
  dateApprox: z.boolean().optional(),
  place: z.string().trim().max(200).nullable().optional(),
  placeLat: z.number().min(-90).max(90).nullable().optional(),
  placeLng: z.number().min(-180).max(180).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  standfirst: z.string().trim().max(300).nullable().optional(),
  heroItemId: entityId.nullable().optional(),
  // "Use map as cover": draw the chapter's pin instead of a photo.
  heroMap: z.boolean().optional()
});

export function registerChapterRoutes(app: FastifyInstance) {
  app.post("/api/stories/:id/chapters", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const story = editableStory((request.params as { id: string }).id, user, reply);
    if (!story) return reply;
    const parsed = parseBody(chapterSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid chapter details", details: parsed.error });
    }
    if (parsed.data.heroItemId && !referenceIsReachable("media", parsed.data.heroItemId, user)) {
      return reply.code(400).send({ error: "That photo isn't available to use as a hero." });
    }
    const chapter = createChapter(story.id, parsed.data, user.id);
    return reply.code(201).send({ chapterId: chapter.id });
  });

  app.patch("/api/stories/:id/chapters/reorder", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const story = editableStory((request.params as { id: string }).id, user, reply);
    if (!story) return reply;
    const parsed = parseBody(reorderSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid order", details: parsed.error });
    }
    reorderChapters(story.id, parsed.data.orderedIds);
    return reply.send({ reordered: true });
  });

  app.patch("/api/stories/:id/chapters/:chapterId", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const { id, chapterId } = request.params as { id: string; chapterId: string };
    const story = editableStory(id, user, reply);
    if (!story) return reply;
    const chapter = getChapter(chapterId);
    if (!chapter || chapter.story_id !== story.id) {
      return reply.code(404).send({ error: "Chapter not found" });
    }
    const parsed = parseBody(chapterSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid chapter details", details: parsed.error });
    }
    if (parsed.data.heroItemId && !referenceIsReachable("media", parsed.data.heroItemId, user)) {
      return reply.code(400).send({ error: "That photo isn't available to use as a hero." });
    }
    updateChapter(chapter.id, story.id, parsed.data);
    return reply.send({ updated: true });
  });

  app.delete("/api/stories/:id/chapters/:chapterId", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const { id, chapterId } = request.params as { id: string; chapterId: string };
    const story = editableStory(id, user, reply);
    if (!story) return reply;
    const chapter = getChapter(chapterId);
    if (!chapter || chapter.story_id !== story.id) {
      return reply.code(404).send({ error: "Chapter not found" });
    }
    if (!deleteChapter(chapter.id, story.id)) {
      return reply.code(400).send({ error: "A story keeps at least one chapter." });
    }
    return reply.send({ deleted: true });
  });
}
