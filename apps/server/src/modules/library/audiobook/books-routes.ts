import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { rescanSingleBook } from "./scanner.js";
import { getAccessibleLibrary, canUserWriteLibrary, getLibraryForBook } from "../shared/library-access.js";
import { getAudiobookBookDetail, progressUpdateSchema, bulkMetadataSchema, BULK_METADATA_FIELDS, applyBulkMetadata, BOOK_LIST_COLUMNS, BOOK_LIST_JOINS, mapBookListRow, type BookListRow } from "./book-helpers.js";
import { resolveScopeLibraryIds, queryCatalog, catalogFacets } from "./catalog.js";

export function registerBookRoutes(app: FastifyInstance) {

  app.get("/api/library/audiobook-libraries/:id/books", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const library = getAccessibleLibrary(id, user.id, user.role, "audiobook");
    if (!library) {
      reply.code(404).send({ error: "Audiobook library not found" });
      return;
    }

    const books = db.prepare(`
      SELECT ${BOOK_LIST_COLUMNS}
      ${BOOK_LIST_JOINS}
      WHERE books.library_id = ?
        AND books.deleted_at IS NULL
      GROUP BY books.id
      ORDER BY COALESCE(book_metadata.sort_title, book_metadata.title, books.folder_path) COLLATE NOCASE
    `).all(user.id, user.id, id) as BookListRow[];

    return { books: books.map(mapBookListRow) };
  });

  // Paged, server-side searched/sorted/filtered catalog. Replaces loading every
  // book client-side. scope = all (every accessible library) | library.
  const catalogSchema = z.object({
    scope: z.enum(["all", "library"]).default("all"),
    libraryId: z.string().trim().min(1).optional(),
    q: z.string().trim().max(200).default(""),
    sort: z.enum(["title", "title_desc", "recent", "duration", "author", "series"]).default("title"),
    limit: z.number().int().min(1).max(200).default(48),
    offset: z.number().int().min(0).default(0),
    filters: z.object({
      authors: z.array(z.string()).default([]),
      narrators: z.array(z.string()).default([]),
      categories: z.array(z.string()).default([]),
      tags: z.array(z.string()).default([]),
      series: z.array(z.string()).default([]),
      languages: z.array(z.string()).default([]),
      status: z.array(z.string()).default([]),
      durations: z.array(z.string()).default([])
    }).default({ authors: [], narrators: [], categories: [], tags: [], series: [], languages: [], status: [], durations: [] })
  });

  app.post("/api/library/audiobooks/catalog", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(catalogSchema, request.body ?? {});
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid catalog query", details: parsed.error });
      return;
    }
    const p = parsed.data;
    const f = p.filters ?? {};
    const libIds = resolveScopeLibraryIds(request.user!, p.scope ?? "all", p.libraryId);
    reply.send(queryCatalog(request.user!.id, libIds, {
      q: p.q ?? "",
      sort: p.sort ?? "title",
      limit: p.limit ?? 48,
      offset: p.offset ?? 0,
      filters: {
        authors: f.authors ?? [],
        narrators: f.narrators ?? [],
        categories: f.categories ?? [],
        tags: f.tags ?? [],
        series: f.series ?? [],
        languages: f.languages ?? [],
        status: f.status ?? [],
        durations: f.durations ?? []
      }
    }));
  });

  app.get("/api/library/audiobooks/facets", { preHandler: app.authenticate }, async (request) => {
    const qp = request.query as { scope?: string; libraryId?: string };
    const scope = qp.scope === "library" ? qp.scope : "all";
    const libIds = resolveScopeLibraryIds(request.user!, scope, qp.libraryId);
    return catalogFacets(libIds);
  });


  // Bulk overwrite metadata across selected books. Write access is checked per
  // book's library; books the user can't write are skipped and reported back.
  app.post("/api/library/books/bulk-metadata", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(bulkMetadataSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid bulk metadata", details: parsed.error });
      return;
    }

    const hasField = BULK_METADATA_FIELDS.some((field) => parsed.data[field] !== undefined);
    if (!hasField) {
      reply.code(400).send({ error: "Provide at least one field to overwrite." });
      return;
    }

    const user = request.user!;
    let updated = 0;
    let forbidden = 0;
    let missing = 0;
    for (const bookId of parsed.data.bookIds) {
      const lib = getLibraryForBook(bookId);
      if (!lib) { missing += 1; continue; }
      if (!canUserWriteLibrary(lib, user.id, user.role)) { forbidden += 1; continue; }
      if (applyBulkMetadata(bookId, parsed.data)) { updated += 1; } else { missing += 1; }
    }

    if (updated === 0 && forbidden > 0) {
      reply.code(403).send({ error: "Write access required to edit the selected books." });
      return;
    }

    reply.send({ updated, forbidden, missing });
  });

  app.get("/api/library/books/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const book = getAudiobookBookDetail(id);
    if (!book) {
      reply.code(404).send({ error: "Audiobook not found" });
      return;
    }

    reply.send({ book });
  });


  app.get("/api/library/books/:id/progress", { preHandler: app.authenticate }, async (request, reply) => {
    const bookId = (request.params as { id: string }).id;
    const userId = request.user!.id;

    const row = db.prepare(`
      SELECT current_file_id, position_seconds, percent_complete, completed_at
      FROM playback_progress
      WHERE book_id = ? AND user_id = ?
    `).get(bookId, userId) as {
      current_file_id: string | null;
      position_seconds: number;
      percent_complete: number | null;
      completed_at: string | null;
    } | undefined;

    reply.send({
      progress: row
        ? {
            fileId: row.current_file_id,
            positionSeconds: row.position_seconds,
            percentComplete: row.percent_complete,
            completedAt: row.completed_at
          }
        : null
    });
  });


  app.patch("/api/library/books/:id/progress", { preHandler: app.authenticate }, async (request, reply) => {
    const bookId = (request.params as { id: string }).id;
    const userId = request.user!.id;
    const parsed = parseBody(progressUpdateSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid progress update", details: parsed.error });
      return;
    }

    const { fileId, positionSeconds } = parsed.data;

    const cumulative = db.prepare(`
      SELECT COALESCE(SUM(bf.duration_seconds), 0) AS before_seconds
      FROM book_files bf
      JOIN book_files current_file ON current_file.id = ? AND current_file.book_id = ? AND current_file.book_id = bf.book_id
      WHERE bf.track_number < current_file.track_number
        AND bf.status = 'available'
    `).get(fileId, bookId) as { before_seconds: number } | undefined;

    const currentFile = db.prepare(`
      SELECT id
      FROM book_files
      WHERE id = ?
        AND book_id = ?
        AND status = 'available'
    `).get(fileId, bookId);
    if (!currentFile) {
      reply.code(404).send({ error: "Audio file not found" });
      return;
    }

    const totalDuration = (db.prepare("SELECT duration_seconds FROM book_metadata WHERE book_id = ?").get(bookId) as { duration_seconds: number | null } | undefined)?.duration_seconds ?? null;

    const absoluteSeconds = (cumulative?.before_seconds ?? 0) + positionSeconds;
    const percentComplete = totalDuration ? Math.min(absoluteSeconds / totalDuration, 1) : null;
    const isComplete = percentComplete !== null && percentComplete >= 0.98;

    db.prepare(`
      INSERT INTO playback_progress (id, user_id, book_id, current_file_id, position_seconds, duration_seconds, percent_complete, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
      ON CONFLICT(user_id, book_id) DO UPDATE SET
        current_file_id = excluded.current_file_id,
        position_seconds = excluded.position_seconds,
        duration_seconds = excluded.duration_seconds,
        percent_complete = excluded.percent_complete,
        updated_at = CURRENT_TIMESTAMP,
        completed_at = CASE WHEN excluded.completed_at IS NOT NULL THEN excluded.completed_at ELSE completed_at END
    `).run(
      nanoid(16),
      userId,
      bookId,
      fileId,
      positionSeconds,
      totalDuration,
      percentComplete,
      isComplete ? new Date().toISOString() : null
    );

    reply.send({ updated: true });
  });


  app.post("/api/library/books/:id/progress/complete", { preHandler: app.authenticate }, async (request, reply) => {
    const bookId = (request.params as { id: string }).id;
    const userId = request.user!.id;
    const file = db.prepare(`
      SELECT id, duration_seconds
      FROM book_files
      WHERE book_id = ?
        AND status = 'available'
      ORDER BY track_number DESC, relative_path COLLATE NOCASE DESC
      LIMIT 1
    `).get(bookId) as { id: string; duration_seconds: number | null } | undefined;

    if (!file) {
      reply.code(404).send({ error: "No audio files available" });
      return;
    }

    const totalDuration = (db.prepare("SELECT duration_seconds FROM book_metadata WHERE book_id = ?").get(bookId) as { duration_seconds: number | null } | undefined)?.duration_seconds ?? null;
    db.prepare(`
      INSERT INTO playback_progress (id, user_id, book_id, current_file_id, position_seconds, duration_seconds, percent_complete, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, book_id) DO UPDATE SET
        current_file_id = excluded.current_file_id,
        position_seconds = excluded.position_seconds,
        duration_seconds = excluded.duration_seconds,
        percent_complete = 1,
        updated_at = CURRENT_TIMESTAMP,
        completed_at = CURRENT_TIMESTAMP
    `).run(nanoid(16), userId, bookId, file.id, file.duration_seconds ?? totalDuration ?? 0, totalDuration);

    reply.send({ updated: true });
  });


  app.delete("/api/library/books/:id/progress", { preHandler: app.authenticate }, async (request, reply) => {
    const bookId = (request.params as { id: string }).id;
    const userId = request.user!.id;
    db.prepare("DELETE FROM playback_progress WHERE book_id = ? AND user_id = ?").run(bookId, userId);
    reply.send({ reset: true });
  });


  const rescanBookSchema = z.object({
    skipSidecar: z.boolean().optional(),
    tagEncoding: z.enum(["windows-1251", "windows-1250", "windows-1252", "koi8-r"]).optional()
  });

  app.post("/api/library/books/:id/rescan", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const lib = getLibraryForBook(id);
    if (!lib || !canUserWriteLibrary(lib, user.id, user.role)) {
      reply.code(403).send({ error: "Write access required to rescan." });
      return;
    }

    const parsed = parseBody(rescanBookSchema, request.body ?? {});
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid rescan options", details: parsed.error });
      return;
    }

    let result: string | null;
    try {
      result = await rescanSingleBook(id, parsed.data);
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : "Rescan failed" });
      return;
    }
    if (!result) {
      reply.code(404).send({ error: "Audiobook folder not found or has no audio files." });
      return;
    }

    const book = getAudiobookBookDetail(id);
    reply.send({ rescanned: true, book });
  });
}
