// Story endpoints. Reads are open to every member (published stories only —
// a draft belongs to its author); writes require canEditStory (creator +
// admins). Referenced content is hydrated through the subjects registry, so a
// block resolves against the VIEWER's library access and a deleted target
// degrades to an "unavailable" placeholder instead of breaking the page.
import fs from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../db.js";
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
  getStoryAudio,
  storyAudioByIds,
  narrationAbsolutePath,
  narrationMime,
  narrationTempDir,
  type StoryAudioRow
} from "./audio.js";
import { ensureAudioScanExtensions, getRecordingsLibrary, setStoriesSettings } from "./settings.js";
import { canContributeToCollection } from "./collection-access.js";
import { getCollection } from "./collections.js";
import {
  RecordingError,
  migrateLegacyNarrations,
  pendingLegacyNarrations,
  storeRecording
} from "./recordings.js";
import {
  STORY_ENTITY_TYPE,
  STORY_BLOCK_KINDS,
  BOOK_ENTITY_TYPES,
  STORY_KINDS,
  STORY_STATUSES,
  BLOCK_ENTITY_TYPE,
  BLOCK_PREVIEW_LIMIT,
  getStory,
  canEditStory,
  canViewStory,
  createStory,
  updateStory,
  softDeleteStory,
  restoreStory,
  purgeStory,
  listDeletedStories,
  listStories,
  setStorySaved,
  isStorySaved,
  storyRefMatches,
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
  subtitle: z.string().trim().max(300).nullable().optional(),
  // Born onto a shelf: needs contributor rights there ("Add story" on the
  // collection page, or the picker at creation).
  collectionId: entityId.nullable().optional(),
  // The creation template. Never changes what the story may become.
  kind: z.enum(STORY_KINDS).optional(),
  // "Write a review" from a book page: the card the review opens on.
  reviewOf: z.object({
    entityType: z.enum(BOOK_ENTITY_TYPES),
    entityId
  }).nullable().optional(),
  // Seeds the first chapter (a journal with a full from–to range seeds one
  // chapter per day). All ordinary chapter fields afterwards.
  date: optionalDate,
  endDate: optionalDate,
  place: z.string().trim().max(200).nullable().optional()
});

const updateSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  subtitle: z.string().trim().max(300).nullable().optional(),
  status: z.enum(STORY_STATUSES).optional(),
  coverItemId: entityId.nullable().optional(),
  // Authored text ("Day", "Stop"), NOT translated — it belongs to the story.
  chapterNoun: z.string().trim().max(30).nullable().optional(),
  intro: z.string().trim().max(5000).nullable().optional(),
  // Stars, mostly for review-shaped stories. Null clears.
  rating: z.number().int().min(1).max(5).nullable().optional(),
  // Move onto / off a shelf. Null = standalone.
  collectionId: entityId.nullable().optional()
});

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
  caption: z.string().trim().max(500).nullable().optional(),
  layout: z.enum(["default", "wide", "grid"]).nullable().optional()
});

// A block's kind — and a book block's chosen type — are settled at creation.
const blockUpdateSchema = blockCreateSchema.omit({ chapterId: true, kind: true, entityType: true });

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

/** A narration block's clip, shaped for the reader. Two shapes coexist: a
 *  gallery-backed recording (entity_type 'gallery', the v2 model — per-viewer
 *  filtered like any asset) and a legacy story-owned clip ('story_audio',
 *  serving until the one-time import moves it into the recordings library). */
function audioView(
  block: { kind: string; entity_type: string | null; entity_id: string | null },
  narration: Map<string, StoryAudioRow>,
  assets: Map<string, { id: string; title: string; durationSeconds: number | null; playbackUrl: string }>,
  storyId: string
) {
  if (block.kind !== "audio" || !block.entity_id) return null;
  if (block.entity_type === "gallery") {
    const asset = assets.get(block.entity_id);
    if (!asset) return null;
    return {
      id: asset.id,
      title: asset.title,
      durationSeconds: asset.durationSeconds,
      url: asset.playbackUrl
    };
  }
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
    // Book blocks carry their own type; everything else derives it from kind.
    explicitType?: string | null
  ): boolean => {
    const entityType = explicitType ?? BLOCK_ENTITY_TYPE[kind];
    if (!entityType) return true;
    if (!id) return false;
    // Audio validates as a gallery asset here (the v2 model — a new block can
    // only ever reference a library recording). Legacy 'story_audio' rows are
    // read-path only: nothing can create or re-point one any more.
    return Boolean(hydrateEntities([{ entityType, entityId: id }], user).get(`${entityType}:${id}`)?.available);
  };

  app.get("/api/stories", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    return { stories: listStories(user, resolveGalleryScopeLibraryIds(user)) };
  });

  // Back-links: the stories whose blocks reference an entity — "Reviews &
  // stories" on a book page, "Stories featuring…" on a person, "Appears in…"
  // on an album. Same visibility rule and card shape as the index. For a book
  // the net is the whole WORK (every edition, both book types): a review is
  // about the story, not the file — each card then says which edition it
  // actually referenced.
  const REFERENCING_TYPES = new Set([
    "audiobook", "ebook", "family_tree_person", "gallery_album", "gallery_slideshow"
  ]);

  app.get("/api/stories/referencing", { preHandler: app.authenticate }, async (request, reply) => {
    const qp = request.query as { type?: string; id?: string };
    const type = qp.type ?? "";
    const id = (qp.id ?? "").trim();
    if (!REFERENCING_TYPES.has(type) || !id || id.length > 64) {
      return reply.code(400).send({ error: "Invalid reference query" });
    }

    let entityTypes = [type];
    let entityIds = [id];
    if (type === "audiobook" || type === "ebook") {
      const work = db.prepare("SELECT work_id FROM work_items WHERE item_id = ?").get(id) as { work_id: string } | undefined;
      if (work) {
        entityIds = (db.prepare("SELECT item_id FROM work_items WHERE work_id = ?").all(work.work_id) as { item_id: string }[])
          .map((row) => row.item_id);
      }
      entityTypes = ["audiobook", "ebook"];
    }

    const user = request.user!;
    const stories = listStories(user, resolveGalleryScopeLibraryIds(user), undefined, { entityTypes, entityIds });
    const matches = storyRefMatches(stories.map((story) => story.id), entityTypes, entityIds);
    return reply.send({
      stories: stories.map((story) => ({
        ...story,
        refEntityType: matches.get(story.id)?.entityType ?? null
      }))
    });
  });

  // ── Recordings-library setting (Control → Settings → Stories) ──
  // Readable by every member: the story editor asks it whether Record/Upload
  // should appear at all. Only admins learn about the legacy-clip backlog.
  app.get("/api/stories/settings", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const library = getRecordingsLibrary();
    return {
      recordingsLibrary: library ? { id: library.id, name: library.name } : null,
      isAdmin: user.role === "admin",
      ...(user.role === "admin" ? { pendingNarrations: pendingLegacyNarrations() } : {})
    };
  });

  const settingsSchema = z.object({
    recordingsLibraryId: z.string().trim().min(1).max(64).nullable()
  });

  app.put("/api/stories/settings", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(settingsSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid settings", details: parsed.error });
    }
    const id = parsed.data.recordingsLibraryId;
    // Choosing a library also opts it into audio — its scan extensions gate
    // both uploads and what a rescan keeps.
    if (id != null && !ensureAudioScanExtensions(id)) {
      return reply.code(404).send({ error: "That gallery library doesn't exist." });
    }
    setStoriesSettings({ recordingsLibraryId: id }, request.user!.id);
    const library = getRecordingsLibrary();
    logActivity({
      event: "config.updated",
      actorUserId: request.user!.id,
      targetType: "setting",
      targetId: "stories_settings",
      detail: library ? `Set the story recordings library to "${library.name}".` : "Cleared the story recordings library.",
      ipAddress: request.ip
    });
    return reply.send({
      recordingsLibrary: library ? { id: library.id, name: library.name } : null,
      isAdmin: true,
      pendingNarrations: pendingLegacyNarrations()
    });
  });

  // One-time import of the legacy story-owned clips into the recordings
  // library. Safe to re-run: a clip that fails stays put and stays counted.
  app.post("/api/stories/settings/migrate-narrations", { preHandler: app.requireAdmin }, async (request, reply) => {
    try {
      return reply.send(await migrateLegacyNarrations(request.user!.id));
    } catch (err) {
      if (err instanceof RecordingError) { return reply.code(err.statusCode).send({ error: err.message }); }
      throw err;
    }
  });

  app.post("/api/stories", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(createSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid story details", details: parsed.error });
    }
    const collectionId = parsed.data.collectionId ?? null;
    if (collectionId && (!getCollection(collectionId) || !canContributeToCollection(request.user!, collectionId))) {
      return reply.code(403).send({ error: "You can't add stories to that collection." });
    }
    // A seeded review card is a reference like any other: only a book the
    // author can actually reach.
    const reviewOf = parsed.data.kind === "review" ? parsed.data.reviewOf ?? null : null;
    if (reviewOf && !referenceIsReachable("book", reviewOf.entityId, request.user!, reviewOf.entityType)) {
      return reply.code(400).send({ error: "That book isn't available to review." });
    }
    const story = createStory(request.user!, parsed.data.title, parsed.data.subtitle ?? null, collectionId, {
      kind: parsed.data.kind,
      reviewOf,
      date: parsed.data.date ?? null,
      endDate: parsed.data.endDate ?? null,
      place: parsed.data.place ?? null
    });
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
    // Gallery-backed blocks: media, and audio blocks in the v2 shape (a
    // recording in the recordings library — filtered by this viewer's access
    // like any other asset).
    const assets = galleryAssetsByIds(
      user.id,
      libIds,
      [
        ...blocks
          .filter((block) => block.entity_id
            && (block.kind === "media" || (block.kind === "audio" && block.entity_type === "gallery")))
          .map((block) => block.entity_id!),
        // Chapter-page heroes and the story cover ride the same per-viewer
        // hydration.
        ...chapters.filter((chapter) => chapter.hero_item_id).map((chapter) => chapter.hero_item_id!),
        ...(story.cover_item_id ? [story.cover_item_id] : [])
      ]
    );
    // Legacy story-owned clips, serving until the one-time import moves them.
    const narration = storyAudioByIds(
      blocks
        .filter((block) => block.kind === "audio" && block.entity_type === STORY_AUDIO_ENTITY_TYPE && block.entity_id)
        .map((block) => block.entity_id!)
    );

    const blockViews = blocks.map((block) => {
      const view = block.entity_type && block.entity_id
        ? hydrated.get(`${block.entity_type}:${block.entity_id}`)
        : undefined;
      const isReference = Boolean(BLOCK_ENTITY_TYPE[block.kind]);
      const audio = audioView(block, narration, assets, story.id);
      return {
        id: block.id,
        chapterId: block.chapter_id,
        position: block.position,
        kind: block.kind,
        entityType: block.entity_type,
        entityId: block.entity_id,
        body: block.body,
        heading: block.heading,
        lat: block.lat,
        lng: block.lng,
        zoom: block.zoom,
        label: block.label,
        caption: block.caption,
        layout: block.layout,
        // Text and map blocks are always "available" — they carry their own
        // content and have nothing to point at.
        available: block.kind === "audio" ? Boolean(audio) : isReference ? view?.available ?? false : true,
        title: view?.title ?? null,
        subtitle: view?.subtitle ?? null,
        coverUrl: view?.coverUrl ?? null,
        itemCount: view?.fileCount ?? 0,
        href: view?.href ?? null,
        asset: block.kind === "media" && block.entity_id ? assets.get(block.entity_id) ?? null : null,
        // Narration: the clip plus a URL the reader can play it from.
        audio,
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
        chapterNoun: story.chapter_noun,
        intro: story.intro,
        rating: story.rating,
        kind: story.kind,
        saved: isStorySaved(story.id, user.id),
        collectionId: story.collection_id,
        // The shelf's name for the site view's breadcrumb and the editor's
        // picker label; the id alone would make the client fetch the list.
        collection: (() => {
          const shelf = story.collection_id ? getCollection(story.collection_id) : undefined;
          return shelf ? { id: shelf.id, title: shelf.title } : null;
        })(),
        // The chosen cover resolved for this viewer — the Story Home hero.
        cover: story.cover_item_id ? assets.get(story.cover_item_id) ?? null : null,
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
          standfirst: chapter.standfirst,
          heroItemId: chapter.hero_item_id,
          heroMap: Boolean(chapter.hero_map),
          // The hero resolved for THIS viewer; null when unset or out of reach
          // (the page then falls back to text-on-ground).
          hero: chapter.hero_item_id ? assets.get(chapter.hero_item_id) ?? null : null,
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
    // Moving ONTO a shelf needs contributor rights there; moving off one only
    // needs edit rights on the story, which this route already has.
    if (parsed.data.collectionId != null
      && parsed.data.collectionId !== story.collection_id
      && (!getCollection(parsed.data.collectionId) || !canContributeToCollection(user, parsed.data.collectionId))) {
      return reply.code(403).send({ error: "You can't add stories to that collection." });
    }
    updateStory(story.id, parsed.data);
    return reply.send({ updated: true });
  });

  // "Delete" moves the story to the Recycle Bin, where an admin can restore
  // it until its retention window runs out. Guest links and tags go dark with
  // it and come back on restore; the media it references was never its own.
  app.delete("/api/stories/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const story = editableStory((request.params as { id: string }).id, user, reply);
    if (!story) return reply;
    softDeleteStory(story.id);
    logActivity({
      event: "story.deleted",
      actorUserId: user.id,
      targetType: "story",
      targetId: story.id,
      detail: `Moved story "${story.title}" to the Recycle Bin. The photos, albums and slideshows it used were not affected.`,
      ipAddress: request.ip
    });
    return reply.send({ deleted: true });
  });

  // ── The Recycle Bin's story rows (admin — it lives in the control panel) ──

  app.get("/api/stories/trash", { preHandler: app.requireAdmin }, async (_request, reply) => {
    return reply.send({ stories: listDeletedStories() });
  });

  app.post("/api/stories/trash/:id/restore", { preHandler: app.requireAdmin }, async (request, reply) => {
    const user = request.user!;
    const story = getStory((request.params as { id: string }).id);
    if (!story || !story.deleted_at) {
      return reply.code(404).send({ error: "Story not found in the Recycle Bin" });
    }
    restoreStory(story.id);
    logActivity({
      event: "story.restored",
      actorUserId: user.id,
      targetType: "story",
      targetId: story.id,
      detail: `Restored story "${story.title}" from the Recycle Bin.`,
      ipAddress: request.ip
    });
    return reply.send({ restored: true });
  });

  app.delete("/api/stories/trash/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const user = request.user!;
    const story = getStory((request.params as { id: string }).id);
    // Only rows already in the bin purge here — the normal delete route is the
    // only door into it, so "delete forever" can never skip the bin.
    if (!story || !story.deleted_at) {
      return reply.code(404).send({ error: "Story not found in the Recycle Bin" });
    }
    purgeStory(story.id);
    logActivity({
      event: "story.purged",
      actorUserId: user.id,
      targetType: "story",
      targetId: story.id,
      detail: `Permanently deleted story "${story.title}" from the Recycle Bin.`,
      ipAddress: request.ip
    });
    return reply.send({ purged: true });
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

  // Favorite / unfavorite. Any viewer can save a story they can see — it's a
  // personal bookmark, not a change to the story, so canView is the whole
  // permission check.
  app.put("/api/stories/:id/save", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const story = getStory((request.params as { id: string }).id);
    if (!story || !canViewStory(story, user)) {
      return reply.code(404).send({ error: "Story not found" });
    }
    const body = request.body as { saved?: unknown } | null;
    if (!body || typeof body.saved !== "boolean") {
      return reply.code(400).send({ error: "saved must be a boolean" });
    }
    setStorySaved(story.id, user.id, body.saved);
    return reply.send({ saved: body.saved });
  });

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
    if (parsed.data.entityId !== undefined
      && !referenceIsReachable(block.kind, parsed.data.entityId, user, block.kind === "book" ? block.entity_type : undefined)) {
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
