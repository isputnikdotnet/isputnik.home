// Slideshow endpoints. Reads are open to every member (items filtered per viewer's
// library access); writes require canEditSlideshow (creator + admins). Batch bodies
// follow the bulk contract: inaccessible items are skipped and counted. Sibling of
// album-routes.ts; the extra endpoint here is reorder (albums shipped without it).
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { resolveGalleryScopeLibraryIds } from "./catalog.js";
import { getRenderLibraryId, setRenderLibraryId } from "./slideshow-settings.js";
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
  summarize,
  type SlideshowRow
} from "./slideshows.js";
import { getMusicTrack, summarizeTrack } from "./music.js";
import { enqueueSlideshowRender, renderProgressPercent, deleteSlideshowRender } from "./slideshow-render.js";
import { parseRangeHeader } from "../shared/document-stream.js";
import { thumbnailAbsolutePath } from "../shared/thumbnail.js";
import fs from "node:fs";

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

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  transition: z.enum(["none", "crossfade", "fade", "slide", "kenburns", "dipblack", "random"]).optional(),
  slideSeconds: z.number().min(1).max(30).optional(),
  transitionSeconds: z.number().min(0.5).max(5).optional(),
  // null clears the music; a string selects a track (validated below).
  musicTrackId: z.string().trim().min(1).max(64).nullable().optional()
});

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
    const libIds = resolveGalleryScopeLibraryIds(request.user!, "all");
    return { slideshows: listSlideshows(request.user!, libIds) };
  });

  // The global "default movie library" (admin): where every successful render is auto-saved
  // as a gallery video item. `renderLibraryId` is null when saving-to-a-library is off.
  // (Static path — Fastify routes this ahead of the "/:id" route below.)
  app.get("/api/library/gallery/slideshows/settings", { preHandler: app.requireAdmin }, async () => {
    const libraries = db.prepare("SELECT id, name FROM libraries WHERE type = 'gallery' ORDER BY name COLLATE NOCASE").all() as { id: string; name: string }[];
    return { renderLibraryId: getRenderLibraryId(), libraries };
  });

  const settingsSchema = z.object({ renderLibraryId: z.string().trim().min(1).max(64).nullable() });

  app.patch("/api/library/gallery/slideshows/settings", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(settingsSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid movie settings", details: parsed.error });
      return;
    }
    const libraryId = parsed.data.renderLibraryId;
    if (libraryId && !db.prepare("SELECT 1 FROM libraries WHERE id = ? AND type = 'gallery'").get(libraryId)) {
      reply.code(400).send({ error: "That gallery library no longer exists." });
      return;
    }
    setRenderLibraryId(libraryId, request.user!.id);
    logActivity({
      event: "gallery.slideshow.settings",
      actorUserId: request.user!.id,
      targetType: "app_setting",
      targetId: "gallery.slideshow.render_library",
      detail: libraryId ? `Set the default slideshow-movie library.` : `Turned off saving slideshow movies to a library.`,
      ipAddress: request.ip
    });
    reply.send({ renderLibraryId: getRenderLibraryId() });
  });

  app.post("/api/library/gallery/slideshows", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(createSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid slideshow details", details: parsed.error });
      return;
    }
    const user = request.user!;
    const slideshow = createSlideshow(user, parsed.data.name, { kind: parsed.data.sourceKind, ref: parsed.data.sourceRef });
    let added = 0;
    if (parsed.data.itemIds && parsed.data.itemIds.length > 0) {
      const libIds = new Set(resolveGalleryScopeLibraryIds(user, "all"));
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
    reply.code(201).send({ slideshow: summarize(slideshow, added, null, true) });
  });

  // Slideshow detail: metadata + one page of the viewer's visible items in order.
  app.get("/api/library/gallery/slideshows/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const slideshow = getSlideshow((request.params as { id: string }).id);
    const user = request.user!;
    if (!slideshow) {
      reply.code(404).send({ error: "Slideshow not found" });
      return;
    }
    const qp = request.query as { limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number.parseInt(qp.limit ?? "200", 10) || 200, 1), 500);
    const offset = Math.max(Number.parseInt(qp.offset ?? "0", 10) || 0, 0);
    const libIds = resolveGalleryScopeLibraryIds(user, "all");
    const { assets, total } = getSlideshowItems(user.id, libIds, slideshow, limit, offset);
    // A member who can't see any of the items shouldn't learn the slideshow exists.
    if (total === 0 && !canEditSlideshow(slideshow, user)) {
      reply.code(404).send({ error: "Slideshow not found" });
      return;
    }
    reply.send({
      slideshow: {
        id: slideshow.id,
        name: slideshow.name,
        transition: slideshow.transition,
        slideSeconds: slideshow.slide_seconds,
        transitionSeconds: slideshow.transition_seconds,
        canEdit: canEditSlideshow(slideshow, user),
        updatedAt: slideshow.updated_at,
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
    if (!slideshow) return;
    if (slideshow.render_status === "queued" || slideshow.render_status === "rendering") {
      reply.send({ renderStatus: slideshow.render_status }); // already in flight — idempotent
      return;
    }
    const hasPhotos = getSlideshowItems(user.id, resolveGalleryScopeLibraryIds(user, "all"), slideshow, 1, 0).total > 0;
    if (!hasPhotos) {
      reply.code(400).send({ error: "Add at least one photo before rendering a movie." });
      return;
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
    reply.code(202).send({ renderStatus: "queued" });
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
    if (getSlideshowItems(user.id, resolveGalleryScopeLibraryIds(user, "all"), slideshow, 1, 0).total === 0 && !canEditSlideshow(slideshow, user)) {
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
      fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(reply.raw);
    } else {
      reply.raw.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": totalSize,
        "Accept-Ranges": "bytes",
        "Content-Disposition": disposition,
        "Cache-Control": "private, no-cache"
      });
      fs.createReadStream(filePath).pipe(reply.raw);
    }
  });

  // Delete the rendered movie (editors only): removes the MP4 + any leftover temp files
  // and returns the slideshow to 'draft'. A copy already saved to a gallery library is
  // kept. Refused while a render is in flight — cancel it from the Tasks page first.
  app.delete("/api/library/gallery/slideshows/:id/movie", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const slideshow = editable((request.params as { id: string }).id, user, reply);
    if (!slideshow) return;
    if (slideshow.render_status === "queued" || slideshow.render_status === "rendering") {
      reply.code(409).send({ error: "A render is in progress. Cancel it from the Tasks page first." });
      return;
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
    reply.send({ deleted: true });
  });

  app.patch("/api/library/gallery/slideshows/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const slideshow = editable((request.params as { id: string }).id, user, reply);
    if (!slideshow) return;
    const parsed = parseBody(updateSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid slideshow details", details: parsed.error });
      return;
    }
    // A non-null music id must name a real track (any track — music is gallery-wide).
    if (parsed.data.musicTrackId && !getMusicTrack(parsed.data.musicTrackId)) {
      reply.code(400).send({ error: "That music track no longer exists." });
      return;
    }
    updateSlideshow(slideshow.id, parsed.data);
    reply.send({ updated: true });
  });

  app.delete("/api/library/gallery/slideshows/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const slideshow = editable((request.params as { id: string }).id, user, reply);
    if (!slideshow) return;
    // Reclaim the rendered movie file (the DB row cascades; the file doesn't).
    if (slideshow.output_storage_key) {
      try { fs.rmSync(thumbnailAbsolutePath(slideshow.output_storage_key), { force: true }); } catch { /* best-effort */ }
    }
    deleteSlideshow(slideshow.id);
    logActivity({
      event: "gallery.slideshow.deleted",
      actorUserId: user.id,
      targetType: "gallery_slideshow",
      targetId: slideshow.id,
      detail: `Deleted gallery slideshow "${slideshow.name}". The photos themselves were not affected.`,
      ipAddress: request.ip
    });
    reply.send({ deleted: true });
  });

  app.post("/api/library/gallery/slideshows/:id/items", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const slideshow = editable((request.params as { id: string }).id, user, reply);
    if (!slideshow) return;
    const parsed = parseBody(itemsSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid items", details: parsed.error });
      return;
    }
    const libIds = new Set(resolveGalleryScopeLibraryIds(user, "all"));
    reply.send(addSlideshowItems(slideshow.id, libIds, parsed.data.itemIds));
  });

  // Batch remove (detach only — the photos stay in the gallery). POST like the add.
  app.post("/api/library/gallery/slideshows/:id/items/remove", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const slideshow = editable((request.params as { id: string }).id, user, reply);
    if (!slideshow) return;
    const parsed = parseBody(itemsSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid items", details: parsed.error });
      return;
    }
    reply.send({ removed: removeSlideshowItems(slideshow.id, parsed.data.itemIds) });
  });

  // Reorder: the body is the full desired order of item ids (the editor's drag).
  app.post("/api/library/gallery/slideshows/:id/reorder", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const slideshow = editable((request.params as { id: string }).id, user, reply);
    if (!slideshow) return;
    const parsed = parseBody(reorderSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid order", details: parsed.error });
      return;
    }
    reorderSlideshowItems(slideshow.id, parsed.data.itemIds);
    reply.send({ reordered: true });
  });
}
