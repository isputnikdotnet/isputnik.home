import type { FastifyInstance } from "fastify";
import { db, logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { enqueueAudiobookScan, processAudiobookScanQueue } from "./scanner.js";
import { z } from "zod";
import { canUserAccessLibrary, libraryCapabilities, deleteLibraryAccess } from "../shared/library-access.js";
import { publicLibrary } from "../shared/library-serializer.js";
import { coreLibraryCreateSchema, coreLibraryUpdateSchema, createLibraryRecord, updateLibraryRecord } from "../shared/library-crud.js";
import { setDefaultLayout, isScanRuleError } from "../shared/scan-rules.js";
import { validateLayouts } from "../shared/scan-rule-pattern.js";
import { METADATA_SOURCE_IDS } from "../shared/metadata-sources.js";
import { validateLibrarySource, LibrarySourceError } from "../shared/library-source.js";
import { deleteSharesForLibrary } from "../shared/share-access.js";
import { deleteCollectionItemsForLibrary } from "../../collections/cleanup.js";
import { removeThumbnailsForLibrary } from "../shared/thumbnail.js";
import type { AudiobookLibraryRow } from "./types.js";

const AUDIOBOOK_LIBRARY_LIST_SQL = `
  SELECT
    libraries.*,
    COUNT(DISTINCT library_items.id) AS book_count,
    COUNT(audio_files.id) AS file_count,
    COALESCE(SUM(COALESCE(audio_files.size, 0)), 0) AS total_size_bytes
  FROM libraries
  LEFT JOIN library_items ON library_items.library_id = libraries.id AND library_items.deleted_at IS NULL
  LEFT JOIN audio_files ON audio_files.item_id = library_items.id AND audio_files.status = 'available' AND audio_files.deleted_at IS NULL
  WHERE libraries.type = 'audiobook' %WHERE%
  GROUP BY libraries.id
  ORDER BY datetime(libraries.created_at) DESC
`;

export async function audiobookRoutesPlugin(app: FastifyInstance) {
  app.post("/api/library/audiobook-libraries", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(coreLibraryCreateSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid audiobook library details", details: parsed.error });
    }

    // A bad default layout must not leave a library behind without one.
    const layoutError = parsed.data.defaultLayouts ? validateLayouts(parsed.data.defaultLayouts, "audiobook")[0] : undefined;
    if (layoutError) {
      return reply.code(400).send({ error: layoutError });
    }

    const result = createLibraryRecord({
      type: "audiobook",
      data: parsed.data,
      userId: request.user!.id,
      ip: request.ip,
      extraSettings: {
        show_narrator: true,
        cover_filenames: ["cover", "folder", "artwork"]
      }
    });
    if ("error" in result) {
      return reply.code(result.status).send({ error: result.error });
    }

    if (parsed.data.defaultLayouts) {
      const layout = setDefaultLayout(result.libraryId, { layouts: parsed.data.defaultLayouts });
      if (isScanRuleError(layout)) {
        return reply.code(400).send({ error: layout.error });
      }
    }

    const jobId = enqueueAudiobookScan(result.libraryId);
    void processAudiobookScanQueue();

    return reply.code(201).send({ library: { id: result.libraryId }, job: { id: jobId, type: "SCAN_AUDIOBOOK_LIBRARY" } });
  });

  app.get("/api/library/audiobook-libraries", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const rows = db.prepare(AUDIOBOOK_LIBRARY_LIST_SQL.replace("%WHERE%", "")).all() as AudiobookLibraryRow[];

    // Control Panel passes ?manage=1: admins then see ALL libraries (to administer the
    // system), even private ones they can't access — those show with no caps + a
    // take-ownership action. The default (consumer) view shows only accessible libraries.
    const manageAll = (request.query as { manage?: string }).manage != null && user.role === "admin";
    const visible = manageAll ? rows : rows.filter((row) => canUserAccessLibrary(row, user.id, user.role));

    return {
      libraries: visible.map((row) =>
        publicLibrary(row, user.role === "admin", libraryCapabilities(row, user.id, user.role)))
    };
  });

  app.patch("/api/library/audiobook-libraries/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;

    const parsed = parseBody(coreLibraryUpdateSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid library details", details: parsed.error });
    }

    const result = updateLibraryRecord({
      type: "audiobook",
      id,
      data: parsed.data,
      userId: request.user!.id,
      ip: request.ip
    });
    if ("error" in result) {
      return reply.code(result.status).send({ error: result.error });
    }

    const updated = db.prepare(AUDIOBOOK_LIBRARY_LIST_SQL.replace("%WHERE%", "AND libraries.id = ?")).get(id) as AudiobookLibraryRow;

    return reply.send({ library: publicLibrary(updated, true, libraryCapabilities(updated, request.user!.id, request.user!.role)) });
  });

  app.delete("/api/library/audiobook-libraries/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const exists = db.prepare("SELECT id, name FROM libraries WHERE id = ? AND type = 'audiobook'")
      .get(id) as { id: string; name: string } | undefined;
    if (!exists) {
      return reply.code(404).send({ error: "Audiobook library not found" });
    }

    db.transaction(() => {
      // taggables is polymorphic (no FK to books), so clean up its rows before the
      // cascade removes the books and orphans them.
      db.prepare(`
        DELETE FROM taggables
        WHERE entity_type = 'library_item'
          AND entity_id IN (SELECT id FROM library_items WHERE library_id = ?)
      `).run(id);
      // shares/share_links are polymorphic too — clean them up before the cascade.
      deleteSharesForLibrary("audiobook", id);
      deleteCollectionItemsForLibrary("audiobook", id);
      deleteLibraryAccess(id);
      db.prepare("DELETE FROM libraries WHERE id = ?").run(id);
    })();
    removeThumbnailsForLibrary(id);

    logActivity({
      event: "library.audiobook.deleted",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: id,
      detail: `Deleted audiobook library "${exists.name}". Source files on disk were not removed; generated thumbnails were deleted.`,
      ipAddress: request.ip
    });

    return reply.send({ deleted: true });
  });

  const rescanOptionsSchema = z.object({
    // One-shot override of the library's persisted scan_sources for this run only.
    sources: z.array(z.object({
      id: z.enum(METADATA_SOURCE_IDS),
      enabled: z.boolean()
    })).max(20).optional(),
    tagEncoding: z.enum(["windows-1251", "windows-1250", "windows-1252", "koi8-r"]).optional()
  });

  app.post("/api/library/audiobook-libraries/:id/rescan", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const exists = db.prepare("SELECT id, name, source_path FROM libraries WHERE id = ? AND type = 'audiobook'")
      .get(id) as { id: string; name: string; source_path: string } | undefined;
    if (!exists) {
      return reply.code(404).send({ error: "Audiobook library not found" });
    }

    const parsed = parseBody(rescanOptionsSchema, request.body ?? {});
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid rescan options", details: parsed.error });
    }

    // Catch a missing/inaccessible source folder now, so the user gets an immediate
    // error instead of a library stuck on "scanning" while the job retries.
    try {
      validateLibrarySource(exists.source_path);
    } catch (err) {
      if (err instanceof LibrarySourceError) {
        return reply.code(422).send({ error: err.message });
      }
      throw err;
    }

    const jobId = enqueueAudiobookScan(id, parsed.data);
    void processAudiobookScanQueue();
    const detailParts = [
      parsed.data.sources ? `sources ${parsed.data.sources.filter((s) => s.enabled).map((s) => s.id).join(" > ") || "none"}` : null,
      parsed.data.tagEncoding ? `tag encoding ${parsed.data.tagEncoding}` : null
    ].filter(Boolean);
    logActivity({
      event: "library.audiobook.scan_queued",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: id,
      detail: `Queued scan for audiobook library "${exists.name}"${detailParts.length ? ` (${detailParts.join(", ")})` : ""}.`,
      ipAddress: request.ip
    });
    return reply.code(202).send({ job: { id: jobId, type: "SCAN_AUDIOBOOK_LIBRARY" } });
  });

}
