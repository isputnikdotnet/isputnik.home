// Slideshow endpoints. Reads are open to every member (items filtered per viewer's
// library access); writes require canEditSlideshow (creator + admins). Batch bodies
// follow the bulk contract: inaccessible items are skipped and counted. Sibling of
// album-routes.ts; the extra endpoint here is reorder (albums shipped without it).
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { deleteStoryBlocksForResource } from "../../stories/cleanup.js";
import { resolveGalleryScopeLibraryIds } from "./catalog.js";
import {
  getSlideshow,
  canEditSlideshow,
  createSlideshow,
  updateSlideshow,
  deleteSlideshow,
  addSlideshowItems,
  removeSlideshowItems,
  reorderSlideshowItems,
  listSlideshows,
  getSlideshowItems,
  getSlideshowRenderItems,
  getClipRenderItem,
  setSlideshowSaveError,
  summarize,
  type SlideshowRow,
  type MovieConflictPolicy
} from "./slideshows.js";
import { getMusicTrack, summarizeTrack } from "./music.js";
import path from "node:path";
import { validateLibrarySource } from "../shared/library-source.js";
import {
  enqueueSlideshowRender,
  renderProgressPercent,
  deleteSlideshowRender,
  presentRenderItems,
  slideshowTitleCardPreview,
  slideshowClosingCardPreview,
  saveMovieToLibrary,
  movieRelativePathFor,
  movieStemFor,
  foreignItemAt
} from "./slideshow-render.js";
import { parseRangeHeader, pipeFileToReply } from "../shared/document-stream.js";
import { sourceIsWritable } from "../shared/library-source.js";
import { canUserWriteLibrary } from "../shared/library-access.js";
import type { LibraryListRow } from "../shared/library-serializer.js";
import { thumbnailAbsolutePath } from "../shared/thumbnail.js";
import fs from "node:fs";

// How wide the title-card preview is drawn. The card itself is 1920 wide; this is a
// dialog-sized look at it, not the frame the movie carries.
const PREVIEW_WIDTH = 800;

// Render state a detail response carries. `movieUrl` is present only when a movie is
// ready; `percent` is the live encode progress while rendering.
function renderFields(slideshow: SlideshowRow) {
  return {
    renderStatus: slideshow.render_status,
    // A ready movie that predates a later edit — shown, but flagged for a re-render.
    renderStale: slideshow.render_status === "ready" && slideshow.render_stale === 1,
    renderError: slideshow.render_error,
    renderPercent: slideshow.render_status === "rendering" || slideshow.render_status === "queued"
      ? renderProgressPercent(slideshow.render_job_id)
      : null,
    renderedAt: slideshow.rendered_at,
    outputBytes: slideshow.render_status === "ready" ? slideshow.output_bytes : null,
    // The movie URL is per-slideshow, but a re-render overwrites the file in place —
    // so version it by rendered_at, otherwise the browser keeps serving the previous
    // render (e.g. the one made before music was added) from cache.
    movieUrl: slideshow.render_status === "ready" && slideshow.output_storage_key
      ? `/api/library/gallery/slideshows/${slideshow.id}/movie?v=${encodeURIComponent(slideshow.rendered_at ?? "")}`
      : null,
    // Whether the latest render was saved into a gallery library (so the delete
    // confirmation can note the movie item is kept).
    movieSavedToLibrary: Boolean(slideshow.movie_library_id && slideshow.movie_item_id)
  };
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  // Optional: seed the slideshow with items in one call (the "create from memory"
  // flow). Skipped items follow the usual bulk contract.
  itemIds: z.array(z.string().trim().min(1).max(64)).max(500).optional(),
  sourceKind: z.enum(["manual", "memory", "album"]).optional(),
  sourceRef: z.string().trim().max(120).nullable().optional()
});

// Multi-line card text (the opening card's custom second line, the closing card's
// credits): up to 6 lines of 120 characters, 500 in all — the caps the drawer
// draws to (splitCardLines caps defensively; this is what stops an over-long value
// being SAVED). Whitespace-only lines don't count against the line cap because the
// drawer drops them.
const cardLinesSchema = z.string().trim().max(500)
  .refine((value) => value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).length <= 6,
    { message: "At most 6 lines" })
  .refine((value) => value.split(/\r?\n/).every((l) => l.trim().length <= 120),
    { message: "Each line at most 120 characters" })
  .nullable().optional();

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  transition: z.enum(["none", "crossfade", "fade", "slide", "kenburns", "dipblack", "random"]).optional(),
  slideSeconds: z.number().min(1).max(30).optional(),
  transitionSeconds: z.number().min(0.5).max(5).optional(),
  // null clears the music; a string selects a track (validated below).
  musicTrackId: z.string().trim().min(1).max(64).nullable().optional(),
  // The movie's opening card. Every nullable field here means "back to the default":
  // the slideshow's name, no custom subtitle, the first slide as the background photo.
  titleEnabled: z.boolean().optional(),
  titleText: z.string().trim().max(120).nullable().optional(),
  titleSubtitleMode: z.enum(["count", "custom", "none"]).optional(),
  titleSubtitle: cardLinesSchema,
  titleSeconds: z.number().min(1).max(15).optional(),
  titleBackground: z.enum(["black", "photo", "blur", "collage"]).optional(),
  titlePhotoItemId: z.string().trim().min(1).max(64).nullable().optional(),
  cardFont: z.enum(["classic", "serif", "bold", "script", "typewriter"]).optional(),
  cardSize: z.enum(["small", "medium", "large"]).optional(),
  // The closing card. Same nullable contract: null = back to the default ("The
  // End", no credits, the first slide as the background photo).
  closingEnabled: z.boolean().optional(),
  closingText: z.string().trim().max(120).nullable().optional(),
  closingLines: cardLinesSchema,
  closingSeconds: z.number().min(1).max(15).optional(),
  closingBackground: z.enum(["black", "photo", "blur", "collage"]).optional(),
  closingPhotoItemId: z.string().trim().min(1).max(64).nullable().optional(),
  // The post-credit clip: any gallery VIDEO the caller can access (validated in
  // the handler) — deliberately NOT restricted to slideshow members, since a clip
  // like this is usually shot for the purpose rather than part of the show.
  outroItemId: z.string().trim().min(1).max(64).nullable().optional(),
  // Whether the clip's own audio plays (music pausing under it). On by default.
  outroSound: z.boolean().optional(),
  // Where a finished movie is filed. null = don't save, the default. The library is
  // checked for BOTH write permission and a writable source folder in the handler.
  movieTargetLibraryId: z.string().trim().min(1).max(64).nullable().optional(),
  movieOnConflict: z.enum(["overwrite", "keep_both"]).optional(),
  // Rename: the filename stem without ".mp4". null puts it back on the slideshow's name.
  movieFileStem: z.string().trim().min(1).max(120).nullable().optional(),
  coverItemId: z.string().trim().min(1).max(64).nullable().optional()
});

// The title-card fields a detail response carries, in the same shape the PATCH takes.
function titleFields(slideshow: SlideshowRow) {
  return {
    titleEnabled: slideshow.title_enabled === 1,
    titleText: slideshow.title_text,
    titleSubtitleMode: slideshow.title_subtitle_mode,
    titleSubtitle: slideshow.title_subtitle,
    titleSeconds: slideshow.title_seconds,
    titleBackground: slideshow.title_background,
    titlePhotoItemId: slideshow.title_photo_item_id,
    cardFont: slideshow.card_font,
    cardSize: slideshow.card_size,
    closingEnabled: slideshow.closing_enabled === 1,
    closingText: slideshow.closing_text,
    closingLines: slideshow.closing_lines,
    closingSeconds: slideshow.closing_seconds,
    closingBackground: slideshow.closing_background,
    closingPhotoItemId: slideshow.closing_photo_item_id,
    outroSound: slideshow.outro_sound === 1
  };
}

// Where this slideshow files its movie, as the editor shows it. movieFileName is the
// name the NEXT save would use, so the editor never has to guess it.
function movieTargetFields(slideshow: SlideshowRow) {
  return {
    movieTargetLibraryId: slideshow.movie_target_library_id,
    movieOnConflict: slideshow.movie_on_conflict,
    movieFileStem: slideshow.movie_file_stem,
    movieFileName: `${movieStemFor(slideshow)}.mp4`,
    movieSaveError: slideshow.movie_save_error
  };
}

// A library is a usable movie target only if the caller can write it AND its folder is
// writable. Returns an error message, or null when it is fine.
function movieTargetProblem(libraryId: string, user: { id: string; role: string }): string | null {
  const row = db.prepare("SELECT * FROM libraries WHERE id = ? AND type = 'gallery'").get(libraryId) as LibraryListRow | undefined;
  if (!row) return "That gallery library no longer exists.";
  if (!canUserWriteLibrary(row, user.id, user.role)) return "You don't have permission to add to that library.";
  const writable = sourceIsWritable(row.source_path);
  return writable.ok ? null : writable.reason;
}

// The post-credit clip as the editor shows it: enough to draw a row (thumb,
// name, length) without another request. Resolved against the VIEWER's access, the
// same way the render resolves it against the renderer's — null when the clip is
// gone or out of reach, and the editor then offers to choose one.
function clipSummary(libIds: string[], itemId: string | null) {
  if (!itemId || libIds.length === 0) return null;
  const row = db.prepare(`
    SELECT library_items.id AS id, item_metadata.title AS title,
           item_metadata.cover_storage_key AS cover_key,
           gallery_details.duration_seconds AS duration_seconds
    FROM library_items
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
    WHERE library_items.id = ? AND library_items.deleted_at IS NULL
      AND gallery_details.kind = 'video'
      AND library_items.library_id IN (${Array(libIds.length).fill("?").join(", ")})
  `).get(itemId, ...libIds) as { id: string; title: string | null; cover_key: string | null; duration_seconds: number | null } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    title: row.title ?? "Video",
    coverUrl: row.cover_key ? `/api/library/covers/${row.cover_key}` : null,
    durationSeconds: row.duration_seconds
  };
}

// The music fields a detail response carries, resolved from music_track_id. null
// everywhere when the slideshow has no music (or the track was deleted).
function musicFields(musicTrackId: string | null) {
  if (!musicTrackId) return { musicTrackId: null, musicTitle: null, musicUrl: null };
  const track = getMusicTrack(musicTrackId);
  if (!track) return { musicTrackId: null, musicTitle: null, musicUrl: null };
  const summary = summarizeTrack(track);
  return { musicTrackId: track.id, musicTitle: track.title, musicUrl: summary.url };
}

const itemsSchema = z.object({
  itemIds: z.array(z.string().trim().min(1).max(64)).min(1).max(500)
});

const reorderSchema = z.object({
  itemIds: z.array(z.string().trim().min(1).max(64)).min(1).max(2000)
});

export async function gallerySlideshowRoutesPlugin(app: FastifyInstance) {
  // Load + authorize a slideshow for a write. A clear 403 (rather than a uniform
  // 404) is friendlier and leaks nothing — slideshows are listable to members.
  const editable = (id: string, user: { id: string; role: string }, reply: FastifyReply): SlideshowRow | null => {
    const slideshow = getSlideshow(id);
    if (!slideshow) {
      reply.code(404).send({ error: "Slideshow not found" });
      return null;
    }
    if (!canEditSlideshow(slideshow, user)) {
      reply.code(403).send({ error: "Only the slideshow's creator or an admin can change it." });
      return null;
    }
    return slideshow;
  };

  app.get("/api/library/gallery/slideshows", { preHandler: app.authenticate }, async (request) => {
    const libIds = resolveGalleryScopeLibraryIds(request.user!);
    return { slideshows: listSlideshows(request.user!, libIds) };
  });

  // The libraries a movie could be filed into: gallery libraries this caller can write,
  // whose source folder is actually writable. Both checks matter and they fail differently
  // — permission is per user, a read-only mount is per install — so each unusable library
  // is returned WITH its reason rather than omitted, or the picker silently loses entries
  // and nobody can tell why. (Static path — Fastify routes this ahead of "/:id" below.)
  app.get("/api/library/gallery/slideshows/settings", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const rows = db.prepare("SELECT * FROM libraries WHERE type = 'gallery' ORDER BY name COLLATE NOCASE").all() as LibraryListRow[];
    const libraries = rows.map((row) => {
      const canWrite = canUserWriteLibrary(row, user.id, user.role);
      const writable = canWrite ? sourceIsWritable(row.source_path) : { ok: true as const };
      return {
        id: row.id,
        name: row.name,
        canWrite,
        writable: canWrite && writable.ok,
        reason: !canWrite ? "permission" : writable.ok ? null : "readonly"
      };
    });
    return { libraries };
  });

  app.post("/api/library/gallery/slideshows", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(createSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid slideshow details", details: parsed.error });
    }
    const user = request.user!;
    const slideshow = createSlideshow(user, parsed.data.name, { kind: parsed.data.sourceKind, ref: parsed.data.sourceRef });
    let added = 0;
    if (parsed.data.itemIds && parsed.data.itemIds.length > 0) {
      const libIds = new Set(resolveGalleryScopeLibraryIds(user));
      added = addSlideshowItems(slideshow.id, libIds, parsed.data.itemIds).added;
    }
    logActivity({
      event: "gallery.slideshow.created",
      actorUserId: user.id,
      targetType: "gallery_slideshow",
      targetId: slideshow.id,
      detail: `Created gallery slideshow "${slideshow.name}"${added > 0 ? ` with ${added} photo${added === 1 ? "" : "s"}` : ""}.`,
      ipAddress: request.ip
    });
    return reply.code(201).send({ slideshow: summarize(slideshow, added, null, true) });
  });

  // Slideshow detail: metadata + one page of the viewer's visible items in order.
  app.get("/api/library/gallery/slideshows/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const slideshow = getSlideshow((request.params as { id: string }).id);
    const user = request.user!;
    if (!slideshow) {
      return reply.code(404).send({ error: "Slideshow not found" });
    }
    const qp = request.query as { limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number.parseInt(qp.limit ?? "200", 10) || 200, 1), 500);
    const offset = Math.max(Number.parseInt(qp.offset ?? "0", 10) || 0, 0);
    const libIds = resolveGalleryScopeLibraryIds(user);
    const { assets, total } = getSlideshowItems(user.id, libIds, slideshow, limit, offset);
    // A member who can't see any of the items shouldn't learn the slideshow exists.
    if (total === 0 && !canEditSlideshow(slideshow, user)) {
      return reply.code(404).send({ error: "Slideshow not found" });
    }
    return reply.send({
      slideshow: {
        id: slideshow.id,
        name: slideshow.name,
        transition: slideshow.transition,
        slideSeconds: slideshow.slide_seconds,
        transitionSeconds: slideshow.transition_seconds,
        coverItemId: slideshow.cover_item_id,
        canEdit: canEditSlideshow(slideshow, user),
        updatedAt: slideshow.updated_at,
        ...titleFields(slideshow),
        ...movieTargetFields(slideshow),
        outroClip: clipSummary(libIds, slideshow.outro_item_id),
        ...musicFields(slideshow.music_track_id),
        ...renderFields(slideshow)
      },
      assets,
      total
    });
  });

  // Enqueue an MP4 render (editors only). Returns immediately; the worker encodes in
  // the background and the detail's renderStatus/renderPercent track it.
  app.post("/api/library/gallery/slideshows/:id/render", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const slideshow = editable((request.params as { id: string }).id, user, reply);
    if (!slideshow) return reply;
    if (slideshow.render_status === "queued" || slideshow.render_status === "rendering") {
      return reply.send({ renderStatus: slideshow.render_status });
    }
    const hasPhotos = getSlideshowItems(user.id, resolveGalleryScopeLibraryIds(user), slideshow, 1, 0).total > 0;
    if (!hasPhotos) {
      return reply.code(400).send({ error: "Add at least one photo before rendering a movie." });
    }
    enqueueSlideshowRender(slideshow, user.id);
    logActivity({
      event: "gallery.slideshow.render",
      actorUserId: user.id,
      targetType: "gallery_slideshow",
      targetId: slideshow.id,
      detail: `Started rendering a movie of slideshow "${slideshow.name}".`,
      ipAddress: request.ip
    });
    return reply.code(202).send({ renderStatus: "queued" });
  });

  // Stream the rendered MP4 (range-aware, so a browser <video> can seek). ?download
  // forces a Save As with a friendly filename. Any member who can see the slideshow's
  // items can watch/download the movie.
  app.get("/api/library/gallery/slideshows/:id/movie", { preHandler: app.authenticate }, (request, reply) => {
    const slideshow = getSlideshow((request.params as { id: string }).id);
    const user = request.user!;
    if (!slideshow || slideshow.render_status !== "ready" || !slideshow.output_storage_key) {
      reply.code(404).send({ error: "No movie available" });
      return;
    }
    // Reuse the detail visibility rule: a member who can't see any items can't watch.
    if (getSlideshowItems(user.id, resolveGalleryScopeLibraryIds(user), slideshow, 1, 0).total === 0 && !canEditSlideshow(slideshow, user)) {
      reply.code(404).send({ error: "No movie available" });
      return;
    }

    let filePath: string;
    try { filePath = thumbnailAbsolutePath(slideshow.output_storage_key); } catch { reply.code(404).send({ error: "No movie available" }); return; }
    if (!fs.existsSync(filePath)) { reply.code(404).send({ error: "No movie available" }); return; }

    const totalSize = fs.statSync(filePath).size;
    const rangeHeader = request.headers["range"];
    const range = rangeHeader ? parseRangeHeader(rangeHeader, totalSize) : null;
    if (rangeHeader && !range) {
      reply.code(416).header("Content-Range", `bytes */${totalSize}`).send({ error: "Range not satisfiable" });
      return;
    }
    const download = typeof (request.query as { download?: string }).download === "string";
    if (download && (!range || range.start === 0)) {
      logActivity({
        event: "gallery.slideshow.downloaded",
        actorUserId: user.id,
        targetType: "gallery_slideshow",
        targetId: slideshow.id,
        detail: `Downloaded the movie of slideshow "${slideshow.name}".`,
        ipAddress: request.ip
      });
    }
    const safeName = `${slideshow.name.replace(/[/\\?%*:|"<>]/g, "_").trim() || "slideshow"}.mp4`;
    const disposition = download
      ? `attachment; filename="${safeName.replace(/[^\x20-\x7E]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(safeName)}`
      : "inline";

    reply.hijack();
    if (range) {
      reply.raw.writeHead(206, {
        "Content-Type": "video/mp4",
        "Content-Range": `bytes ${range.start}-${range.end}/${totalSize}`,
        "Content-Length": range.size,
        "Accept-Ranges": "bytes",
        "Content-Disposition": disposition,
        "Cache-Control": "private, no-cache"
      });
      pipeFileToReply(reply, filePath, { start: range.start, end: range.end });
    } else {
      reply.raw.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": totalSize,
        "Accept-Ranges": "bytes",
        "Content-Disposition": disposition,
        "Cache-Control": "private, no-cache"
      });
      pipeFileToReply(reply, filePath);
    }
  });

  // A card as it would be drawn, for the editor's preview — `?card=closing` for the
  // closing card, the opening card otherwise. Rendered on demand from the SAME code
  // the movie uses (slideshow{Title,Closing}CardPreview), so choosing a background is
  // not guesswork — but scaled down, since it is being looked at in a dialog rather
  // than played at 1080p.
  app.get("/api/library/gallery/slideshows/:id/title-card.png", { preHandler: app.authenticate }, async (request, reply) => {
    const slideshow = getSlideshow((request.params as { id: string }).id);
    const user = request.user!;
    if (!slideshow) return reply.code(404).send({ error: "Slideshow not found" });
    const libIds = resolveGalleryScopeLibraryIds(user);
    // Same visibility rule as the detail: no visible items, no slideshow.
    if (getSlideshowItems(user.id, libIds, slideshow, 1, 0).total === 0 && !canEditSlideshow(slideshow, user)) {
      return reply.code(404).send({ error: "Slideshow not found" });
    }
    const items = presentRenderItems(getSlideshowRenderItems(libIds, slideshow));
    const closing = (request.query as { card?: string }).card === "closing";
    const png = closing
      ? await slideshowClosingCardPreview(slideshow, items, PREVIEW_WIDTH)
      : await slideshowTitleCardPreview(slideshow, items, PREVIEW_WIDTH);
    if (!png) return reply.code(503).send({ error: "The card couldn't be drawn." });
    return reply
      .header("Content-Type", "image/png")
      .header("Cache-Control", "private, no-cache")
      .send(png);
  });

  // Delete the rendered movie (editors only): removes the MP4 + any leftover temp files
  // and returns the slideshow to 'draft'. A copy already saved to a gallery library is
  // kept. Refused while a render is in flight — cancel it from the Tasks page first.
  app.delete("/api/library/gallery/slideshows/:id/movie", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const slideshow = editable((request.params as { id: string }).id, user, reply);
    if (!slideshow) return reply;
    if (slideshow.render_status === "queued" || slideshow.render_status === "rendering") {
      return reply.code(409).send({ error: "A render is in progress. Cancel it from the Tasks page first." });
    }
    deleteSlideshowRender(slideshow);
    logActivity({
      event: "gallery.slideshow.movie_deleted",
      actorUserId: user.id,
      targetType: "gallery_slideshow",
      targetId: slideshow.id,
      detail: `Deleted the rendered movie of slideshow "${slideshow.name}".`,
      ipAddress: request.ip
    });
    return reply.send({ deleted: true });
  });

  app.patch("/api/library/gallery/slideshows/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const slideshow = editable((request.params as { id: string }).id, user, reply);
    if (!slideshow) return reply;
    const parsed = parseBody(updateSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid slideshow details", details: parsed.error });
    }
    // A non-null music id must name a real track (any track — music is gallery-wide).
    if (parsed.data.musicTrackId && !getMusicTrack(parsed.data.musicTrackId)) {
      return reply.code(400).send({ error: "That music track no longer exists." });
    }
    // A card's background photo has to be one of this slideshow's own slides:
    // the cards are built from the slideshow, not from the whole gallery.
    const memberCheck = db.prepare("SELECT 1 FROM gallery_slideshow_items WHERE slideshow_id = ? AND item_id = ?");
    for (const photoId of [parsed.data.titlePhotoItemId, parsed.data.closingPhotoItemId]) {
      if (photoId && !memberCheck.get(slideshow.id, photoId)) {
        return reply.code(400).send({ error: "That photo isn't in this slideshow." });
      }
    }
    // A movie target has to be writable in both senses (see movieTargetProblem).
    if (parsed.data.movieTargetLibraryId) {
      const problem = movieTargetProblem(parsed.data.movieTargetLibraryId, user);
      if (problem) return reply.code(400).send({ error: problem });
    }

    // The clip has to be a gallery VIDEO the caller can actually see (any library —
    // membership not required; see updateSchema).
    if (parsed.data.outroItemId && !getClipRenderItem(resolveGalleryScopeLibraryIds(user), parsed.data.outroItemId)) {
      return reply.code(400).send({ error: "That video isn't available." });
    }
    updateSlideshow(slideshow.id, parsed.data);
    return reply.send({ updated: true });
  });

  // What filing this movie into a library WOULD do, without doing it. The picker calls
  // this before saving so a clash can be raised while a person is present to answer —
  // a background render cannot ask, so the answer has to be collected here and stored.
  //
  // `conflict` distinguishes the two cases that need different words: "file" is some
  // loose file with the same name (overwriting is offered), "item" is a catalogued video
  // someone actually has in their gallery (overwriting is REFUSED — see saveMovieToLibrary).
  app.get("/api/library/gallery/slideshows/:id/movie-target/preview", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const slideshow = editable((request.params as { id: string }).id, user, reply);
    if (!slideshow) return reply;

    const query = request.query as { libraryId?: string; stem?: string; onConflict?: string };
    const libraryId = (query.libraryId ?? "").trim();
    if (!libraryId) return reply.code(400).send({ error: "Name a library to check." });

    const problem = movieTargetProblem(libraryId, user);
    if (problem) return reply.send({ usable: false, reason: problem });

    const library = db.prepare("SELECT source_path FROM libraries WHERE id = ?").get(libraryId) as { source_path: string };
    const root = validateLibrarySource(library.source_path);
    const probe = { ...slideshow, movie_file_stem: query.stem?.trim() || slideshow.movie_file_stem };
    const policy: MovieConflictPolicy = query.onConflict === "overwrite" ? "overwrite" : "keep_both";

    // Always resolve at the FIRST-CHOICE name, so the dialog reports the clash rather than
    // silently showing the numbered name "keep both" would land on.
    const wanted = movieRelativePathFor(probe, libraryId, () => false, "overwrite");
    const onDisk = fs.existsSync(path.join(root, ...wanted.split("/")));
    const own = slideshow.movie_library_id === libraryId && slideshow.movie_relative_path === wanted;
    const foreign = onDisk ? foreignItemAt(libraryId, wanted, slideshow.movie_item_id) : null;

    const resolved = movieRelativePathFor(
      probe, libraryId,
      (rel) => fs.existsSync(path.join(root, ...rel.split("/"))),
      policy
    );

    let conflict: "none" | "own" | "file" | "item" = "none";
    if (own) conflict = "own";
    else if (foreign) conflict = "item";
    else if (onDisk) conflict = "file";

    const existing = foreign
      ? db.prepare(`
          SELECT item_metadata.title AS title, gallery_details.taken_at AS takenAt
          FROM gallery_details LEFT JOIN item_metadata ON item_metadata.item_id = gallery_details.item_id
          WHERE gallery_details.item_id = ?
        `).get(foreign) as { title: string | null; takenAt: string | null } | undefined
      : undefined;

    return reply.send({
      usable: true,
      wantedPath: wanted,
      resolvedPath: resolved,
      fileName: resolved.split("/").pop(),
      conflict,
      // Overwrite is offered for a loose file, never for someone's catalogued video.
      canOverwrite: conflict === "none" || conflict === "own" || conflict === "file",
      existingTitle: existing?.title ?? null,
      existingTakenAt: existing?.takenAt ?? null
    });
  });

  // Save an ALREADY-RENDERED movie into a library now — the one-off copy, separate from
  // the slideshow's standing target. Uses whatever target/policy/stem the slideshow
  // currently carries, so the caller PATCHes those first and then calls this.
  app.post("/api/library/gallery/slideshows/:id/save-to-library", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const slideshow = editable((request.params as { id: string }).id, user, reply);
    if (!slideshow) return reply;

    if (slideshow.render_status !== "ready" || !slideshow.output_storage_key) {
      return reply.code(409).send({ error: "There is no finished movie to save yet." });
    }
    if (!slideshow.movie_target_library_id) {
      return reply.code(400).send({ error: "Choose a library for this movie first." });
    }
    const problem = movieTargetProblem(slideshow.movie_target_library_id, user);
    if (problem) return reply.code(400).send({ error: problem });

    try {
      const result = await saveMovieToLibrary(slideshow, slideshow.output_storage_key);
      setSlideshowSaveError(slideshow.id, result.error);
      if (!result.saved) {
        return reply.code(409).send({ error: result.error ?? "The movie could not be saved to that library." });
      }
      logActivity({
        event: "gallery.slideshow.saved_to_library",
        actorUserId: user.id,
        targetType: "gallery_slideshow",
        targetId: slideshow.id,
        detail: `Saved the movie of slideshow "${slideshow.name}" into a gallery library.`,
        ipAddress: request.ip
      });
      return reply.send({ saved: true, itemId: result.itemId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "The movie could not be saved to that library.";
      setSlideshowSaveError(slideshow.id, message);
      return reply.code(409).send({ error: message });
    }
  });

  app.delete("/api/library/gallery/slideshows/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const slideshow = editable((request.params as { id: string }).id, user, reply);
    if (!slideshow) return reply;
    // Reclaim the rendered movie file (the DB row cascades; the file doesn't).
    if (slideshow.output_storage_key) {
      try { fs.rmSync(thumbnailAbsolutePath(slideshow.output_storage_key), { force: true }); } catch { /* best-effort */ }
    }
    deleteSlideshow(slideshow.id);
    // Story blocks reference a slideshow by id with no FK — sweep them so a
    // story doesn't keep an empty slot where the slideshow used to be.
    deleteStoryBlocksForResource("gallery_slideshow", slideshow.id);
    logActivity({
      event: "gallery.slideshow.deleted",
      actorUserId: user.id,
      targetType: "gallery_slideshow",
      targetId: slideshow.id,
      detail: `Deleted gallery slideshow "${slideshow.name}". The photos themselves were not affected.`,
      ipAddress: request.ip
    });
    return reply.send({ deleted: true });
  });

  app.post("/api/library/gallery/slideshows/:id/items", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const slideshow = editable((request.params as { id: string }).id, user, reply);
    if (!slideshow) return reply;
    const parsed = parseBody(itemsSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid items", details: parsed.error });
    }
    const libIds = new Set(resolveGalleryScopeLibraryIds(user));
    return reply.send(addSlideshowItems(slideshow.id, libIds, parsed.data.itemIds));
  });

  // Batch remove (detach only — the photos stay in the gallery). POST like the add.
  app.post("/api/library/gallery/slideshows/:id/items/remove", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const slideshow = editable((request.params as { id: string }).id, user, reply);
    if (!slideshow) return reply;
    const parsed = parseBody(itemsSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid items", details: parsed.error });
    }
    return reply.send({ removed: removeSlideshowItems(slideshow.id, parsed.data.itemIds) });
  });

  // Reorder: the body is the full desired order of item ids (the editor's drag).
  app.post("/api/library/gallery/slideshows/:id/reorder", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const slideshow = editable((request.params as { id: string }).id, user, reply);
    if (!slideshow) return reply;
    const parsed = parseBody(reorderSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid order", details: parsed.error });
    }
    reorderSlideshowItems(slideshow.id, parsed.data.itemIds);
    return reply.send({ reordered: true });
  });
}
