import { z } from "zod";
import type { FastifyInstance } from "fastify";
import path from "node:path";
import { nanoid } from "nanoid";
import { db } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { getLibraryForBook, canUserAccessBook, canUserAccessLibrary, accessibleLibraryIds } from "../shared/library-access.js";
import { userHasItemShare } from "../shared/share-access.js";

interface BookmarkRow {
  id: string;
  file_id: string | null;
  position_seconds: number;
  book_position_seconds: number | null;
  label: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

// A bookmark joined with its parent book, for the cross-library "all my
// bookmarks" listing on the profile page.
interface BookmarkWithBookRow extends BookmarkRow {
  book_id: string;
  library_id: string;
  folder_path: string;
  title: string | null;
  cover_storage_key: string | null;
  author_names: string | null;
}

function splitNames(value: string | null) {
  return value ? value.split(",").map((name) => name.trim()).filter(Boolean) : [];
}

function publicBookmark(row: BookmarkRow) {
  return {
    id: row.id,
    fileId: row.file_id,
    positionSeconds: row.position_seconds,
    bookPositionSeconds: row.book_position_seconds,
    label: row.label,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const createSchema = z.object({
  fileId: z.string().min(1),
  positionSeconds: z.number().int().min(0),
  label: z.string().trim().max(120).optional(),
  note: z.string().trim().max(2000).optional()
});

const updateSchema = z.object({
  label: z.string().trim().max(120).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional()
});

// Absolute offset within the whole book = duration of all earlier tracks + offset in the current file.
function bookPositionFor(bookId: string, fileId: string, positionSeconds: number) {
  const cumulative = db.prepare(`
    SELECT COALESCE(SUM(bf.duration_seconds), 0) AS before_seconds
    FROM book_files bf
    JOIN book_files current_file
      ON current_file.id = ? AND current_file.book_id = ? AND current_file.book_id = bf.book_id
    WHERE bf.track_number < current_file.track_number
      AND bf.status = 'available'
  `).get(fileId, bookId) as { before_seconds: number } | undefined;
  return (cumulative?.before_seconds ?? 0) + positionSeconds;
}

export async function audiobookBookmarksPlugin(app: FastifyInstance) {
  // All of the caller's bookmarks across every accessible book — powers the
  // profile "Bookmarks" page.
  app.get("/api/library/bookmarks", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const rows = db.prepare(`
      SELECT
        bm.id,
        bm.book_id,
        bm.file_id,
        bm.position_seconds,
        bm.book_position_seconds,
        bm.label,
        bm.note,
        bm.created_at,
        bm.updated_at,
        books.library_id,
        books.folder_path,
        book_metadata.title,
        book_metadata.cover_storage_key,
        GROUP_CONCAT(DISTINCT authors.name) AS author_names
      FROM book_bookmarks bm
      JOIN books ON books.id = bm.book_id AND books.deleted_at IS NULL
      JOIN libraries ON libraries.id = books.library_id
      LEFT JOIN book_metadata ON book_metadata.book_id = books.id
      LEFT JOIN book_authors ON book_authors.book_id = books.id AND book_authors.role = 'author'
      LEFT JOIN authors ON authors.id = book_authors.author_id
      WHERE bm.user_id = ?
      GROUP BY bm.id
      ORDER BY datetime(bm.updated_at) DESC
    `).all(user.id) as BookmarkWithBookRow[];

    // Library access precomputed once; per-item shares still grant access to a
    // single book inside an otherwise inaccessible library.
    const allowed = accessibleLibraryIds(user.id, user.role, "audiobook");
    const accessible = rows.filter((row) =>
      allowed.has(row.library_id) || userHasItemShare("audiobook", row.book_id, user.id));

    reply.send({
      bookmarks: accessible.map((row) => ({
        ...publicBookmark(row),
        bookId: row.book_id,
        bookTitle: row.title ?? path.basename(row.folder_path),
        bookAuthors: splitNames(row.author_names),
        coverUrl: row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null
      }))
    });
  });

  app.get("/api/library/books/:id/bookmarks", { preHandler: app.authenticate }, async (request, reply) => {
    const bookId = (request.params as { id: string }).id;
    const user = request.user!;
    const library = getLibraryForBook(bookId);
    if (!library || !canUserAccessLibrary(library, user.id, user.role)) {
      reply.code(404).send({ error: "Audiobook not found" });
      return;
    }

    const rows = db.prepare(`
      SELECT id, file_id, position_seconds, book_position_seconds, label, note, created_at, updated_at
      FROM book_bookmarks
      WHERE book_id = ? AND user_id = ?
      ORDER BY book_position_seconds IS NULL, book_position_seconds, datetime(created_at)
    `).all(bookId, user.id) as BookmarkRow[];

    reply.send({ bookmarks: rows.map(publicBookmark) });
  });

  app.post("/api/library/books/:id/bookmarks", { preHandler: app.authenticate }, async (request, reply) => {
    const bookId = (request.params as { id: string }).id;
    const user = request.user!;
    const library = getLibraryForBook(bookId);
    if (!library || !canUserAccessLibrary(library, user.id, user.role)) {
      reply.code(404).send({ error: "Audiobook not found" });
      return;
    }

    const parsed = parseBody(createSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid bookmark", details: parsed.error });
      return;
    }

    const { fileId, positionSeconds, label, note } = parsed.data;
    const file = db.prepare(`
      SELECT id FROM book_files WHERE id = ? AND book_id = ? AND status = 'available'
    `).get(fileId, bookId);
    if (!file) {
      reply.code(404).send({ error: "Audio file not found" });
      return;
    }

    const id = nanoid(16);
    db.prepare(`
      INSERT INTO book_bookmarks (id, user_id, book_id, file_id, position_seconds, book_position_seconds, label, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, user.id, bookId, fileId, positionSeconds, bookPositionFor(bookId, fileId, positionSeconds), label ?? null, note ?? null);

    const row = db.prepare(`
      SELECT id, file_id, position_seconds, book_position_seconds, label, note, created_at, updated_at
      FROM book_bookmarks WHERE id = ?
    `).get(id) as BookmarkRow;

    reply.code(201).send({ bookmark: publicBookmark(row) });
  });

  app.patch("/api/library/books/:id/bookmarks/:bookmarkId", { preHandler: app.authenticate }, async (request, reply) => {
    const { id: bookId, bookmarkId } = request.params as { id: string; bookmarkId: string };
    const user = request.user!;

    const existing = db.prepare(`
      SELECT id FROM book_bookmarks WHERE id = ? AND book_id = ? AND user_id = ?
    `).get(bookmarkId, bookId, user.id);
    if (!existing) {
      reply.code(404).send({ error: "Bookmark not found" });
      return;
    }

    const parsed = parseBody(updateSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid bookmark", details: parsed.error });
      return;
    }

    const updates: string[] = [];
    const values: (string | null)[] = [];
    if (parsed.data.label !== undefined) {
      updates.push("label = ?");
      values.push(parsed.data.label || null);
    }
    if (parsed.data.note !== undefined) {
      updates.push("note = ?");
      values.push(parsed.data.note || null);
    }

    if (updates.length > 0) {
      db.prepare(`
        UPDATE book_bookmarks SET ${updates.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(...values, bookmarkId);
    }

    const row = db.prepare(`
      SELECT id, file_id, position_seconds, book_position_seconds, label, note, created_at, updated_at
      FROM book_bookmarks WHERE id = ?
    `).get(bookmarkId) as BookmarkRow;

    reply.send({ bookmark: publicBookmark(row) });
  });

  app.delete("/api/library/books/:id/bookmarks/:bookmarkId", { preHandler: app.authenticate }, async (request, reply) => {
    const { id: bookId, bookmarkId } = request.params as { id: string; bookmarkId: string };
    const user = request.user!;

    const result = db.prepare(`
      DELETE FROM book_bookmarks WHERE id = ? AND book_id = ? AND user_id = ?
    `).run(bookmarkId, bookId, user.id);

    if (result.changes === 0) {
      reply.code(404).send({ error: "Bookmark not found" });
      return;
    }

    reply.send({ deleted: true });
  });
}
