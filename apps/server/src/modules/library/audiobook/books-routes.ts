import type { FastifyInstance } from "fastify";
import path from "node:path";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { rescanSingleBook } from "./scanner.js";
import { getAccessibleLibrary, canUserWriteLibrary, getLibraryForBook } from "../shared/library-access.js";
import { type AudiobookBookRow } from "./types.js";
import { largeCoverUrl, splitGroupConcat, categoryPayload, bookTags, getAudiobookBookDetail, progressUpdateSchema } from "./book-helpers.js";

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
      SELECT
        books.id,
        books.library_id,
        books.folder_path,
        books.status,
        books.discovered_at,
        books.updated_at,
        books.deleted_at,
        books.series_position,
        series.name AS series_name,
        book_metadata.title,
        book_metadata.sort_title,
        book_metadata.language,
        book_metadata.duration_seconds,
        book_metadata.cover_storage_key,
        book_metadata.publisher,
        book_metadata.asin,
        book_metadata.category_id,
        GROUP_CONCAT(DISTINCT authors.name) AS author_names,
        GROUP_CONCAT(DISTINCT narrators.name) AS narrator_names,
        progress.percent_complete AS progress_percent,
        progress.completed_at AS progress_completed_at,
        (
          SELECT COUNT(*)
          FROM book_files
          WHERE book_files.book_id = books.id
            AND book_files.status = 'available'
        ) AS file_count,
        (
          SELECT COALESCE(SUM(book_files.size), 0)
          FROM book_files
          WHERE book_files.book_id = books.id
            AND book_files.status = 'available'
        ) AS total_size
      FROM books
      LEFT JOIN series ON series.id = books.series_id
      LEFT JOIN book_metadata ON book_metadata.book_id = books.id
      LEFT JOIN book_authors ON book_authors.book_id = books.id AND book_authors.role = 'author'
      LEFT JOIN authors ON authors.id = book_authors.author_id
      LEFT JOIN book_authors AS book_narrators ON book_narrators.book_id = books.id AND book_narrators.role = 'narrator'
      LEFT JOIN authors AS narrators ON narrators.id = book_narrators.author_id
      LEFT JOIN playback_progress AS progress ON progress.book_id = books.id AND progress.user_id = ?
      WHERE books.library_id = ?
        AND books.deleted_at IS NULL
      GROUP BY books.id
      ORDER BY COALESCE(book_metadata.sort_title, book_metadata.title, books.folder_path) COLLATE NOCASE
    `).all(user.id, id) as (AudiobookBookRow & { series_name: string | null; series_position: number | null; category_id: string | null; progress_percent: number | null; progress_completed_at: string | null })[];

    return {
      books: books.map((book) => ({
        id: book.id,
        libraryId: book.library_id,
        folderPath: book.folder_path,
        status: book.status,
        title: book.title ?? path.basename(book.folder_path),
        sortTitle: book.sort_title,
        series: book.series_name ?? null,
        seriesPosition: book.series_position ?? null,
        language: book.language,
        authors: splitGroupConcat(book.author_names),
        narrators: splitGroupConcat(book.narrator_names),
        category: categoryPayload(book.category_id),
        tags: bookTags(book.id),
        fileCount: book.file_count,
        totalSize: book.total_size ?? 0,
        durationSeconds: book.duration_seconds,
        coverUrl: book.cover_storage_key ? `/api/library/covers/${book.cover_storage_key}` : null,
        coverLargeUrl: largeCoverUrl(book.cover_storage_key),
        publisher: book.publisher,
        asin: book.asin,
        progress: {
          percentComplete: book.progress_percent,
          completedAt: book.progress_completed_at
        },
        discoveredAt: book.discovered_at,
        updatedAt: book.updated_at
      }))
    };
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
