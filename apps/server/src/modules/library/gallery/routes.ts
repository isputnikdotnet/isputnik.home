import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import { db, logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { can, parsePolicy } from "../../../core/permissions.js";
import { canUserAccessLibrary, libraryCapabilities, deleteLibraryAccess, canUserWriteLibrary, getLibraryForBook } from "../shared/library-access.js";
import { publicLibrary, type LibraryListRow } from "../shared/library-serializer.js";
import { deleteSharesForLibrary } from "../shared/share-access.js";
import { deleteCollectionItemsForLibrary } from "../../collections/cleanup.js";
import { coreLibraryCreateSchema, coreLibraryUpdateSchema, createLibraryRecord, updateLibraryRecord } from "../shared/library-crud.js";
import { METADATA_SOURCE_IDS } from "../shared/metadata-sources.js";
import { validateLibrarySource, LibrarySourceError } from "../shared/library-source.js";
import { normaliseRelativePath } from "../shared/storage-roots.js";
import { removeThumbnailsForLibrary } from "../shared/thumbnail.js";
import { normalizeLibrarySettings, uploadAcceptExtensions } from "../shared/library-settings.js";
import { receiveUploadBatch, UploadError } from "../../uploads/index.js";
import { enqueueGalleryScan, processGalleryScanQueue, scanSingleGalleryFile } from "./scanner.js";
import {
  resolveGalleryScopeLibraryIds,
  queryGalleryTimeline,
  queryGalleryFolders,
  getGalleryAsset,
  galleryFacets,
  queryGalleryMapPoints,
  queryGalleryMemories,
  EMPTY_GALLERY_FILTERS
} from "./catalog.js";
import { updateGalleryAsset } from "./edit.js";
import { rotateGalleryAsset } from "./rotate.js";

// Each uploaded file becomes its own asset (one photo/video = one item), so this
// also bounds assets-per-upload — galleries are dropped in large batches.
const MAX_GALLERY_UPLOAD_FILES = 200;

// Turn a client filename into a safe, collision-free name within a directory:
// strip path separators / control chars, refuse a leading dot (the scanner skips
// dot-entries, and ".upload-*" is reserved for staging), then disambiguate against
// existing files with " (2)", " (3)", … Returns null if nothing usable remains.
// Mirrors the ebook uploader.
function uniqueGalleryFileName(dir: string, filename: string): string | null {
  const ext = path.extname(filename);
  const stem = Array.from(path.basename(filename, ext))
    .filter((ch) => ch.charCodeAt(0) >= 32)
    .join("")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 150)
    .replace(/[\s.]+$/g, "");
  if (!stem) return null;
  let candidate = `${stem}${ext}`;
  let counter = 2;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem} (${counter})${ext}`;
    counter += 1;
  }
  return candidate;
}

const GALLERY_LIBRARY_LIST_SQL = `
  SELECT
    libraries.*,
    COUNT(DISTINCT library_items.id) AS book_count,
    COUNT(gallery_details.item_id) AS file_count,
    COALESCE(SUM(COALESCE(gallery_details.size, 0)), 0) AS total_size_bytes
  FROM libraries
  LEFT JOIN library_items ON library_items.library_id = libraries.id AND library_items.deleted_at IS NULL
  LEFT JOIN gallery_details ON gallery_details.item_id = library_items.id
  WHERE libraries.type = 'gallery' %WHERE%
  GROUP BY libraries.id
  ORDER BY datetime(libraries.created_at) DESC
`;

export async function galleryRoutesPlugin(app: FastifyInstance) {
  app.post("/api/library/gallery-libraries", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(coreLibraryCreateSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid gallery library details", details: parsed.error });
      return;
    }

    const result = createLibraryRecord({ type: "gallery", data: parsed.data, userId: request.user!.id, ip: request.ip });
    if ("error" in result) {
      reply.code(result.status).send({ error: result.error });
      return;
    }

    const jobId = enqueueGalleryScan(result.libraryId);
    void processGalleryScanQueue();
    reply.code(201).send({ library: { id: result.libraryId }, job: { id: jobId, type: "SCAN_GALLERY_LIBRARY" } });
  });

  app.get("/api/library/gallery-libraries", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const rows = db.prepare(GALLERY_LIBRARY_LIST_SQL.replace("%WHERE%", "")).all() as LibraryListRow[];
    const manageAll = (request.query as { manage?: string }).manage != null && user.role === "admin";
    const visible = manageAll ? rows : rows.filter((row) => canUserAccessLibrary(row, user.id, user.role));
    return { libraries: visible.map((row) => publicLibrary(row, user.role === "admin", libraryCapabilities(row, user.id, user.role))) };
  });

  app.patch("/api/library/gallery-libraries/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = parseBody(coreLibraryUpdateSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid library details", details: parsed.error });
      return;
    }

    const result = updateLibraryRecord({ type: "gallery", id, data: parsed.data, userId: request.user!.id, ip: request.ip });
    if ("error" in result) {
      reply.code(result.status).send({ error: result.error });
      return;
    }

    const updated = db.prepare(GALLERY_LIBRARY_LIST_SQL.replace("%WHERE%", "AND libraries.id = ?")).get(id) as LibraryListRow;
    reply.send({ library: publicLibrary(updated, true, libraryCapabilities(updated, request.user!.id, request.user!.role)) });
  });

  app.delete("/api/library/gallery-libraries/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const exists = db.prepare("SELECT id, name FROM libraries WHERE id = ? AND type = 'gallery'")
      .get(id) as { id: string; name: string } | undefined;
    if (!exists) {
      reply.code(404).send({ error: "Gallery library not found" });
      return;
    }

    db.transaction(() => {
      db.prepare("DELETE FROM taggables WHERE entity_type = 'library_item' AND entity_id IN (SELECT id FROM library_items WHERE library_id = ?)").run(id);
      deleteSharesForLibrary("gallery", id);
      deleteCollectionItemsForLibrary("gallery", id);
      deleteLibraryAccess(id);
      db.prepare("DELETE FROM libraries WHERE id = ?").run(id);
    })();
    removeThumbnailsForLibrary(id);

    logActivity({
      event: "library.gallery.deleted",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: id,
      detail: `Deleted gallery library "${exists.name}". Source files on disk were not removed; generated thumbnails were deleted.`,
      ipAddress: request.ip
    });
    reply.send({ deleted: true });
  });

  const rescanOptionsSchema = z.object({
    sources: z.array(z.object({ id: z.enum(METADATA_SOURCE_IDS), enabled: z.boolean() })).max(20).optional()
  });

  app.post("/api/library/gallery-libraries/:id/rescan", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const exists = db.prepare("SELECT id, source_path FROM libraries WHERE id = ? AND type = 'gallery'")
      .get(id) as { id: string; source_path: string } | undefined;
    if (!exists) {
      reply.code(404).send({ error: "Gallery library not found" });
      return;
    }

    const parsed = parseBody(rescanOptionsSchema, request.body ?? {});
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid rescan options", details: parsed.error });
      return;
    }

    try {
      validateLibrarySource(exists.source_path);
    } catch (err) {
      if (err instanceof LibrarySourceError) {
        reply.code(422).send({ error: err.message });
        return;
      }
      throw err;
    }

    const jobId = enqueueGalleryScan(id, parsed.data);
    void processGalleryScanQueue();
    logActivity({
      event: "library.gallery.rescan",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: id,
      detail: "Queued a gallery library rescan.",
      ipAddress: request.ip
    });
    reply.send({ job: { id: jobId, type: "SCAN_GALLERY_LIBRARY" } });
  });

  // Upload photos/videos: every file in the multipart request becomes its OWN asset
  // (one file = one item). Files stream into a hidden ".upload-*" staging folder under
  // the library root, then each is moved into the root under a safe, unique name and
  // cataloged immediately via scanSingleGalleryFile (reads EXIF + builds thumbnails).
  app.post("/api/library/gallery-libraries/:id/assets/upload", { preHandler: app.authenticate }, async (request, reply) => {
    const libraryId = (request.params as { id: string }).id;
    const user = request.user!;

    const library = db.prepare(
      "SELECT id, name, source_path, settings_json, policy_json FROM libraries WHERE id = ? AND type = 'gallery'"
    ).get(libraryId) as { id: string; name: string; source_path: string; settings_json: string; policy_json: string } | undefined;
    if (!library || !canUserAccessLibrary(library, user.id, user.role)) {
      reply.code(404).send({ error: "Gallery library not found" });
      return;
    }

    const policy = parsePolicy(library.policy_json);
    if (!can(user, { objectType: "library", objectId: library.id, policy }, "upload")) {
      reply.code(403).send({ error: "Uploading is not allowed in this library." });
      return;
    }

    let root: string;
    try {
      root = validateLibrarySource(library.source_path);
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : "Library source folder is unavailable." });
      return;
    }

    const settings = normalizeLibrarySettings("gallery", library.settings_json);
    const maxBytes = policy.maxUploadMB != null ? policy.maxUploadMB * 1024 * 1024 : null;
    const stagingDir = path.join(root, `.upload-${nanoid(10)}`);

    let received;
    try {
      received = await receiveUploadBatch(
        request,
        { accept: uploadAcceptExtensions(settings), maxBytes },
        stagingDir,
        MAX_GALLERY_UPLOAD_FILES
      );
    } catch (err) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      const status = err instanceof UploadError ? err.statusCode : 400;
      reply.code(status).send({ error: err instanceof Error ? err.message : "Upload failed" });
      return;
    }

    // Each file moves into the library root under a unique name, then is cataloged on
    // its own. Files already in place stay even if a later one fails.
    const createdIds: string[] = [];
    let totalBytes = 0;
    try {
      for (const file of received) {
        const finalName = uniqueGalleryFileName(root, file.filename);
        if (!finalName) { fs.rmSync(file.tmpPath, { force: true }); continue; }
        const finalPath = path.join(root, finalName);
        fs.renameSync(file.tmpPath, finalPath);
        const relativePath = normaliseRelativePath(path.relative(root, finalPath));
        const assetId = await scanSingleGalleryFile(library.id, relativePath);
        if (assetId) { createdIds.push(assetId); totalBytes += file.sizeBytes; }
      }
    } catch (err) {
      reply.code(500).send({ error: err instanceof Error ? err.message : "Could not store the uploaded files." });
      return;
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }

    if (createdIds.length === 0) {
      reply.code(400).send({ error: "No photos or videos were added from the upload." });
      return;
    }

    logActivity({
      event: "library.gallery.uploaded",
      actorUserId: user.id,
      targetType: "library",
      targetId: library.id,
      detail: `Uploaded ${createdIds.length} item${createdIds.length === 1 ? "" : "s"} (${totalBytes} bytes) to gallery "${library.name}".`,
      ipAddress: request.ip
    });

    reply.code(201).send({ uploaded: createdIds.length });
  });

  // ── Browse: Timeline (by date) and Folders (by on-disk structure) ──

  // Advanced-filter arrays (audiobook-catalog style): each list is optional and
  // bounded so a hostile payload can't inflate the SQL placeholder count.
  const filterList = z.array(z.string().trim().min(1).max(200)).max(100).default([]);
  const timelineSchema = z.object({
    scope: z.enum(["all", "library"]).default("all"),
    libraryId: z.string().trim().min(1).optional(),
    q: z.string().trim().max(200).default(""),
    kinds: z.array(z.enum(["photo", "video"])).default([]),
    filters: z.object({
      people: filterList,
      tags: filterList,
      years: filterList,
      taken: z.array(z.string().regex(/^(from|to):\d{4}-\d{2}-\d{2}$/)).max(2).default([]),
      cameras: filterList,
      sizes: z.array(z.enum(["small", "medium", "large", "huge"])).max(4).default([]),
      location: z.array(z.enum(["with_gps", "no_gps"])).max(2).default([])
    }).default({}),
    limit: z.number().int().min(1).max(200).default(80),
    offset: z.number().int().min(0).default(0)
  });

  app.post("/api/library/gallery/timeline", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(timelineSchema, request.body ?? {});
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid timeline query", details: parsed.error });
      return;
    }
    const p = parsed.data;
    const libIds = resolveGalleryScopeLibraryIds(request.user!, p.scope ?? "all", p.libraryId);
    reply.send(queryGalleryTimeline(request.user!.id, libIds, {
      q: p.q ?? "", kinds: p.kinds ?? [],
      filters: { ...EMPTY_GALLERY_FILTERS, ...p.filters },
      limit: p.limit ?? 80, offset: p.offset ?? 0
    }));
  });

  app.get("/api/library/gallery/folders", { preHandler: app.authenticate }, async (request) => {
    const qp = request.query as { scope?: string; libraryId?: string; parent?: string; limit?: string; offset?: string };
    const scope = qp.scope === "library" ? qp.scope : "all";
    const libIds = resolveGalleryScopeLibraryIds(request.user!, scope, qp.libraryId);
    const limit = Math.min(Math.max(Number.parseInt(qp.limit ?? "80", 10) || 80, 1), 200);
    const offset = Math.max(Number.parseInt(qp.offset ?? "0", 10) || 0, 0);
    // Cap the folder path: real relative paths are short, so a bounded value keeps
    // the LIKE pattern and all downstream string work sane (defense in depth).
    const parent = (qp.parent ?? "").slice(0, 1024);
    return queryGalleryFolders(request.user!.id, libIds, parent, limit, offset);
  });

  // Memories ("On this day"): past-year assets matching today's month/day, grouped
  // by year. `date` is the client's local calendar date — the server may sit in a
  // different timezone, and "today" belongs to the person looking at the screen.
  // `perYear` caps items per year group (the Home tile only needs one for a cover).
  app.get("/api/library/gallery/memories", { preHandler: app.authenticate }, async (request) => {
    const qp = request.query as { scope?: string; libraryId?: string; date?: string; perYear?: string };
    const scope = qp.scope === "library" ? qp.scope : "all";
    const libIds = resolveGalleryScopeLibraryIds(request.user!, scope, qp.libraryId);
    // A malformed or impossible date (e.g. 2026-99-99 passes the shape check but
    // not Date parsing) falls back to the server's local calendar date.
    let date = qp.date ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
      const now = new Date();
      date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    }
    const perYear = Math.min(Math.max(Number.parseInt(qp.perYear ?? "60", 10) || 60, 1), 200);
    return queryGalleryMemories(request.user!.id, libIds, date, perYear);
  });

  app.get("/api/library/gallery/facets", { preHandler: app.authenticate }, async (request) => {
    const qp = request.query as { scope?: string; libraryId?: string };
    const scope = qp.scope === "library" ? qp.scope : "all";
    const libIds = resolveGalleryScopeLibraryIds(request.user!, scope, qp.libraryId);
    return galleryFacets(libIds);
  });

  // Geotagged assets for the map view. Same scope/kind filtering as the timeline;
  // capped so a huge library can't return an unbounded marker payload.
  app.get("/api/library/gallery/map", { preHandler: app.authenticate }, async (request) => {
    const qp = request.query as { scope?: string; libraryId?: string; kinds?: string };
    const scope = qp.scope === "library" ? qp.scope : "all";
    const libIds = resolveGalleryScopeLibraryIds(request.user!, scope, qp.libraryId);
    const kinds = (qp.kinds ?? "").split(",").map((k) => k.trim()).filter((k) => k === "photo" || k === "video");
    return queryGalleryMapPoints(libIds, { kinds, limit: 5000 });
  });

  app.get("/api/library/gallery/assets/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const libIds = resolveGalleryScopeLibraryIds(request.user!, "all");
    const asset = getGalleryAsset(request.user!.id, libIds, id);
    if (!asset) {
      reply.code(404).send({ error: "Asset not found" });
      return;
    }
    reply.send({ asset });
  });

  // Manual metadata edit: title/caption, description, date taken, tags. Requires
  // write access to the asset's library; protects the fields from future rescans.
  const editSchema = z.object({
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().max(5000).nullable().optional(),
    takenAt: z.string().datetime().nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(80)).max(50).default([])
  });

  app.patch("/api/library/gallery/assets/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const lib = getLibraryForBook(id);
    if (!lib || lib.type !== "gallery" || !canUserWriteLibrary(lib, user.id, user.role)) {
      reply.code(403).send({ error: "Write access required to edit this item." });
      return;
    }

    const parsed = parseBody(editSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid details", details: parsed.error });
      return;
    }

    const ok = updateGalleryAsset(id, {
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      takenAt: parsed.data.takenAt ?? null,
      tags: parsed.data.tags ?? []
    });
    if (!ok) {
      reply.code(404).send({ error: "Asset not found" });
      return;
    }

    logActivity({
      event: "library.gallery.edited",
      actorUserId: user.id,
      targetType: "library_item",
      targetId: id,
      detail: `Edited gallery item "${parsed.data.title}".`,
      ipAddress: request.ip
    });

    reply.send({ updated: true, asset: getGalleryAsset(user.id, [lib.id], id) });
  });

  // Rotate a photo 90° clockwise/counter-clockwise. Stores the angle and bakes it
  // into the regenerated thumbnails; videos and the original file are untouched.
  const rotateSchema = z.object({ direction: z.enum(["cw", "ccw"]) });

  app.post("/api/library/gallery/assets/:id/rotate", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const lib = getLibraryForBook(id);
    if (!lib || lib.type !== "gallery" || !canUserWriteLibrary(lib, user.id, user.role)) {
      reply.code(403).send({ error: "Write access required to edit this item." });
      return;
    }

    const parsed = parseBody(rotateSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid rotation", details: parsed.error });
      return;
    }

    const result = await rotateGalleryAsset(id, parsed.data.direction);
    if (!result.ok) {
      reply.code(result.status).send({ error: result.error });
      return;
    }

    logActivity({
      event: "library.gallery.rotated",
      actorUserId: user.id,
      targetType: "library_item",
      targetId: id,
      detail: `Rotated gallery photo ${parsed.data.direction === "cw" ? "right" : "left"} (now ${result.rotation}°).`,
      ipAddress: request.ip
    });

    reply.send({ updated: true, asset: getGalleryAsset(user.id, [lib.id], id) });
  });
}
