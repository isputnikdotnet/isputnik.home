import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { canUserAccessLibrary, libraryCapabilities, deleteLibraryAccess } from "../shared/library-access.js";
import { publicLibrary, type LibraryListRow } from "../shared/library-serializer.js";
import { deleteSharesForLibrary } from "../shared/share-access.js";
import { deleteCollectionItemsForLibrary } from "../../collections/cleanup.js";
import { coreLibraryCreateSchema, coreLibraryUpdateSchema, createLibraryRecord, updateLibraryRecord } from "../shared/library-crud.js";
import { METADATA_SOURCE_IDS } from "../shared/metadata-sources.js";
import { enqueueEbookScan, processEbookScanQueue } from "./scanner.js";

const EBOOK_LIBRARY_LIST_SQL = `
  SELECT
    libraries.*,
    COUNT(DISTINCT books.id) AS book_count,
    COUNT(book_documents.id) AS file_count,
    COALESCE(SUM(COALESCE(book_documents.size, 0)), 0) AS total_size_bytes
  FROM libraries
  LEFT JOIN books ON books.library_id = libraries.id AND books.deleted_at IS NULL
  LEFT JOIN book_documents ON book_documents.book_id = books.id AND book_documents.status = 'available' AND book_documents.deleted_at IS NULL
  WHERE libraries.type = 'ebook' %WHERE%
  GROUP BY libraries.id
  ORDER BY datetime(libraries.created_at) DESC
`;

export async function ebookRoutesPlugin(app: FastifyInstance) {
  app.post("/api/library/ebook-libraries", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(coreLibraryCreateSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid ebook library details", details: parsed.error });
      return;
    }

    const result = createLibraryRecord({
      type: "ebook",
      data: parsed.data,
      userId: request.user!.id,
      ip: request.ip
    });
    if ("error" in result) {
      reply.code(result.status).send({ error: result.error });
      return;
    }

    const jobId = enqueueEbookScan(result.libraryId);
    void processEbookScanQueue();

    reply.code(201).send({ library: { id: result.libraryId }, job: { id: jobId, type: "SCAN_EBOOK_LIBRARY" } });
  });

  app.get("/api/library/ebook-libraries", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const rows = db.prepare(EBOOK_LIBRARY_LIST_SQL.replace("%WHERE%", "")).all() as LibraryListRow[];

    const manageAll = (request.query as { manage?: string }).manage != null && user.role === "admin";
    const visible = manageAll ? rows : rows.filter((row) => canUserAccessLibrary(row, user.id, user.role));
    return { libraries: visible.map((row) => publicLibrary(row, user.role === "admin", libraryCapabilities(row, user.id, user.role))) };
  });

  app.patch("/api/library/ebook-libraries/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;

    const parsed = parseBody(coreLibraryUpdateSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid library details", details: parsed.error });
      return;
    }

    const result = updateLibraryRecord({
      type: "ebook",
      id,
      data: parsed.data,
      userId: request.user!.id,
      ip: request.ip
    });
    if ("error" in result) {
      reply.code(result.status).send({ error: result.error });
      return;
    }

    const updated = db.prepare(EBOOK_LIBRARY_LIST_SQL.replace("%WHERE%", "AND libraries.id = ?")).get(id) as LibraryListRow;
    reply.send({ library: publicLibrary(updated, true, libraryCapabilities(updated, request.user!.id, request.user!.role)) });
  });

  app.get("/api/library/ebook-libraries/:id/books", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const library = db.prepare("SELECT id FROM libraries WHERE id = ? AND type = 'ebook'")
      .get(id) as { id: string } | undefined;
    if (!library || !canUserAccessLibrary(library, user.id, user.role)) {
      reply.code(404).send({ error: "Ebook library not found" });
      return;
    }

    const rows = db.prepare(`
      SELECT
        books.id,
        books.library_id,
        books.folder_path,
        books.status,
        books.discovered_at,
        books.updated_at,
        book_metadata.title,
        book_metadata.year_published,
        book_metadata.language,
        book_metadata.cover_storage_key,
        categories.key AS category_key,
        categories.name AS category_name,
        GROUP_CONCAT(DISTINCT authors.name) AS author_names,
        (SELECT format FROM book_documents WHERE book_id = books.id AND status = 'available' LIMIT 1) AS format,
        (SELECT COUNT(*) FROM book_documents WHERE book_id = books.id AND status = 'available') AS file_count,
        (SELECT COALESCE(SUM(size), 0) FROM book_documents WHERE book_id = books.id AND status = 'available') AS total_size,
        (SELECT reading_progress.percent_complete FROM reading_progress WHERE reading_progress.book_id = books.id AND reading_progress.user_id = ? ORDER BY datetime(reading_progress.updated_at) DESC LIMIT 1) AS progress_percent,
        (SELECT reading_progress.completed_at FROM reading_progress WHERE reading_progress.book_id = books.id AND reading_progress.user_id = ? ORDER BY datetime(reading_progress.updated_at) DESC LIMIT 1) AS progress_completed_at,
        (SELECT book_saves.id IS NOT NULL FROM book_saves WHERE book_saves.book_id = books.id AND book_saves.user_id = ? LIMIT 1) AS saved
      FROM books
      LEFT JOIN book_metadata ON book_metadata.book_id = books.id
      LEFT JOIN categories ON categories.id = book_metadata.category_id
      LEFT JOIN book_authors ON book_authors.book_id = books.id AND book_authors.role = 'author'
      LEFT JOIN authors ON authors.id = book_authors.author_id
      WHERE books.library_id = ? AND books.deleted_at IS NULL
      GROUP BY books.id
      ORDER BY COALESCE(book_metadata.sort_title, book_metadata.title, books.folder_path) COLLATE NOCASE
    `).all(user.id, user.id, user.id, id) as {
      id: string; library_id: string; folder_path: string; status: string; discovered_at: string; updated_at: string;
      title: string | null; year_published: number | null; language: string | null;
      cover_storage_key: string | null; category_key: string | null; category_name: string | null;
      author_names: string | null; format: string | null; file_count: number; total_size: number;
      progress_percent: number | null; progress_completed_at: string | null; saved: number | null;
    }[];

    const tagsFor = db.prepare(`
      SELECT tags.display_name AS name FROM taggables
      JOIN tags ON tags.id = taggables.tag_id
      WHERE taggables.entity_type = 'book' AND taggables.entity_id = ?
      ORDER BY tags.display_name COLLATE NOCASE
    `);

    return {
      books: rows.map((row) => {
        const coverUrl = row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null;
        return {
          id: row.id,
          libraryId: row.library_id,
          folderPath: row.folder_path,
          status: row.status,
          title: row.title ?? row.folder_path.split("/").pop() ?? row.folder_path,
          series: null,
          seriesPosition: null,
          authors: row.author_names ? row.author_names.split(",").map((n) => n.trim()).filter(Boolean) : [],
          narrators: [],
          category: row.category_key && row.category_name ? { key: row.category_key, name: row.category_name } : null,
          tags: (tagsFor.all(row.id) as { name: string }[]).map((t) => t.name),
          language: row.language,
          format: row.format,
          fileCount: row.file_count,
          totalSize: row.total_size,
          durationSeconds: null,
          yearPublished: row.year_published,
          coverUrl,
          coverLargeUrl: coverUrl ? coverUrl.replace("-cover.webp", "-cover-large.webp") : null,
          publisher: null,
          asin: null,
          progress: {
            percentComplete: row.progress_percent,
            completedAt: row.progress_completed_at
          },
          saved: Boolean(row.saved),
          discoveredAt: row.discovered_at,
          updatedAt: row.updated_at
        };
      })
    };
  });

  const rescanOptionsSchema = z.object({
    // One-shot override of the library's persisted scan_sources for this run only.
    sources: z.array(z.object({
      id: z.enum(METADATA_SOURCE_IDS),
      enabled: z.boolean()
    })).max(20).optional()
  });

  app.post("/api/library/ebook-libraries/:id/rescan", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const exists = db.prepare("SELECT id FROM libraries WHERE id = ? AND type = 'ebook'").get(id);
    if (!exists) {
      reply.code(404).send({ error: "Ebook library not found" });
      return;
    }

    const parsed = parseBody(rescanOptionsSchema, request.body ?? {});
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid rescan options", details: parsed.error });
      return;
    }

    const jobId = enqueueEbookScan(id, parsed.data);
    void processEbookScanQueue();
    logActivity({
      event: "library.ebook.rescan",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: id,
      detail: "Queued an ebook library rescan.",
      ipAddress: request.ip
    });
    reply.send({ job: { id: jobId, type: "SCAN_EBOOK_LIBRARY" } });
  });

  app.delete("/api/library/ebook-libraries/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const exists = db.prepare("SELECT id, name FROM libraries WHERE id = ? AND type = 'ebook'")
      .get(id) as { id: string; name: string } | undefined;
    if (!exists) {
      reply.code(404).send({ error: "Ebook library not found" });
      return;
    }

    db.transaction(() => {
      db.prepare("DELETE FROM taggables WHERE entity_type = 'book' AND entity_id IN (SELECT id FROM books WHERE library_id = ?)").run(id);
      deleteSharesForLibrary("ebook", id);
      deleteCollectionItemsForLibrary("ebook", id);
      deleteLibraryAccess(id);
      db.prepare("DELETE FROM libraries WHERE id = ?").run(id);
    })();

    logActivity({
      event: "library.ebook.deleted",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: id,
      detail: `Deleted ebook library "${exists.name}". Files on disk were not removed.`,
      ipAddress: request.ip
    });
    reply.send({ deleted: true });
  });
}
