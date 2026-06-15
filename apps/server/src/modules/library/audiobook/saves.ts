import { z } from "zod";
import type { FastifyInstance } from "fastify";
import path from "node:path";
import { nanoid } from "nanoid";
import { db } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { getLibraryForBook, canUserAccessLibrary } from "../shared/library-access.js";
import { bookLibraryIds } from "../feed.js";

const saveSchema = z.object({
  note: z.string().trim().max(2000).nullable().optional()
});

interface SavedBookRow {
  id: string;
  kind: "audiobook" | "ebook";
  folder_path: string;
  title: string | null;
  cover_storage_key: string | null;
  author_names: string | null;
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
    // Favorites span every book-like library type (audiobooks + ebooks). The save
    // itself is book-id based and type-agnostic; this just lists across them.
    const libIds = bookLibraryIds(user);
    if (libIds.length === 0) {
      reply.send({ books: [] });
      return;
    }
    const inLibs = libIds.map(() => "?").join(", ");

    const rows = db.prepare(`
      SELECT
        books.id,
        libraries.type AS kind,
        books.folder_path,
        book_metadata.title,
        book_metadata.cover_storage_key,
        GROUP_CONCAT(DISTINCT authors.name) AS author_names,
        book_saves.note AS save_note,
        book_saves.updated_at AS saved_at
      FROM book_saves
      JOIN books ON books.id = book_saves.book_id AND books.deleted_at IS NULL
      JOIN libraries ON libraries.id = books.library_id
      LEFT JOIN book_metadata ON book_metadata.book_id = books.id
      LEFT JOIN book_authors ON book_authors.book_id = books.id AND book_authors.role = 'author'
      LEFT JOIN authors ON authors.id = book_authors.author_id
      WHERE book_saves.user_id = ? AND books.library_id IN (${inLibs})
      GROUP BY books.id
      ORDER BY datetime(book_saves.updated_at) DESC
    `).all(user.id, ...libIds) as SavedBookRow[];

    reply.send({
      books: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        title: row.title ?? path.basename(row.folder_path),
        authors: splitNames(row.author_names),
        coverUrl: row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null,
        note: row.save_note,
        savedAt: row.saved_at
      }))
    });
  });
}
