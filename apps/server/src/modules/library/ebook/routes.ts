import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import { db, logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { canUserAccessLibrary } from "../shared/library-access.js";
import { deleteSharesForLibrary } from "../shared/share-access.js";
import { deleteCollectionItemsForLibrary } from "../../collections/cleanup.js";
import { validateLibrarySource } from "../audiobook/scanner.js";
import { enqueueEbookScan, processEbookScanQueue } from "./scanner.js";

const ebookLibrarySchema = z.object({
  name: z.string().trim().min(1).max(120),
  sourcePath: z.string().trim().min(1),
  defaultLanguage: z.string().trim().max(20).optional(),
  ownerId: z.string().trim().nullable().optional(),
  ownerType: z.enum(["user", "group"]).nullable().optional(),
  visibility: z.enum(["private", "public"]).optional()
});

interface EbookLibraryRow {
  id: string;
  name: string;
  source_path: string;
  scan_status: string;
  last_scanned_at: string | null;
  owner_id: string | null;
  owner_type: "user" | "group" | null;
  visibility: "private" | "public";
  created_at: string;
  book_count: number;
}

function publicEbookLibrary(row: EbookLibraryRow, includeSourcePath: boolean) {
  return {
    id: row.id,
    name: row.name,
    sourcePath: includeSourcePath ? row.source_path : undefined,
    scanStatus: row.scan_status,
    lastScannedAt: row.last_scanned_at,
    ownerId: row.owner_id,
    ownerType: row.owner_type,
    visibility: row.visibility,
    bookCount: row.book_count
  };
}

export async function ebookRoutesPlugin(app: FastifyInstance) {
  app.post("/api/library/ebook-libraries", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(ebookLibrarySchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid ebook library details", details: parsed.error });
      return;
    }

    let sourcePath: string;
    try {
      sourcePath = validateLibrarySource(parsed.data.sourcePath);
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : "Invalid source path" });
      return;
    }

    const ownerId = parsed.data.ownerId ?? null;
    const ownerType = ownerId ? (parsed.data.ownerType ?? "user") : null;
    const visibility = parsed.data.visibility ?? "public";
    const libraryId = nanoid(16);
    const settings = { default_language: parsed.data.defaultLanguage };

    db.prepare(`
      INSERT INTO libraries (id, name, type, source_path, settings_json, created_by, owner_id, owner_type, visibility)
      VALUES (?, ?, 'ebook', ?, ?, ?, ?, ?, ?)
    `).run(libraryId, parsed.data.name, sourcePath, JSON.stringify(settings), request.user!.id, ownerId, ownerType, visibility);

    const jobId = enqueueEbookScan(libraryId);
    void processEbookScanQueue();

    logActivity({
      event: "library.ebook.created",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: libraryId,
      detail: `Created ebook library "${parsed.data.name}" and queued a scan.`,
      ipAddress: request.ip
    });

    reply.code(201).send({ library: { id: libraryId }, job: { id: jobId, type: "SCAN_EBOOK_LIBRARY" } });
  });

  app.get("/api/library/ebook-libraries", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const rows = db.prepare(`
      SELECT libraries.*, COUNT(DISTINCT books.id) AS book_count
      FROM libraries
      LEFT JOIN books ON books.library_id = libraries.id AND books.deleted_at IS NULL
      WHERE libraries.type = 'ebook'
      GROUP BY libraries.id
      ORDER BY datetime(libraries.created_at) DESC
    `).all() as EbookLibraryRow[];

    const accessible = rows.filter((row) => canUserAccessLibrary(row, user.id, user.role));
    return { libraries: accessible.map((row) => publicEbookLibrary(row, user.role === "admin")) };
  });

  app.get("/api/library/ebook-libraries/:id/books", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const library = db.prepare("SELECT id, owner_id, owner_type, visibility FROM libraries WHERE id = ? AND type = 'ebook'")
      .get(id) as { id: string; owner_id: string | null; owner_type: string | null; visibility: string } | undefined;
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
        book_metadata.title,
        book_metadata.year_published,
        book_metadata.language,
        book_metadata.cover_storage_key,
        categories.key AS category_key,
        categories.name AS category_name,
        GROUP_CONCAT(DISTINCT authors.name) AS author_names,
        (SELECT format FROM book_documents WHERE book_id = books.id AND status = 'available' LIMIT 1) AS format,
        (SELECT COUNT(*) FROM book_documents WHERE book_id = books.id AND status = 'available') AS file_count,
        (SELECT COALESCE(SUM(size), 0) FROM book_documents WHERE book_id = books.id AND status = 'available') AS total_size
      FROM books
      LEFT JOIN book_metadata ON book_metadata.book_id = books.id
      LEFT JOIN categories ON categories.id = book_metadata.category_id
      LEFT JOIN book_authors ON book_authors.book_id = books.id AND book_authors.role = 'author'
      LEFT JOIN authors ON authors.id = book_authors.author_id
      WHERE books.library_id = ? AND books.deleted_at IS NULL
      GROUP BY books.id
      ORDER BY COALESCE(book_metadata.sort_title, book_metadata.title, books.folder_path) COLLATE NOCASE
    `).all(id) as {
      id: string; library_id: string; folder_path: string; status: string; discovered_at: string;
      title: string | null; year_published: number | null; language: string | null;
      cover_storage_key: string | null; category_key: string | null; category_name: string | null;
      author_names: string | null; format: string | null; file_count: number; total_size: number;
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
          discoveredAt: row.discovered_at
        };
      })
    };
  });

  app.post("/api/library/ebook-libraries/:id/rescan", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const exists = db.prepare("SELECT id FROM libraries WHERE id = ? AND type = 'ebook'").get(id);
    if (!exists) {
      reply.code(404).send({ error: "Ebook library not found" });
      return;
    }
    const jobId = enqueueEbookScan(id);
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
      deleteSharesForLibrary(id);
      deleteCollectionItemsForLibrary(id);
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
