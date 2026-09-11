import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseBody } from "../../core/shared.js";
import { TRAVEL_MODES } from "../../core/routing.js";
import { resolveRouteGeometry } from "./route-geometry.js";
import { STORY_BLOCK_KINDS, BOOK_ENTITY_TYPES } from "./stories.js";
import { getChapter, getChapters } from "./chapters.js";
import { getBlock, blockPointsByIds, createBlock, updateBlock, deleteBlock, reorderBlocks } from "./blocks.js";
import { editableStory, entityId, referenceIsReachable, reorderSchema } from "./route-shared.js";

// Markdown source. The cap is generous — a chapter of prose is the point —
// but bounded so one block can't become an unbounded blob.
const MARKDOWN_MAX = 20000;

const blockCreateSchema = z.object({
  chapterId: entityId,
  kind: z.enum(STORY_BLOCK_KINDS),
  entityId: entityId.nullable().optional(),
  // Book blocks only: which book type the reference is (audiobook | ebook).
  entityType: z.enum(BOOK_ENTITY_TYPES).optional(),
  body: z.string().max(MARKDOWN_MAX).nullable().optional(),
  heading: z.string().trim().max(200).nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  zoom: z.number().int().min(1).max(20).nullable().optional(),
  label: z.string().trim().max(200).nullable().optional(),
  // Map blocks: the stops of a route, in travel order. One or none is the
  // original single-pin map; the cap keeps one block from becoming a track log
  // (a recorded trace belongs in a file, not in fifty thousand rows).
  // `mode` is how this stop was reached from the one before it. The LINE that
  // leg follows is deliberately not in this schema: it is fetched by the server
  // when the route is saved, so a request cannot paint a journey through
  // somewhere the stops never went.
  points: z.array(z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    label: z.string().trim().max(200).nullable().default(null),
    mode: z.enum(TRAVEL_MODES).nullable().default(null)
  })).max(50).optional(),
  caption: z.string().trim().max(500).nullable().optional(),
  layout: z.enum(["default", "wide", "grid"]).nullable().optional()
});

// A block's kind — and a book block's chosen type — are settled at creation.
const blockUpdateSchema = blockCreateSchema.omit({ chapterId: true, kind: true, entityType: true });

const blockReorderSchema = reorderSchema.extend({ chapterId: entityId });

export function registerBlockRoutes(app: FastifyInstance) {
  app.post("/api/stories/:id/blocks", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const story = editableStory((request.params as { id: string }).id, user, reply);
    if (!story) return reply;
    const parsed = parseBody(blockCreateSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid block", details: parsed.error });
    }
    const chapter = getChapter(parsed.data.chapterId);
    if (!chapter || chapter.story_id !== story.id) {
      return reply.code(404).send({ error: "Chapter not found" });
    }
    // A book block must say which book type it references.
    if (parsed.data.kind === "book" && !parsed.data.entityType) {
      return reply.code(400).send({ error: "Invalid block", details: "A book block needs its book type." });
    }
    if (!referenceIsReachable(parsed.data.kind, parsed.data.entityId, user, parsed.data.kind === "book" ? parsed.data.entityType : undefined)) {
      return reply.code(400).send({ error: "That content isn't available to add." });
    }
    const { points: stops, ...fields } = parsed.data;
    const points = parsed.data.kind === "map" && stops
      ? await resolveRouteGeometry(stops, [])
      : undefined;
    const block = createBlock(chapter.id, story.id, parsed.data.kind, { ...fields, points });
    return reply.code(201).send({ blockId: block.id });
  });

  app.patch("/api/stories/:id/blocks/reorder", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const story = editableStory((request.params as { id: string }).id, user, reply);
    if (!story) return reply;
    const parsed = parseBody(blockReorderSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid order", details: parsed.error });
    }
    const chapter = getChapter(parsed.data.chapterId);
    if (!chapter || chapter.story_id !== story.id) {
      return reply.code(404).send({ error: "Chapter not found" });
    }
    reorderBlocks(story.id, chapter.id, parsed.data.orderedIds);
    return reply.send({ reordered: true });
  });

  app.patch("/api/stories/:id/blocks/:blockId", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const { id, blockId } = request.params as { id: string; blockId: string };
    const story = editableStory(id, user, reply);
    if (!story) return reply;
    const block = getBlock(blockId);
    if (!block || !getChapters(story.id).some((chapter) => chapter.id === block.chapter_id)) {
      return reply.code(404).send({ error: "Block not found" });
    }
    const parsed = parseBody(blockUpdateSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid block", details: parsed.error });
    }
    if (parsed.data.entityId !== undefined
      && !referenceIsReachable(block.kind, parsed.data.entityId, user, block.kind === "book" ? block.entity_type : undefined)) {
      return reply.code(400).send({ error: "That content isn't available to add." });
    }
    const { points: stops, ...fields } = parsed.data;
    const points = block.kind === "map" && stops
      ? await resolveRouteGeometry(stops, blockPointsByIds([block.id]).get(block.id) ?? [])
      : undefined;
    updateBlock(block.id, story.id, { ...fields, points });
    return reply.send({ updated: true });
  });

  app.delete("/api/stories/:id/blocks/:blockId", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const { id, blockId } = request.params as { id: string; blockId: string };
    const story = editableStory(id, user, reply);
    if (!story) return reply;
    const block = getBlock(blockId);
    if (!block || !getChapters(story.id).some((chapter) => chapter.id === block.chapter_id)) {
      return reply.code(404).send({ error: "Block not found" });
    }
    deleteBlock(block.id, story.id);
    return reply.send({ deleted: true });
  });
}
