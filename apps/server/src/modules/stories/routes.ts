// Story endpoints. Reads are open to every member (published stories only —
// a draft belongs to its author); writes require canEditStory (creator +
// admins). Referenced content is hydrated through the subjects registry, so a
// block resolves against the VIEWER's library access and a deleted target
// degrades to an "unavailable" placeholder instead of breaking the page.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../db.js";
import { parseBody, parseQuery } from "../../core/shared.js";
import { hydrateEntities } from "../social/subjects.js";
import { resolveGalleryScopeLibraryIds } from "../library/gallery/catalog-scope.js";
import { setEntityTags } from "../library/shared/tagging.js";
import {
  STORY_AUDIO_ENTITY_TYPE,
  storyAudioByIds,
  type StoryAudioRow
} from "./audio.js";
import { getRecordingsLibrary, getStoriesSettings, setStoriesSettings } from "./settings.js";
import { importRecipeFromUrl, RecipeImportError } from "./recipe-import.js";
import { canContributeToCollection } from "./collection-access.js";
import { getCollection } from "./collections.js";
import {
  RecordingError,
  migrateLegacyNarrations,
  pendingLegacyNarrations
} from "./recordings.js";
import {
  STORY_ENTITY_TYPE,
  BOOK_ENTITY_TYPES,
  STORY_KINDS,
  STORY_STATUSES,
  BLOCK_ENTITY_TYPE,
  BLOCK_PREVIEW_LIMIT
} from "./stories.js";
import { getStory, canEditStory, canViewStory } from "./access.js";
import {
  createStory,
  updateStory,
  softDeleteStory,
  restoreStory,
  purgeStory,
  listDeletedStories,
  setStorySaved,
  isStorySaved
} from "./crud.js";
import { coverItemKind, listStories, storyRefMatches, getStoryTags } from "./list.js";
import { getChapters } from "./chapters.js";
import {
  getBlocks,
  blockPointsByIds,
  galleryAssetsByIds,
  blockPreviewAssets
} from "./blocks.js";
import { editableStory, entityId, optionalDate, referenceIsReachable } from "./route-shared.js";
import { registerStoryAudioRoutes } from "./audio-routes.js";
import { registerChapterRoutes } from "./chapter-routes.js";
import { registerBlockRoutes } from "./block-routes.js";

// Serves is free text on purpose ("4–6", "one big pot"): a number would invite
// scaling, and scaling invites the quantity model the plan rules out. Time is
// whole minutes, up to a week — a cured ham is still a recipe.
const recipeServings = z.string().trim().max(60).nullable().optional();
const recipeMinutes = z.number().int().min(1).max(7 * 24 * 60).nullable().optional();

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
  place: z.string().trim().max(200).nullable().optional(),
  // Recipe kind only (ignored otherwise): the head facts, and what a link
  // import found — plain text lines the seeded chapters open with.
  servings: recipeServings,
  cookMinutes: recipeMinutes,
  recipe: z.object({
    ingredients: z.array(z.string().trim().min(1).max(500)).max(200),
    steps: z.array(z.string().trim().min(1).max(5000)).max(100),
    sourceUrl: z.string().trim().url().max(2000).nullable()
  }).nullable().optional()
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
  // Recipe facts, mostly for recipe-shaped stories. Null clears.
  servings: recipeServings,
  cookMinutes: recipeMinutes,
  // How the story is signed. Free text: a pen name, two names, nobody.
  authorName: z.string().trim().max(120).nullable().optional(),
  // Move onto / off a shelf. Null = standalone.
  collectionId: entityId.nullable().optional()
});

// The whole tag set, replaced in one call — the editor shows every tag as a
// chip row, so "these are the tags now" is what it actually means. Blank names
// are dropped by the tag helper's normalizer.
const tagsSchema = z.object({
  tags: z.array(z.string().trim().min(1).max(80)).max(50)
});

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

export async function storiesPlugin(app: FastifyInstance) {
  app.get("/api/stories", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    return { stories: listStories(user, resolveGalleryScopeLibraryIds(user)) };
  });

  // The names this author has already signed stories with, offered when they
  // sign the next one — their account's name first, so the common case is one
  // click, then whatever pen names they have used, most-used first. Only their
  // own bylines: how somebody else signs their stories is their business.
  app.get("/api/stories/bylines", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const rows = db.prepare(`
      SELECT author_name AS name, COUNT(*) AS uses
      FROM stories
      WHERE created_by = ? AND deleted_at IS NULL AND author_name IS NOT NULL AND TRIM(author_name) <> ''
      GROUP BY author_name
      ORDER BY uses DESC, author_name COLLATE NOCASE
      LIMIT 20
    `).all(user.id) as { name: string; uses: number }[];
    const used = rows.map((row) => row.name);
    return {
      bylines: used.some((name) => name.toLowerCase() === user.display_name.toLowerCase())
        ? used
        : [user.display_name, ...used]
    };
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

  const referencingQuerySchema = z.object({ type: z.string().optional(), id: z.string().optional() });

  app.get("/api/stories/referencing", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseQuery(referencingQuerySchema, request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid reference query", details: parsed.error });
    }
    const qp = parsed.data;
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
      recipeImportEnabled: getStoriesSettings().recipeImportEnabled,
      isAdmin: user.role === "admin",
      ...(user.role === "admin" ? { pendingNarrations: pendingLegacyNarrations() } : {})
    };
  });

  // The recordings library is no longer set here: it is the house's "Made in
  // the app" library (Control → Library → Storage), read through.
  const settingsSchema = z.object({
    recipeImportEnabled: z.boolean().optional()
  });

  app.put("/api/stories/settings", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(settingsSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid settings", details: parsed.error });
    }
    const changes: string[] = [];
    if (parsed.data.recipeImportEnabled !== undefined) {
      setStoriesSettings({ recipeImportEnabled: parsed.data.recipeImportEnabled }, request.user!.id);
      changes.push(parsed.data.recipeImportEnabled ? "Allowed recipe import from a link." : "Turned off recipe import from a link.");
    }
    if (changes.length > 0) {
      logActivity({
        event: "config.updated",
        actorUserId: request.user!.id,
        targetType: "setting",
        targetId: "stories_settings",
        detail: changes.join(" "),
        ipAddress: request.ip
      });
    }
    const library = getRecordingsLibrary();
    return reply.send({
      recordingsLibrary: library ? { id: library.id, name: library.name } : null,
      recipeImportEnabled: getStoriesSettings().recipeImportEnabled,
      isAdmin: true,
      pendingNarrations: pendingLegacyNarrations()
    });
  });

  // ── Recipe from a link ──
  // Reads one page the member names and returns its schema.org Recipe as
  // plain lines; the New story dialog then creates the story with them.
  // Nothing is stored here, and nothing but the page text is fetched. Rate
  // limited like the other outbound fetchers: this is a member-triggered
  // request to an arbitrary host.
  const importRecipeSchema = z.object({ url: z.string().trim().min(1).max(2000) });

  app.post("/api/stories/import-recipe", {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    if (!getStoriesSettings().recipeImportEnabled) {
      return reply.code(403).send({ error: "Importing recipes from a link is turned off." });
    }
    const parsed = parseBody(importRecipeSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid link", details: parsed.error });
    }
    try {
      const recipe = await importRecipeFromUrl(parsed.data.url);
      logActivity({
        event: "story.recipe_imported",
        actorUserId: request.user!.id,
        targetType: "story",
        targetId: null,
        detail: `Read a recipe from ${new URL(recipe.sourceUrl).hostname}.`,
        ipAddress: request.ip
      });
      return reply.send({ recipe });
    } catch (err) {
      if (err instanceof RecipeImportError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
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
    const isRecipe = parsed.data.kind === "recipe";
    const story = createStory(request.user!, parsed.data.title, parsed.data.subtitle ?? null, collectionId, {
      kind: parsed.data.kind,
      reviewOf,
      date: parsed.data.date ?? null,
      endDate: parsed.data.endDate ?? null,
      place: parsed.data.place ?? null,
      servings: isRecipe ? parsed.data.servings || null : null,
      cookMinutes: isRecipe ? parsed.data.cookMinutes ?? null : null,
      recipe: isRecipe ? parsed.data.recipe ?? null : null
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

    // A map block's stops, fetched for the whole story in one go.
    const blockPoints = blockPointsByIds(blocks.filter((block) => block.kind === "map").map((block) => block.id));

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
        points: blockPoints.get(block.id) ?? [],
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

    // The cover is usually a photo; on a review it may be the book's own
    // artwork, which lives outside the gallery hydration above.
    const coverAsset = story.cover_item_id ? assets.get(story.cover_item_id) ?? null : null;
    const coverBookType = !coverAsset && story.cover_item_id ? coverItemKind(story.cover_item_id) : null;
    const coverBook = coverBookType === "audiobook" || coverBookType === "ebook"
      ? hydrateEntities([{ entityType: coverBookType, entityId: story.cover_item_id! }], user)
        .get(`${coverBookType}:${story.cover_item_id}`)
      : undefined;

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
        servings: story.servings,
        cookMinutes: story.cook_minutes,
        authorName: story.author_name,
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
        cover: coverAsset,
        // What to actually draw: the photo's own URL, or the book's artwork.
        // Null covers both "nothing chosen" and "chosen, but out of reach".
        coverUrl: coverAsset?.coverUrl ?? (coverBook?.available ? coverBook.coverUrl : null) ?? null,
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
    // A cover must be something the author can reach, like any other
    // reference: a photo, or — on a review — the book's own artwork.
    if (parsed.data.coverItemId) {
      const kind = coverItemKind(parsed.data.coverItemId);
      const reachable = kind === "gallery"
        ? referenceIsReachable("media", parsed.data.coverItemId, user)
        : kind
          ? referenceIsReachable("book", parsed.data.coverItemId, user, kind)
          : false;
      if (!reachable) {
        return reply.code(400).send({ error: "That cover isn't available to use." });
      }
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
  const saveSchema = z.object({ saved: z.boolean() });

  app.put("/api/stories/:id/save", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const story = getStory((request.params as { id: string }).id);
    if (!story || !canViewStory(story, user)) {
      return reply.code(404).send({ error: "Story not found" });
    }
    const parsed = parseBody(saveSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "saved must be a boolean", details: parsed.error });
    }
    setStorySaved(story.id, user.id, parsed.data.saved);
    return reply.send({ saved: parsed.data.saved });
  });

  // The routes for a story's parts, on this same instance.
  registerStoryAudioRoutes(app);
  registerChapterRoutes(app);
  registerBlockRoutes(app);
}
