import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { db } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { getReadableDocument } from "../shared/library-access.js";

// Reader bookmarks for an epub document. The CFI is the jump target; percent_complete
// is captured at save time for the "42%" display. Counterpart to the audiobook
// position bookmarks in audiobook/bookmarks.ts — both feed the cross-type
// /api/library/bookmarks listing (see modules/library/bookmarks.ts).
interface EbookBookmarkRow {
  id: string;
  document_id: string;
  cfi: string;
  percent_complete: number | null;
  label: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

function publicEbookBookmark(row: EbookBookmarkRow) {
  return {
    id: row.id,
    documentId: row.document_id,
    cfi: row.cfi,
    percentComplete: row.percent_complete,
    label: row.label,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const createSchema = z.object({
  documentId: z.string().trim().min(1),
  cfi: z.string().trim().min(1).max(2000),
  percentComplete: z.number().min(0).max(1).nullable().optional(),
  label: z.string().trim().max(300).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional()
});

const updateSchema = z.object({
  label: z.string().trim().max(300).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional()
});

export async function ebookBookmarksPlugin(app: FastifyInstance) {
  // Every bookmark this user saved in one document, in reading order. The reader
  // loads these to render its bookmarks panel and the jump-to targets.
  app.get("/api/library/books/:id/ebook-bookmarks", { preHandler: app.authenticate }, async (request, reply) => {
    const bookId = (request.params as { id: string }).id;
    const documentId = ((request.query as { documentId?: string }).documentId ?? "").trim();
    if (!documentId) {
      reply.code(400).send({ error: "Document id is required" });
      return;
    }
    const user = request.user!;
    if (!getReadableDocument(bookId, documentId, user)) {
      reply.code(404).send({ error: "Document not found" });
      return;
    }

    const rows = db.prepare(`
      SELECT id, document_id, cfi, percent_complete, label, note, created_at, updated_at
      FROM ebook_bookmarks
      WHERE book_id = ? AND document_id = ? AND user_id = ?
      ORDER BY percent_complete IS NULL, percent_complete, datetime(created_at)
    `).all(bookId, documentId, user.id) as EbookBookmarkRow[];

    reply.send({ bookmarks: rows.map(publicEbookBookmark) });
  });

  app.post("/api/library/books/:id/ebook-bookmarks", { preHandler: app.authenticate }, async (request, reply) => {
    const bookId = (request.params as { id: string }).id;
    const parsed = parseBody(createSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid bookmark", details: parsed.error });
      return;
    }
    const user = request.user!;
    if (!getReadableDocument(bookId, parsed.data.documentId, user)) {
      reply.code(404).send({ error: "Document not found" });
      return;
    }

    const id = nanoid(16);
    db.prepare(`
      INSERT INTO ebook_bookmarks (id, user_id, book_id, document_id, cfi, percent_complete, label, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      user.id,
      bookId,
      parsed.data.documentId,
      parsed.data.cfi,
      parsed.data.percentComplete ?? null,
      parsed.data.label ?? null,
      parsed.data.note ?? null
    );

    const row = db.prepare(`
      SELECT id, document_id, cfi, percent_complete, label, note, created_at, updated_at
      FROM ebook_bookmarks WHERE id = ?
    `).get(id) as EbookBookmarkRow;

    reply.code(201).send({ bookmark: publicEbookBookmark(row) });
  });

  app.patch("/api/library/books/:id/ebook-bookmarks/:bookmarkId", { preHandler: app.authenticate }, async (request, reply) => {
    const { id: bookId, bookmarkId } = request.params as { id: string; bookmarkId: string };
    const user = request.user!;

    const existing = db.prepare(`
      SELECT id FROM ebook_bookmarks WHERE id = ? AND book_id = ? AND user_id = ?
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
        UPDATE ebook_bookmarks SET ${updates.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(...values, bookmarkId);
    }

    const row = db.prepare(`
      SELECT id, document_id, cfi, percent_complete, label, note, created_at, updated_at
      FROM ebook_bookmarks WHERE id = ?
    `).get(bookmarkId) as EbookBookmarkRow;

    reply.send({ bookmark: publicEbookBookmark(row) });
  });

  app.delete("/api/library/books/:id/ebook-bookmarks/:bookmarkId", { preHandler: app.authenticate }, async (request, reply) => {
    const { id: bookId, bookmarkId } = request.params as { id: string; bookmarkId: string };
    const user = request.user!;

    const result = db.prepare(`
      DELETE FROM ebook_bookmarks WHERE id = ? AND book_id = ? AND user_id = ?
    `).run(bookmarkId, bookId, user.id);

    if (result.changes === 0) {
      reply.code(404).send({ error: "Bookmark not found" });
      return;
    }

    reply.send({ deleted: true });
  });
}
