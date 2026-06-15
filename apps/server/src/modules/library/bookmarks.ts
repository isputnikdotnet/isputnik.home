// The cross-type "all my bookmarks" listing (profile → Bookmarks). Unions the two
// per-type bookmark stores — audiobook position bookmarks (book_bookmarks) and epub
// reader bookmarks (ebook_bookmarks) — into one feed, newest first. Like the home
// feeds and the Categories browse, it lives at the library level rather than inside
// one media plugin. Per-book bookmark CRUD stays in each type's module.
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { accessibleLibraryIds } from "./shared/library-access.js";
import { userHasItemShare } from "./shared/share-access.js";

// Each row carries its parent library so we can filter by access and route the tile
// to the right detail page; `kind` ("listen" | "read") tells the UI how to render
// the position (a timestamp vs a reading %).
interface ListenRow {
  id: string;
  book_id: string;
  library_id: string;
  library_type: string;
  folder_path: string;
  title: string | null;
  cover_storage_key: string | null;
  author_names: string | null;
  file_id: string | null;
  position_seconds: number;
  book_position_seconds: number | null;
  label: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

interface ReadRow {
  id: string;
  book_id: string;
  library_id: string;
  library_type: string;
  folder_path: string;
  title: string | null;
  cover_storage_key: string | null;
  author_names: string | null;
  percent_complete: number | null;
  label: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

function splitNames(value: string | null): string[] {
  return value ? value.split(",").map((name) => name.trim()).filter(Boolean) : [];
}

// libraries.type is always a BOOK_LIBRARY_TYPE here (books only live in audiobook /
// ebook libraries); fold anything unexpected into "audiobook" so routing stays valid.
function mediaKind(libraryType: string): "audiobook" | "ebook" {
  return libraryType === "ebook" ? "ebook" : "audiobook";
}

export function registerBookmarkRoutes(app: FastifyInstance) {
  app.get("/api/library/bookmarks", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;

    const listenRows = db.prepare(`
      SELECT
        bm.id, bm.book_id, bm.file_id, bm.position_seconds, bm.book_position_seconds,
        bm.label, bm.note, bm.created_at, bm.updated_at,
        books.library_id, books.folder_path, libraries.type AS library_type,
        book_metadata.title, book_metadata.cover_storage_key,
        GROUP_CONCAT(DISTINCT authors.name) AS author_names
      FROM book_bookmarks bm
      JOIN books ON books.id = bm.book_id AND books.deleted_at IS NULL
      JOIN libraries ON libraries.id = books.library_id
      LEFT JOIN book_metadata ON book_metadata.book_id = books.id
      LEFT JOIN book_authors ON book_authors.book_id = books.id AND book_authors.role = 'author'
      LEFT JOIN authors ON authors.id = book_authors.author_id
      WHERE bm.user_id = ?
      GROUP BY bm.id
    `).all(user.id) as ListenRow[];

    const readRows = db.prepare(`
      SELECT
        eb.id, eb.book_id, eb.percent_complete,
        eb.label, eb.note, eb.created_at, eb.updated_at,
        books.library_id, books.folder_path, libraries.type AS library_type,
        book_metadata.title, book_metadata.cover_storage_key,
        GROUP_CONCAT(DISTINCT authors.name) AS author_names
      FROM ebook_bookmarks eb
      JOIN books ON books.id = eb.book_id AND books.deleted_at IS NULL
      JOIN libraries ON libraries.id = books.library_id
      LEFT JOIN book_metadata ON book_metadata.book_id = books.id
      LEFT JOIN book_authors ON book_authors.book_id = books.id AND book_authors.role = 'author'
      LEFT JOIN authors ON authors.id = book_authors.author_id
      WHERE eb.user_id = ?
      GROUP BY eb.id
    `).all(user.id) as ReadRow[];

    // Library access precomputed once across every type; a per-item share still grants
    // access to a single book inside an otherwise inaccessible library.
    const allowed = accessibleLibraryIds(user.id, user.role);
    const canSee = (libraryId: string, libraryType: string, bookId: string) =>
      allowed.has(libraryId) || userHasItemShare(mediaKind(libraryType), bookId, user.id);

    const common = (row: ListenRow | ReadRow) => ({
      bookId: row.book_id,
      libraryType: mediaKind(row.library_type),
      bookTitle: row.title ?? path.basename(row.folder_path),
      bookAuthors: splitNames(row.author_names),
      coverUrl: row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null,
      label: row.label,
      note: row.note,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });

    const listen = listenRows
      .filter((row) => canSee(row.library_id, row.library_type, row.book_id))
      .map((row) => ({
        kind: "listen" as const,
        id: row.id,
        ...common(row),
        fileId: row.file_id,
        positionSeconds: row.position_seconds,
        bookPositionSeconds: row.book_position_seconds
      }));

    const read = readRows
      .filter((row) => canSee(row.library_id, row.library_type, row.book_id))
      .map((row) => ({
        kind: "read" as const,
        id: row.id,
        ...common(row),
        percentComplete: row.percent_complete
      }));

    const bookmarks = [...listen, ...read].sort(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    );

    reply.send({ bookmarks });
  });
}
