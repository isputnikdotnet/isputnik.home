import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { db, logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { audioExtensions, enqueueAudiobookScan, processAudiobookScanQueue, validateLibrarySource } from "./scanner.js";
import { z } from "zod";
import { audiobookLibrarySchema, publicAudiobookLibrary } from "./serializers.js";
import { canUserAccessLibrary, validateLibraryOwner, libraryCapabilities } from "../shared/library-access.js";
import { deleteSharesForLibrary } from "../shared/share-access.js";
import { deleteCollectionItemsForLibrary } from "../../collections/cleanup.js";
import type { AudiobookLibraryRow } from "./types.js";

export async function audiobookRoutesPlugin(app: FastifyInstance) {
  app.post("/api/library/audiobook-libraries", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(audiobookLibrarySchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid audiobook library details", details: parsed.error });
      return;
    }

    let sourcePath: string;
    try {
      sourcePath = validateLibrarySource(parsed.data.sourcePath);
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : "Invalid audiobook source path" });
      return;
    }

    const ownerId = parsed.data.ownerId ?? null;
    const ownerType = ownerId ? (parsed.data.ownerType ?? "user") : null;
    const visibility = parsed.data.visibility ?? "public";
    const publicRole = parsed.data.publicRole ?? "subscriber";

    const ownerError = validateLibraryOwner(ownerId, ownerType, "audiobook");
    if (ownerError) {
      reply.code(ownerError.status).send({ error: ownerError.error });
      return;
    }

    const libraryId = nanoid(16);
    const settings = {
      folder_structure: "author_book",
      default_language: parsed.data.defaultLanguage,
      ignore_sidecar: parsed.data.ignoreSidecar || undefined,
      show_narrator: true,
      supported_extensions: Array.from(audioExtensions).map((extension) => extension.slice(1)),
      cover_filenames: ["cover", "folder", "artwork"]
    };

    db.prepare(`
      INSERT INTO libraries (id, name, type, source_path, settings_json, created_by, owner_id, owner_type, visibility, public_role)
      VALUES (?, ?, 'audiobook', ?, ?, ?, ?, ?, ?, ?)
    `).run(libraryId, parsed.data.name, sourcePath, JSON.stringify(settings), request.user!.id, ownerId, ownerType, visibility, publicRole);

    const jobId = enqueueAudiobookScan(libraryId);
    void processAudiobookScanQueue();

    logActivity({
      event: "library.audiobook.created",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: libraryId,
      detail: `Created audiobook library "${parsed.data.name}" and queued a scan.`,
      ipAddress: request.ip
    });

    reply.code(201).send({ library: { id: libraryId }, job: { id: jobId, type: "SCAN_AUDIOBOOK_LIBRARY" } });
  });

  app.get("/api/library/audiobook-libraries", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const rows = db.prepare(`
      SELECT
        libraries.*,
        COUNT(DISTINCT books.id) AS book_count,
        COUNT(book_files.id) AS file_count
      FROM libraries
      LEFT JOIN books ON books.library_id = libraries.id AND books.deleted_at IS NULL
      LEFT JOIN book_files ON book_files.book_id = books.id AND book_files.status = 'available'
      WHERE libraries.type = 'audiobook'
      GROUP BY libraries.id
      ORDER BY datetime(libraries.created_at) DESC
    `).all() as AudiobookLibraryRow[];

    const accessible = rows.filter((row) => canUserAccessLibrary(row, user.id, user.role));

    return {
      libraries: accessible.map((row) =>
        publicAudiobookLibrary(row, user.role === "admin", libraryCapabilities(row, user.id, user.role)))
    };
  });

  const audiobookLibraryUpdateSchema = z.object({
    name: z.string().trim().min(2).max(120),
    ownerId: z.string().trim().min(1).max(64).nullable().optional(),
    ownerType: z.enum(["user", "group"]).nullable().optional(),
    visibility: z.enum(["private", "public"]),
    publicRole: z.enum(["viewer", "subscriber"]).default("subscriber")
  });

  app.patch("/api/library/audiobook-libraries/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const existing = db.prepare("SELECT id, name, settings_json FROM libraries WHERE id = ? AND type = 'audiobook'")
      .get(id) as { id: string; name: string; settings_json: string } | undefined;
    if (!existing) {
      reply.code(404).send({ error: "Audiobook library not found" });
      return;
    }

    const parsed = parseBody(audiobookLibraryUpdateSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid library details", details: parsed.error });
      return;
    }

    const settings = JSON.parse(existing.settings_json || "{}");

    const ownerId = parsed.data.ownerId ?? null;
    const ownerType = ownerId ? (parsed.data.ownerType ?? "user") : null;

    const ownerError = validateLibraryOwner(ownerId, ownerType, "audiobook", id);
    if (ownerError) {
      reply.code(ownerError.status).send({ error: ownerError.error });
      return;
    }

    db.prepare(`
      UPDATE libraries
      SET name = ?, owner_id = ?, owner_type = ?, visibility = ?, public_role = ?, settings_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(parsed.data.name, ownerId, ownerType, parsed.data.visibility, parsed.data.publicRole ?? "subscriber", JSON.stringify(settings), id);

    logActivity({
      event: "library.audiobook.updated",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: id,
      detail: `Updated audiobook library "${parsed.data.name}".`,
      ipAddress: request.ip
    });

    const updated = db.prepare(`
      SELECT libraries.*, COUNT(DISTINCT books.id) AS book_count, COUNT(book_files.id) AS file_count
      FROM libraries
      LEFT JOIN books ON books.library_id = libraries.id AND books.deleted_at IS NULL
      LEFT JOIN book_files ON book_files.book_id = books.id AND book_files.status = 'available'
      WHERE libraries.id = ?
      GROUP BY libraries.id
    `).get(id) as AudiobookLibraryRow;

    reply.send({ library: publicAudiobookLibrary(updated, true, libraryCapabilities(updated, request.user!.id, request.user!.role)) });
  });

  app.delete("/api/library/audiobook-libraries/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const exists = db.prepare("SELECT id, name FROM libraries WHERE id = ? AND type = 'audiobook'")
      .get(id) as { id: string; name: string } | undefined;
    if (!exists) {
      reply.code(404).send({ error: "Audiobook library not found" });
      return;
    }

    db.transaction(() => {
      // taggables is polymorphic (no FK to books), so clean up its rows before the
      // cascade removes the books and orphans them.
      db.prepare(`
        DELETE FROM taggables
        WHERE entity_type = 'book'
          AND entity_id IN (SELECT id FROM books WHERE library_id = ?)
      `).run(id);
      // shares/share_links are polymorphic too — clean them up before the cascade.
      deleteSharesForLibrary("audiobook", id);
      deleteCollectionItemsForLibrary("audiobook", id);
      db.prepare("DELETE FROM libraries WHERE id = ?").run(id);
    })();

    logActivity({
      event: "library.audiobook.deleted",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: id,
      detail: `Deleted audiobook library "${exists.name}". Files on disk were not removed.`,
      ipAddress: request.ip
    });

    reply.send({ deleted: true });
  });

  const rescanOptionsSchema = z.object({
    skipSidecar: z.boolean().optional(),
    tagEncoding: z.enum(["windows-1251", "windows-1250", "windows-1252", "koi8-r"]).optional()
  });

  app.post("/api/library/audiobook-libraries/:id/rescan", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const exists = db.prepare("SELECT id, name FROM libraries WHERE id = ? AND type = 'audiobook'")
      .get(id) as { id: string; name: string } | undefined;
    if (!exists) {
      reply.code(404).send({ error: "Audiobook library not found" });
      return;
    }

    const parsed = parseBody(rescanOptionsSchema, request.body ?? {});
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid rescan options", details: parsed.error });
      return;
    }

    const jobId = enqueueAudiobookScan(id, parsed.data);
    void processAudiobookScanQueue();
    const detailParts = [
      parsed.data.skipSidecar ? "skipping metadata.json" : null,
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
    reply.code(202).send({ job: { id: jobId, type: "SCAN_AUDIOBOOK_LIBRARY" } });
  });

}
