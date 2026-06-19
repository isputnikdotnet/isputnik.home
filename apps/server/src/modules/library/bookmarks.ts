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
import { mediaKind } from "./shared/library-types.js";

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

export function registerBookmarkRoutes(app: FastifyInstance) {
  app.get("/api/library/bookmarks", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;

    const listenRows = db.prepare(`
      SELECT
        bm.id, bm.item_id AS book_id, bm.file_id, bm.position_seconds, bm.item_position_seconds AS book_position_seconds,
        bm.label, bm.note, bm.created_at, bm.updated_at,
        library_items.library_id, library_items.folder_path, libraries.type AS library_type,
        item_metadata.title, item_metadata.cover_storage_key,
        GROUP_CONCAT(DISTINCT authors.name) AS author_names
      FROM audio_bookmarks bm
      JOIN library_items ON library_items.id = bm.item_id AND library_items.deleted_at IS NULL
      JOIN libraries ON libraries.id = library_items.library_id
      LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
      LEFT JOIN item_people ON item_people.item_id = library_items.id AND item_people.role = 'author'
      LEFT JOIN people AS authors ON authors.id = item_people.person_id
      WHERE bm.user_id = ?
      GROUP BY bm.id
    `).all(user.id) as ListenRow[];

    const readRows = db.prepare(`
      SELECT
        eb.id, eb.item_id AS book_id, eb.percent_complete,
        eb.label, eb.note, eb.created_at, eb.updated_at,
        library_items.library_id, library_items.folder_path, libraries.type AS library_type,
        item_metadata.title, item_metadata.cover_storage_key,
        GROUP_CONCAT(DISTINCT authors.name) AS author_names
      FROM reading_bookmarks eb
      JOIN library_items ON library_items.id = eb.item_id AND library_items.deleted_at IS NULL
      JOIN libraries ON libraries.id = library_items.library_id
      LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
      LEFT JOIN item_people ON item_people.item_id = library_items.id AND item_people.role = 'author'
      LEFT JOIN people AS authors ON authors.id = item_people.person_id
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
