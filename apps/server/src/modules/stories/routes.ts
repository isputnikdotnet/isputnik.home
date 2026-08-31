// Story endpoints. Reads are open to every member (published stories only —
// a draft belongs to its author); writes require canEditStory (creator +
// admins). Referenced content is hydrated through the subjects registry, so a
// block resolves against the VIEWER's library access and a deleted target
// degrades to an "unavailable" placeholder instead of breaking the page.
import fs from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { logActivity } from "../../db.js";
import { parseBody } from "../../core/shared.js";
import { hydrateEntities } from "../social/subjects.js";
import { resolveGalleryScopeLibraryIds } from "../library/gallery/catalog.js";
import { partialDateSchema } from "../familytree/persons.js";
import { setEntityTags } from "../library/audiobook/categorize.js";
import { receiveUpload, UploadError } from "../uploads/index.js";
import { parseRangeHeader, pipeFileToReply } from "../library/shared/document-stream.js";
import {
  STORY_AUDIO_ENTITY_TYPE,
  NARRATION_EXTENSIONS,
  NARRATION_MAX_BYTES,
  createStoryAudio,
  getStoryAudio,
  storyAudioByIds,
  narrationAbsolutePath,
  narrationMime,
  narrationTempDir,
  type StoryAudioRow
} from "./audio.js";
import {
  STORY_ENTITY_TYPE,
  STORY_BLOCK_KINDS,
  STORY_STATUSES,
  BLOCK_ENTITY_TYPE,
  BLOCK_PREVIEW_LIMIT,
  getStory,
  canEditStory,
  canViewStory,
  createStory,
  updateStory,
  deleteStory,
  listStories,
  getStoryTags,
  getChapters,
  getChapter,
  createChapter,
  updateChapter,
  deleteChapter,
  reorderChapters,
  getBlocks,
  getBlock,
  createBlock,
  updateBlock,
  deleteBlock,
  reorderBlocks,
  galleryAssetsByIds,
  blockPreviewAssets,
  type StoryRow,
  type StoryBlockKind
} from "./stories.js";

const optionalDate = partialDateSchema.nullable().optional();
const entityId = z.string().trim().min(1).max(64);

const createSchema = z.object({
  title: z.string().trim().min(1).max(160),
  subtitle: z.string().trim().max(300).nullable().optional()
});

const updateSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  subtitle: z.string().trim().max(300).nullable().optional(),
  status: z.enum(STORY_STATUSES).optional(),
  coverItemId: entityId.nullable().optional()
});

const chapterSchema = z.object({
  title: z.string().trim().max(160).nullable().optional(),
  date: optionalDate,
  endDate: optionalDate,
  dateApprox: z.boolean().optional(),
  place: z.string().trim().max(200).nullable().optional(),
  placeLat: z.number().min(-90).max(90).nullable().optional(),
  placeLng: z.number().min(-180).max(180).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional()
});

// Markdown source. The cap is generous — a chapter of prose is the point —
// but bounded so one block can't become an unbounded blob.
const MARKDOWN_MAX = 20000;

const blockCreateSchema = z.object({
  chapterId: entityId,
  kind: z.enum(STORY_BLOCK_KINDS),
  entityId: entityId.nullable().optional(),
  body: z.string().max(MARKDOWN_MAX).nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  zoom: z.number().int().min(1).max(20).nullable().optional(),
  label: z.string().trim().max(200).nullable().optional(),
  caption: z.string().trim().max(500).nullable().optional(),
  layout: z.enum(["default", "wide", "grid"]).nullable().optional()
});

const blockUpdateSchema = blockCreateSchema.omit({ chapterId: true, kind: true });

const reorderSchema = z.object({
  orderedIds: z.array(entityId).min(1).max(500)
});

// The whole tag set, replaced in one call — the editor shows every tag as a
// chip row, so "these are the tags now" is what it actually means. Blank names
// are dropped by the tag helper's normalizer.
const tagsSchema = z.object({
  tags: z.array(z.string().trim().min(1).max(80)).max(50)
});

const blockReorderSchema = reorderSchema.extend({ chapterId: entityId });

/** A narration block's clip, shaped for the reader. */
function audioView(
  block: { kind: string; entity_id: string | null },
  narration: Map<string, StoryAudioRow>,
  storyId: string
) {
  if (block.kind !== "audio" || !block.entity_id) return null;
  const clip = narration.get(block.entity_id);
  if (!clip) return null;
  return {
    id: clip.id,
    title: clip.title,
    durationSeconds: clip.duration_seconds,
    url: `/api/stories/${storyId}/audio/${clip.id}`
  };
}

// Send a narration clip, honouring a Range request so a long recording can be
// scrubbed. reply.hijack() + pipe is the house pattern for binary streaming.
export function sendNarration(request: FastifyRequest, reply: FastifyReply, audio: StoryAudioRow) {
  const filePath = narrationAbsolutePath(audio);
  if (!fs.existsSync(filePath)) {
    reply.code(404).send({ error: "Recording not found" });
    return;
  }
  const total = fs.statSync(filePath).size;
  const mime = narrationMime(audio.storage_key);
  const range = request.headers.range ? parseRangeHeader(request.headers.range, total) : null;

  if (request.headers.range && !range) {
    reply.code(416).header("Content-Range", `bytes */${total}`).send();
    return;
  }

  reply.hijack();
  if (range) {
    reply.raw.writeHead(206, {
      "Content-Type": mime,
      "Content-Length": range.end - range.start + 1,
      "Content-Range": `bytes ${range.start}-${range.end}/${total}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600"
    });
    pipeFileToReply(reply, filePath, range);
    return;
  }
  reply.raw.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": total,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600"
  });
  pipeFileToReply(reply, filePath);
}

export async function storiesPlugin(app: FastifyInstance) {
  // Load + authorize a story for a write. Members can list stories, so "exists
  // but not yours" is a plain 403 (nothing is hidden by saying so); a draft
  // someone else owns is invisible, hence 404 from the read guard below.
  const editableStory = (id: string, user: { id: string; role: string }, reply: FastifyReply): StoryRow | null => {
    const story = getStory(id);
    if (!story || !canViewStory(story, user)) {
      reply.code(404).send({ error: "Story not found" });
      return null;
    }
    if (!canEditStory(story, user)) {
      reply.code(403).send({ error: "Only the story's author or an admin can change it." });
      return null;
    }
    return story;
  };

  // A reference block may only point at something the author can actually
  // reach, so a story can never become a backdoor to hidden content. Text and
  // map blocks carry no reference and skip the check.
  const referenceIsReachable = (
    kind: StoryBlockKind,
    id: string | null | undefined,
    user: { id: string; role: string },
    storyId?: string
  ): boolean => {
    const entityType = BLOCK_ENTITY_TYPE[kind];
    if (!entityType) return true;
    if (!id) return false;
    // Narration is the story's own, so "reachable" means "belongs to this
    // story" — a clip from someone else's story can't be embedded here.
    if (entityType === STORY_AUDIO_ENTITY_TYPE) {
      return getStoryAudio(id)?.story_id === storyId;
    }
    return Boolean(hydrateEntities([{ entityType, entityId: id }], user).get(`${entityType}:${id}`)?.available);
  };

  app.get("/api/stories", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    return { stories: listStories(user, resolveGalleryScopeLibraryIds(user)) };
  });

  app.post("/api/stories", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(createSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid story details", details: parsed.error });
    }
    const story = createStory(request.user!, parsed.data.title, parsed.data.subtitle ?? null);
    logActivity({
      event: "story.created",
      actorUserId: request.user!.id,
      targetType: "story",
      targetId: story.id,
      detail: `Created story "${story.title}".`,
      ipAddress: request.ip
    });
    return reply.code(201).send({ story: { id: story.id, title: story.title, status: story.status } });
  });

  // The whole story, assembled: chapters in order, each with its blocks, every
  // reference resolved for this viewer.
  app.get("/api/stories/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const story = getStory((request.params as { id: string }).id);
    if (!story || !canViewStory(story, user)) {
      return reply.code(404).send({ error: "Story not found" });
    }
    const libIds = resolveGalleryScopeLibraryIds(user);
    const chapters = getChapters(story.id);
    const blocks = getBlocks(story.id);

    const hydrated = hydrateEntities(
      blocks
        .filter((block) => block.entity_type && block.entity_id)
        .map((block) => ({ entityType: block.entity_type!, entityId: block.entity_id! })),
      user
    );
    const assets = galleryAssetsByIds(
      user.id,
      libIds,
      blocks.filter((block) => block.kind === "media" && block.entity_id).map((block) => block.entity_id!)
    );
    const narration = storyAudioByIds(
      blocks.filter((block) => block.kind === "audio" && block.entity_id).map((block) => block.entity_id!)
    );

    const blockViews = blocks.map((block) => {
      const view = block.entity_type && block.entity_id
        ? hydrated.get(`${block.entity_type}:${block.entity_id}`)
        : undefined;
      const isReference = Boolean(BLOCK_ENTITY_TYPE[block.kind]);
      const clip = block.kind === "audio" && block.entity_id ? narration.get(block.entity_id) : undefined;
      return {
        id: block.id,
        chapterId: block.chapter_id,
        position: block.position,
        kind: block.kind,
        entityType: block.entity_type,
        entityId: block.entity_id,
        body: block.body,
        lat: block.lat,
        lng: block.lng,
        zoom: block.zoom,
        label: block.label,
        caption: block.caption,
        layout: block.layout,
        // Text and map blocks are always "available" — they carry their own
        // content and have nothing to point at.
        available: block.kind === "audio" ? Boolean(clip) : isReference ? view?.available ?? false : true,
        title: view?.title ?? null,
        subtitle: view?.subtitle ?? null,
        coverUrl: view?.coverUrl ?? null,
        itemCount: view?.fileCount ?? 0,
        href: view?.href ?? null,
        asset: block.kind === "media" && block.entity_id ? assets.get(block.entity_id) ?? null : null,
        // Narration: the clip plus a URL the reader can play it from.
        audio: audioView(block, narration, story.id),
        preview: view?.available && block.entity_id
          ? blockPreviewAssets(block.kind, block.entity_id, user.id, libIds)
          : []
      };
    });

    return reply.send({
      story: {
        id: story.id,
        title: story.title,
        subtitle: story.subtitle,
        status: story.status,
        coverItemId: story.cover_item_id,
        canEdit: canEditStory(story, user),
        createdAt: story.created_at,
        updatedAt: story.updated_at,
        previewLimit: BLOCK_PREVIEW_LIMIT,
        tags: getStoryTags(story.id),
        chapters: chapters.map((chapter) => ({
          id: chapter.id,
          position: chapter.position,
          title: chapter.title,
          date: chapter.date,
          endDate: chapter.end_date,
          dateApprox: Boolean(chapter.date_approx),
          place: chapter.place,
          placeLat: chapter.place_lat,
          placeLng: chapter.place_lng,
          description: chapter.description,
          blocks: blockViews.filter((block) => block.chapterId === chapter.id)
        }))
      }
    });
  });

  app.patch("/api/stories/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const story = editableStory((request.params as { id: string }).id, user, reply);
    if (!story) return reply;
    const parsed = parseBody(updateSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid story details", details: parsed.error });
    }
    // A cover must be a photo the author can reach, like any other reference.
    if (parsed.data.coverItemId && !referenceIsReachable("media", parsed.data.coverItemId, user)) {
      return reply.code(400).send({ error: "That photo isn't available to use as a cover." });
    }
    updateStory(story.id, parsed.data);
    return reply.send({ updated: true });
  });

  app.delete("/api/stories/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const story = editableStory((request.params as { id: string }).id, user, reply);
    if (!story) return reply;
    deleteStory(story.id);
    logActivity({
      event: "story.deleted",
      actorUserId: user.id,
      targetType: "story",
      targetId: story.id,
      detail: `Deleted story "${story.title}". The photos, albums and slideshows it used were not affected.`,
      ipAddress: request.ip
    });
    return reply.send({ deleted: true });
  });

  // Replace the story's tags. Tagging a story is how it joins the cross-type
  // tag browse alongside the photos, people and quotes that share the tag.
  app.put("/api/stories/:id/tags", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const story = editableStory((request.params as { id: string }).id, user, reply);
    if (!story) return reply;
    const parsed = parseBody(tagsSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid tags", details: parsed.error });
    }
    setEntityTags(STORY_ENTITY_TYPE, story.id, parsed.data.tags);
    return reply.send({ tags: getStoryTags(story.id) });
  });

  // Upload a narration clip for this story. It returns the clip, not a block —
  // the caller then adds an `audio` block pointing at it, the same two steps a
  // photo takes (pick, then place).
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

    const audio = await createStoryAudio(story.id, user, received.tmpPath, received.filename, received.extension);
    return reply.code(201).send({
      audio: { id: audio.id, title: audio.title, durationSeconds: audio.duration_seconds }
    });
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

  app.post("/api/stories/:id/chapters", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const story = editableStory((request.params as { id: string }).id, user, reply);
    if (!story) return reply;
    const parsed = parseBody(chapterSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid chapter details", details: parsed.error });
    }
    const chapter = createChapter(story.id, parsed.data);
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
    if (!referenceIsReachable(parsed.data.kind, parsed.data.entityId, user, story.id)) {
      return reply.code(400).send({ error: "That content isn't available to add." });
    }
    const block = createBlock(chapter.id, story.id, parsed.data.kind, parsed.data);
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
    if (parsed.data.entityId !== undefined && !referenceIsReachable(block.kind, parsed.data.entityId, user, story.id)) {
      return reply.code(400).send({ error: "That content isn't available to add." });
    }
    updateBlock(block.id, story.id, parsed.data);
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
