import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { db } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { getLibraryForBook, canUserAccessLibrary } from "../shared/library-access.js";

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
    FROM audio_files bf
    JOIN audio_files current_file
      ON current_file.id = ? AND current_file.item_id = ? AND current_file.item_id = bf.item_id
    WHERE bf.track_number < current_file.track_number
      AND bf.status = 'available'
  `).get(fileId, bookId) as { before_seconds: number } | undefined;
  return (cumulative?.before_seconds ?? 0) + positionSeconds;
}

export async function audiobookBookmarksPlugin(app: FastifyInstance) {

  app.get("/api/library/books/:id/bookmarks", { preHandler: app.authenticate }, async (request, reply) => {
    const bookId = (request.params as { id: string }).id;
    const user = request.user!;
    const library = getLibraryForBook(bookId);
    if (!library || !canUserAccessLibrary(library, user.id, user.role)) {
      reply.code(404).send({ error: "Audiobook not found" });
      return;
    }

    const rows = db.prepare(`
      SELECT id, file_id, position_seconds, item_position_seconds AS book_position_seconds, label, note, created_at, updated_at
      FROM audio_bookmarks
      WHERE item_id = ? AND user_id = ?
      ORDER BY item_position_seconds IS NULL, item_position_seconds, datetime(created_at)
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
      SELECT id FROM audio_files WHERE id = ? AND item_id = ? AND status = 'available'
    `).get(fileId, bookId);
    if (!file) {
      reply.code(404).send({ error: "Audio file not found" });
      return;
    }

    const id = nanoid(16);
    db.prepare(`
      INSERT INTO audio_bookmarks (id, user_id, item_id, file_id, position_seconds, item_position_seconds, label, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, user.id, bookId, fileId, positionSeconds, bookPositionFor(bookId, fileId, positionSeconds), label ?? null, note ?? null);

    const row = db.prepare(`
      SELECT id, file_id, position_seconds, item_position_seconds AS book_position_seconds, label, note, created_at, updated_at
      FROM audio_bookmarks WHERE id = ?
    `).get(id) as BookmarkRow;

    reply.code(201).send({ bookmark: publicBookmark(row) });
  });

  app.patch("/api/library/books/:id/bookmarks/:bookmarkId", { preHandler: app.authenticate }, async (request, reply) => {
    const { id: bookId, bookmarkId } = request.params as { id: string; bookmarkId: string };
    const user = request.user!;

    const existing = db.prepare(`
      SELECT id FROM audio_bookmarks WHERE id = ? AND item_id = ? AND user_id = ?
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
        UPDATE audio_bookmarks SET ${updates.join(", ")}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?
      `).run(...values, bookmarkId);
    }

    const row = db.prepare(`
      SELECT id, file_id, position_seconds, item_position_seconds AS book_position_seconds, label, note, created_at, updated_at
      FROM audio_bookmarks WHERE id = ?
    `).get(bookmarkId) as BookmarkRow;

    reply.send({ bookmark: publicBookmark(row) });
  });

  app.delete("/api/library/books/:id/bookmarks/:bookmarkId", { preHandler: app.authenticate }, async (request, reply) => {
    const { id: bookId, bookmarkId } = request.params as { id: string; bookmarkId: string };
    const user = request.user!;

    const result = db.prepare(`
      DELETE FROM audio_bookmarks WHERE id = ? AND item_id = ? AND user_id = ?
    `).run(bookmarkId, bookId, user.id);

    if (result.changes === 0) {
      reply.code(404).send({ error: "Bookmark not found" });
      return;
    }

    reply.send({ deleted: true });
  });
}
