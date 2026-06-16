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
    SELECT id, note, created_at, updated_at FROM item_saves WHERE item_id = ? AND user_id = ?
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
      INSERT INTO item_saves (id, user_id, item_id, note)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, item_id) DO UPDATE SET
        note = excluded.note,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(nanoid(16), user.id, bookId, parsed.data.note ?? null);

    reply.send({ save: currentSave(bookId, user.id) });
  });

  app.delete("/api/library/books/:id/save", { preHandler: app.authenticate }, async (request, reply) => {
    const bookId = (request.params as { id: string }).id;
    const user = request.user!;
    db.prepare("DELETE FROM item_saves WHERE item_id = ? AND user_id = ?").run(bookId, user.id);
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
        library_items.id,
        libraries.type AS kind,
        library_items.folder_path,
        item_metadata.title,
        item_metadata.cover_storage_key,
        GROUP_CONCAT(DISTINCT authors.name) AS author_names,
        item_saves.note AS save_note,
        item_saves.updated_at AS saved_at
      FROM item_saves
      JOIN library_items ON library_items.id = item_saves.item_id AND library_items.deleted_at IS NULL
      JOIN libraries ON libraries.id = library_items.library_id
      LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
      LEFT JOIN item_people ON item_people.item_id = library_items.id AND item_people.role = 'author'
      LEFT JOIN people AS authors ON authors.id = item_people.person_id
      WHERE item_saves.user_id = ? AND library_items.library_id IN (${inLibs})
      GROUP BY library_items.id
      ORDER BY datetime(item_saves.updated_at) DESC
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
