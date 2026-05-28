import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { db, logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { audioExtensions, enqueueAudiobookScan, processAudiobookScanQueue, validateLibrarySource } from "./scanner.js";
import { audiobookLibrarySchema, publicAudiobookLibrary } from "./serializers.js";
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

    const libraryId = nanoid(16);
    const settings = {
      folder_structure: "author_book",
      default_language: parsed.data.defaultLanguage,
      show_narrator: true,
      supported_extensions: Array.from(audioExtensions).map((extension) => extension.slice(1)),
      cover_filenames: ["cover", "folder", "artwork"]
    };

    db.prepare(`
      INSERT INTO libraries (id, name, type, source_path, settings_json, created_by)
      VALUES (?, ?, 'audiobook', ?, ?, ?)
    `).run(libraryId, parsed.data.name, sourcePath, JSON.stringify(settings), request.user!.id);

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

    return {
      libraries: rows.map((row) => publicAudiobookLibrary(row, request.user?.role === "admin"))
    };
  });

  app.post("/api/library/audiobook-libraries/:id/rescan", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const exists = db.prepare("SELECT id, name FROM libraries WHERE id = ? AND type = 'audiobook'")
      .get(id) as { id: string; name: string } | undefined;
    if (!exists) {
      reply.code(404).send({ error: "Audiobook library not found" });
      return;
    }

    const jobId = enqueueAudiobookScan(id);
    void processAudiobookScanQueue();
    logActivity({
      event: "library.audiobook.scan_queued",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: id,
      detail: `Queued scan for audiobook library "${exists.name}".`,
      ipAddress: request.ip
    });
    reply.code(202).send({ job: { id: jobId, type: "SCAN_AUDIOBOOK_LIBRARY" } });
  });

}
