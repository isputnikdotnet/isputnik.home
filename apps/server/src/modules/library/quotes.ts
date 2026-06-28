// Quotes / highlights — a cross-type, user-owned entity that lives at the library
// level (like the bookmarks listing in bookmarks.ts) rather than inside one media
// plugin, because a quote need not belong to any library book at all.
//
// Three shapes over one table (see schema.sql `quotes`):
//   • in-reader     — item_id + document_id + cfi set; the cfi anchors an on-page
//                     highlight and is the jump target back into the reader.
//   • book-linked   — item_id set, no cfi (e.g. attached to a book by hand).
//   • external      — all NULL; just `text` + a free-text source the user typed.
//
// source_title/source_author are snapshotted on save so attribution survives the
// book being deleted (its FK is ON DELETE SET NULL). Display still prefers the
// live item metadata whenever item_id resolves.
import { z } from "zod";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { db } from "../../db.js";
import { parseBody } from "../../core/shared.js";
import {
  accessibleLibraryIds,
  canUserAccessBook,
  getLibraryForBook,
  getReadableDocument
} from "./shared/library-access.js";
import { userHasItemShare } from "./shared/share-access.js";
import { mediaKind } from "./shared/library-types.js";

interface QuoteRow {
  id: string;
  item_id: string | null;
  document_id: string | null;
  cfi: string | null;
  text: string;
  note: string | null;
  color: string | null;
  source_title: string | null;
  source_author: string | null;
  percent_complete: number | null;
  created_at: string;
  updated_at: string;
  // Joined from the live item when item_id still resolves (NULL for external quotes).
  library_id: string | null;
  library_type: string | null;
  folder_path: string | null;
  item_title: string | null;
  cover_storage_key: string | null;
  author_names: string | null;
}

function splitNames(value: string | null): string[] {
  return value ? value.split(",").map((name) => name.trim()).filter(Boolean) : [];
}

// Shared SELECT — left-joins the live item so item-linked quotes carry current
// title/author/cover, while external quotes (no item, or a removed one) come back
// with the joined columns NULL and fall back to the snapshot.
const QUOTE_SELECT = `
  SELECT
    q.id, q.item_id, q.document_id, q.cfi, q.text, q.note, q.color,
    q.source_title, q.source_author, q.percent_complete, q.created_at, q.updated_at,
    library_items.library_id, libraries.type AS library_type, library_items.folder_path,
    item_metadata.title AS item_title, item_metadata.cover_storage_key,
    GROUP_CONCAT(DISTINCT authors.name) AS author_names
  FROM quotes q
  LEFT JOIN library_items ON library_items.id = q.item_id AND library_items.deleted_at IS NULL
  LEFT JOIN libraries ON libraries.id = library_items.library_id
  LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
  LEFT JOIN item_people ON item_people.item_id = library_items.id AND item_people.role = 'author'
  LEFT JOIN people AS authors ON authors.id = item_people.person_id
`;

function publicQuote(row: QuoteRow) {
  const liveTitle = row.item_title ?? (row.folder_path ? path.basename(row.folder_path) : null);
  const liveAuthors = splitNames(row.author_names);
  // Prefer live item metadata; fall back to the snapshot taken at save time.
  const sourceTitle = liveTitle ?? row.source_title ?? null;
  const sourceAuthors = liveAuthors.length > 0
    ? liveAuthors
    : (row.source_author ? [row.source_author] : []);
  return {
    id: row.id,
    // item_id may be set in the table but null here if the book was removed/soft-deleted.
    itemId: row.library_id ? row.item_id : null,
    documentId: row.document_id,
    cfi: row.cfi,
    text: row.text,
    note: row.note,
    color: row.color,
    percentComplete: row.percent_complete,
    sourceTitle,
    sourceAuthors,
    libraryType: row.library_type ? mediaKind(row.library_type) : null,
    coverUrl: row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function fetchQuote(id: string): QuoteRow | undefined {
  return db.prepare(`${QUOTE_SELECT} WHERE q.id = ? GROUP BY q.id`).get(id) as QuoteRow | undefined;
}

const createSchema = z.object({
  text: z.string().trim().min(1).max(10000),
  itemId: z.string().trim().min(1).nullable().optional(),
  documentId: z.string().trim().min(1).nullable().optional(),
  cfi: z.string().trim().min(1).max(2000).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  color: z.string().trim().max(32).nullable().optional(),
  percentComplete: z.number().min(0).max(1).nullable().optional(),
  sourceTitle: z.string().trim().max(300).nullable().optional(),
  sourceAuthor: z.string().trim().max(300).nullable().optional()
});

const updateSchema = z.object({
  text: z.string().trim().min(1).max(10000).optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  color: z.string().trim().max(32).nullable().optional(),
  sourceTitle: z.string().trim().max(300).nullable().optional(),
  sourceAuthor: z.string().trim().max(300).nullable().optional()
});

export function registerQuoteRoutes(app: FastifyInstance) {
  // All my quotes (Quotes page), or just one document's quotes (the reader, to
  // redraw its highlights) when ?documentId is given.
  app.get("/api/library/quotes", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const documentId = ((request.query as { documentId?: string }).documentId ?? "").trim();

    const where = documentId ? "WHERE q.user_id = ? AND q.document_id = ?" : "WHERE q.user_id = ?";
    const params = documentId ? [user.id, documentId] : [user.id];
    const rows = db.prepare(`
      ${QUOTE_SELECT} ${where} GROUP BY q.id ORDER BY datetime(q.created_at) DESC
    `).all(...params) as QuoteRow[];

    // Item-linked quotes are filtered by current access; external/orphaned quotes
    // (no live item) are always the user's own and always shown.
    const allowed = accessibleLibraryIds(user.id, user.role);
    const canSee = (row: QuoteRow) => {
      if (!row.item_id || !row.library_id) return true;
      return allowed.has(row.library_id)
        || userHasItemShare(mediaKind(row.library_type!), row.item_id, user.id);
    };

    reply.send({ quotes: rows.filter(canSee).map(publicQuote) });
  });

  app.post("/api/library/quotes", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const parsed = parseBody(createSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid quote", details: parsed.error });
      return;
    }
    const data = parsed.data;

    // When the quote links a library book, the caller must be able to read it.
    if (data.itemId) {
      if (data.documentId) {
        if (!getReadableDocument(data.itemId, data.documentId, user)) {
          reply.code(404).send({ error: "Document not found" });
          return;
        }
      } else {
        const library = getLibraryForBook(data.itemId);
        if (!library || !canUserAccessBook(data.itemId, library, user.id, user.role, mediaKind(library.type))) {
          reply.code(404).send({ error: "Book not found" });
          return;
        }
      }
    }

    // Snapshot the book's title/author so attribution survives its deletion, unless
    // the caller supplied an explicit source (an external quote, or a manual override).
    let sourceTitle = data.sourceTitle ?? null;
    let sourceAuthor = data.sourceAuthor ?? null;
    if (data.itemId && (!sourceTitle || !sourceAuthor)) {
      const snap = db.prepare(`
        SELECT item_metadata.title AS title, library_items.folder_path AS folder_path,
          (SELECT people.name FROM item_people
             JOIN people ON people.id = item_people.person_id
             WHERE item_people.item_id = library_items.id AND item_people.role = 'author'
             LIMIT 1) AS author
        FROM library_items
        LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
        WHERE library_items.id = ? AND library_items.deleted_at IS NULL
      `).get(data.itemId) as { title: string | null; folder_path: string | null; author: string | null } | undefined;
      if (snap) {
        if (!sourceTitle) sourceTitle = snap.title ?? (snap.folder_path ? path.basename(snap.folder_path) : null);
        if (!sourceAuthor) sourceAuthor = snap.author ?? null;
      }
    }

    const id = nanoid(16);
    db.prepare(`
      INSERT INTO quotes (id, user_id, item_id, document_id, cfi, text, note, color, source_title, source_author, percent_complete)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      user.id,
      data.itemId ?? null,
      data.documentId ?? null,
      data.cfi ?? null,
      data.text,
      data.note ?? null,
      data.color ?? null,
      sourceTitle,
      sourceAuthor,
      data.percentComplete ?? null
    );

    reply.code(201).send({ quote: publicQuote(fetchQuote(id)!) });
  });

  app.patch("/api/library/quotes/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const quoteId = (request.params as { id: string }).id;

    const existing = db.prepare("SELECT id FROM quotes WHERE id = ? AND user_id = ?").get(quoteId, user.id);
    if (!existing) {
      reply.code(404).send({ error: "Quote not found" });
      return;
    }

    const parsed = parseBody(updateSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid quote", details: parsed.error });
      return;
    }

    const updates: string[] = [];
    const values: (string | null)[] = [];
    const set = (column: string, value: string | null | undefined) => {
      if (value === undefined) return;
      updates.push(`${column} = ?`);
      values.push(value || null);
    };
    set("text", parsed.data.text);
    set("note", parsed.data.note);
    set("color", parsed.data.color);
    set("source_title", parsed.data.sourceTitle);
    set("source_author", parsed.data.sourceAuthor);

    if (updates.length > 0) {
      db.prepare(`
        UPDATE quotes SET ${updates.join(", ")}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?
      `).run(...values, quoteId);
    }

    reply.send({ quote: publicQuote(fetchQuote(quoteId)!) });
  });

  app.delete("/api/library/quotes/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const quoteId = (request.params as { id: string }).id;
    const result = db.prepare("DELETE FROM quotes WHERE id = ? AND user_id = ?").run(quoteId, user.id);
    if (result.changes === 0) {
      reply.code(404).send({ error: "Quote not found" });
      return;
    }
    reply.send({ deleted: true });
  });
}
