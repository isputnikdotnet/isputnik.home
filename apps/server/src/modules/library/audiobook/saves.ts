import { z } from "zod";
import type { FastifyInstance } from "fastify";
import path from "node:path";
import { nanoid } from "nanoid";
import { db } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { getLibraryForBook, canUserAccessLibrary, accessibleLibraryIds } from "../shared/library-access.js";

const saveSchema = z.object({
  note: z.string().trim().max(2000).nullable().optional()
});

interface SavedBookRow {
  id: string;
  library_id: string;
  folder_path: string;
  series_name: string | null;
  series_position: number | null;
  title: string | null;
  duration_seconds: number | null;
  cover_storage_key: string | null;
  author_names: string | null;
  file_count: number;
  save_note: string | null;
  saved_at: string;
}

function splitNames(value: string | null) {
  return value ? value.split(",").map((name) => name.trim()).filter(Boolean) : [];
}

function currentSave(bookId: string, userId: string) {
  const row = db.prepare(`
    SELECT id, note, created_at, updated_at FROM book_saves WHERE book_id = ? AND user_id = ?
  `).get(bookId, userId) as { id: string; note: string | null; created_at: string; updated_at: string } | undefined;
  return row ? { saved: true, note: row.note, createdAt: row.created_at, updatedAt: row.updated_at } : { saved: false, note: null };
}

export async function audiobookSavesPlugin(app: FastifyInstance) {
  app.get("/api/library/books/:id/save", { preHandler: app.authenticate }, async (request, reply) => {
    const bookId = (request.params as { id: string }).id;
    const user = request.user!;
    const library = getLibraryForBook(bookId);
    if (!library || !canUserAccessLibrary(library, user.id, user.role)) {
      reply.code(404).send({ error: "Audiobook not found" });
      return;
    }
    reply.send({ save: currentSave(bookId, user.id) });
  });

  app.put("/api/library/books/:id/save", { preHandler: app.authenticate }, async (request, reply) => {
    const bookId = (request.params as { id: string }).id;
    const user = request.user!;
    const library = getLibraryForBook(bookId);
    if (!library || !canUserAccessLibrary(library, user.id, user.role)) {
      reply.code(404).send({ error: "Audiobook not found" });
      return;
    }

    const parsed = parseBody(saveSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid save", details: parsed.error });
      return;
    }

    db.prepare(`
      INSERT INTO book_saves (id, user_id, book_id, note)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, book_id) DO UPDATE SET
        note = excluded.note,
        updated_at = CURRENT_TIMESTAMP
    `).run(nanoid(16), user.id, bookId, parsed.data.note ?? null);

    reply.send({ save: currentSave(bookId, user.id) });
  });

  app.delete("/api/library/books/:id/save", { preHandler: app.authenticate }, async (request, reply) => {
    const bookId = (request.params as { id: string }).id;
    const user = request.user!;
    db.prepare("DELETE FROM book_saves WHERE book_id = ? AND user_id = ?").run(bookId, user.id);
    reply.send({ save: { saved: false, note: null } });
  });

  app.get("/api/library/saved", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const rows = db.prepare(`
      SELECT
        books.id,
        books.library_id,
        books.folder_path,
        series.name AS series_name,
        books.series_position,
        book_metadata.title,
        book_metadata.duration_seconds,
        book_metadata.cover_storage_key,
        GROUP_CONCAT(DISTINCT authors.name) AS author_names,
        (
          SELECT COUNT(*) FROM book_files
          WHERE book_files.book_id = books.id AND book_files.status = 'available'
        ) AS file_count,
        book_saves.note AS save_note,
        book_saves.updated_at AS saved_at
      FROM book_saves
      JOIN books ON books.id = book_saves.book_id AND books.deleted_at IS NULL
      JOIN libraries ON libraries.id = books.library_id
      LEFT JOIN series ON series.id = books.series_id
      LEFT JOIN book_metadata ON book_metadata.book_id = books.id
      LEFT JOIN book_authors ON book_authors.book_id = books.id AND book_authors.role = 'author'
      LEFT JOIN authors ON authors.id = book_authors.author_id
      WHERE book_saves.user_id = ?
      GROUP BY books.id
      ORDER BY datetime(book_saves.updated_at) DESC
    `).all(user.id) as SavedBookRow[];

    // row.id is the BOOK id — access resolves by library id, precomputed once.
    const allowed = accessibleLibraryIds(user.id, user.role, "audiobook");
    const accessible = rows.filter((row) => allowed.has(row.library_id));

    reply.send({
      books: accessible.map((row) => ({
        id: row.id,
        libraryId: row.library_id,
        title: row.title ?? path.basename(row.folder_path),
        series: row.series_name ?? null,
        seriesPosition: row.series_position ?? null,
        authors: splitNames(row.author_names),
        durationSeconds: row.duration_seconds,
        fileCount: row.file_count,
        coverUrl: row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null,
        note: row.save_note,
        savedAt: row.saved_at
      }))
    });
  });
}
