// Gallery libraries themselves: create, list, edit, delete, rescan, move a folder
// to another library, and the missing-photo housekeeping.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../../db.js";
import { parseBody, parseQuery } from "../../../core/shared.js";
import { canUserAccessLibrary, libraryCapabilities, deleteLibraryAccess } from "../shared/library-access.js";
import { publicLibrary, type LibraryListRow } from "../shared/library-serializer.js";
import { deleteSharesForLibrary } from "../shared/share-access.js";
import { deleteCollectionItemsForLibrary } from "../../collections/cleanup.js";
import { deleteStoryBlocksForLibrary } from "../../stories/cleanup.js";
import { coreLibraryCreateSchema, coreLibraryUpdateSchema, createLibraryRecord, updateLibraryRecord } from "../shared/library-crud.js";
import { METADATA_SOURCE_IDS } from "../shared/metadata-sources.js";
import { validateLibrarySource, LibrarySourceError } from "../shared/library-source.js";
import { relativePathWithinRoot } from "../shared/storage-roots.js";
import { removeThumbnailsForLibrary } from "../shared/thumbnail.js";
import { enqueueGalleryScan, processGalleryScanQueue } from "./scanner.js";
import { listMissingGalleryPhotos, setMissingRetentionDays, purgeMissingGalleryPhoto, purgeMissingGalleryPhotos } from "./cleanup.js";
import { FolderMoveError, planFolderMove, queueFolderMove } from "./folder-move.js";
import { folderMoveStatuses } from "../shared/storage-move.js";
import type { LibraryRow } from "../../../db/rows.js";

const libraryListQuerySchema = z.object({ manage: z.string().optional() }); // presence flag

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
  ORDER BY libraries.created_at DESC
`;

export function registerGalleryLibraryRoutes(app: FastifyInstance) {
  app.post("/api/library/gallery-libraries", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(coreLibraryCreateSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid gallery library details", details: parsed.error });
    }

    const result = createLibraryRecord({ type: "gallery", data: parsed.data, userId: request.user!.id, ip: request.ip });
    if ("error" in result) {
      return reply.code(result.status).send({ error: result.error });
    }

    const jobId = enqueueGalleryScan(result.libraryId);
    void processGalleryScanQueue();
    return reply.code(201).send({ library: { id: result.libraryId }, job: { id: jobId, type: "SCAN_GALLERY_LIBRARY" } });
  });

  app.get("/api/library/gallery-libraries", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const parsed = parseQuery(libraryListQuerySchema, request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid query", details: parsed.error });
    }
    const rows = db.prepare(GALLERY_LIBRARY_LIST_SQL.replace("%WHERE%", "")).all() as LibraryListRow[];
    const manageAll = parsed.data.manage != null && user.role === "admin";
    const visible = manageAll ? rows : rows.filter((row) => canUserAccessLibrary(row, user.id, user.role));
    return { libraries: visible.map((row) => publicLibrary(row, user.role === "admin", libraryCapabilities(row, user.id, user.role))) };
  });

  app.patch("/api/library/gallery-libraries/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = parseBody(coreLibraryUpdateSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid library details", details: parsed.error });
    }

    const result = updateLibraryRecord({ type: "gallery", id, data: parsed.data, userId: request.user!.id, ip: request.ip });
    if ("error" in result) {
      return reply.code(result.status).send({ error: result.error });
    }

    const updated = db.prepare(GALLERY_LIBRARY_LIST_SQL.replace("%WHERE%", "AND libraries.id = ?")).get(id) as LibraryListRow;
    return reply.send({ library: publicLibrary(updated, true, libraryCapabilities(updated, request.user!.id, request.user!.role)) });
  });

  // Moving a folder into another gallery library (folder-move.ts): plan it,
  // queue it as a storage move task, and read what is moving.
  const folderMoveSchema = z.object({
    folderPath: z.string().trim().min(1).max(1000),
    targetLibraryId: z.string().trim().min(1).max(64),
    /** true = only say what would happen (the confirmation's numbers). */
    dryRun: z.boolean().optional()
  });
  app.post("/api/library/gallery-libraries/:id/folders/move", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = parseBody(folderMoveSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid folder move", details: parsed.error });
    try {
      if (parsed.data.dryRun) return reply.send({ plan: planFolderMove(id, parsed.data.folderPath, parsed.data.targetLibraryId) });
      const result = queueFolderMove(id, parsed.data.folderPath, parsed.data.targetLibraryId, request.user!.id);
      return reply.send({ plan: result.plan, move: result.status });
    } catch (err) {
      if (err instanceof FolderMoveError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.get("/api/library/gallery/folder-moves", { preHandler: app.authenticate }, async () => ({ moves: folderMoveStatuses() }));

  app.delete("/api/library/gallery-libraries/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const exists = db.prepare("SELECT id, name, role FROM libraries WHERE id = ? AND type = 'gallery'")
      .get(id) as Pick<LibraryRow, "id" | "name" | "role"> | undefined;
    if (!exists) {
      return reply.code(404).send({ error: "Gallery library not found" });
    }
    // A system library goes away only when App storage is switched off
    // (docs/system-data-plan.md): what it holds belongs to stories, photos and
    // slideshows, or is still waiting for review.
    if (exists.role) {
      return reply.code(409).send({ error: `"${exists.name}" is a system library, so it can't be deleted here.` });
    }

    db.transaction(() => {
      db.prepare("DELETE FROM taggables WHERE entity_type = 'library_item' AND entity_id IN (SELECT id FROM library_items WHERE library_id = ?)").run(id);
      deleteSharesForLibrary("gallery", id);
      deleteCollectionItemsForLibrary("gallery", id);
      deleteStoryBlocksForLibrary("gallery", id);
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
    return reply.send({ deleted: true });
  });

  const rescanOptionsSchema = z.object({
    sources: z.array(z.object({ id: z.enum(METADATA_SOURCE_IDS), enabled: z.boolean() })).max(20).optional(),
    // Optional: rescan just one subtree instead of the whole library.
    folder: z.string().trim().max(1024).optional()
  });

  app.post("/api/library/gallery-libraries/:id/rescan", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const exists = db.prepare("SELECT id, source_path FROM libraries WHERE id = ? AND type = 'gallery'")
      .get(id) as Pick<LibraryRow, "id" | "source_path"> | undefined;
    if (!exists) {
      return reply.code(404).send({ error: "Gallery library not found" });
    }

    const parsed = parseBody(rescanOptionsSchema, request.body ?? {});
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid rescan options", details: parsed.error });
    }

    let root: string;
    try {
      root = validateLibrarySource(exists.source_path);
    } catch (err) {
      if (err instanceof LibrarySourceError) {
        return reply.code(422).send({ error: err.message });
      }
      throw err;
    }

    // Validate a folder scope up front so a bad path returns a clean 400 instead of
    // failing (and retrying) inside the scan worker.
    const folder = parsed.data.folder?.trim();
    if (folder) {
      try {
        relativePathWithinRoot(root, folder);
      } catch {
        return reply.code(400).send({ error: "That folder is not inside this library." });
      }
    }

    const jobId = enqueueGalleryScan(id, parsed.data);
    void processGalleryScanQueue();
    logActivity({
      event: "library.gallery.rescan",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: id,
      detail: folder ? `Queued a gallery rescan of "${folder}".` : "Queued a gallery library rescan.",
      ipAddress: request.ip
    });
    return reply.send({ job: { id: jobId, type: "SCAN_GALLERY_LIBRARY" } });
  });

  // ── Missing photos (reconcile tombstones: files gone from disk, hidden but retained) ──
  // Admin-only housekeeping: list them, tune the auto-purge window, or purge now.
  app.get("/api/library/gallery/missing", { preHandler: app.requireAdmin }, async () => {
    return listMissingGalleryPhotos();
  });

  const retentionSchema = z.object({ retentionDays: z.number().int().min(0).max(3650) });
  app.patch("/api/library/gallery/missing/retention", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(retentionSchema, request.body);
    if (parsed.error) { return reply.code(400).send({ error: "Invalid retention", details: parsed.error }); }
    const retentionDays = setMissingRetentionDays(parsed.data.retentionDays, request.user!.id);
    logActivity({
      event: "library.gallery.missing_retention",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: null,
      detail: retentionDays === 0 ? "Missing-photo auto-purge disabled." : `Missing-photo auto-purge set to ${retentionDays} days.`,
      ipAddress: request.ip
    });
    return reply.send({ retentionDays });
  });

  // Purge every tombstone past the grace window right now (the scheduled job on demand).
  // destructive: purging missing entries deletes their records and thumbnails —
  // refused from untrusted networks under the deletions-only policy.
  app.post("/api/library/gallery/missing/purge", { preHandler: app.requireAdmin, config: { destructive: true } }, async (request) => {
    return purgeMissingGalleryPhotos(undefined, request.user!.id);
  });

  // Purge one specific missing photo immediately, ignoring the grace window.
  app.delete("/api/library/gallery/missing/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!purgeMissingGalleryPhoto(id, request.user!.id)) {
      return reply.code(404).send({ error: "No such missing photo." });
    }
    return reply.send({ purged: true });
  });
}
