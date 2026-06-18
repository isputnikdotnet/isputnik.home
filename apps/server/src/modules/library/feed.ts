// Cross-type home feeds. Audiobooks and ebooks are both rows in `books`
// (distinguished by their library's type), so "recently added" and "continue"
// are one query across both — progress just comes from two tables (audiobook
// playback_progress, ebook reading_progress). Lives at the library level rather
// than in one media plugin, like the Recycle Bin.
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { accessibleLibraryIds } from "./shared/library-access.js";
import { BOOK_LIBRARY_TYPES } from "./shared/library-types.js";

export interface FeedItem {
  id: string;
  kind: "audiobook" | "ebook";
  title: string;
  authors: string[];
  coverUrl: string | null;
  percentComplete: number | null;
  completedAt: string | null;
  discoveredAt: string;
  durationSeconds: number | null;
  format: string | null;
}

export interface FeedRow {
  id: string;
  kind: "audiobook" | "ebook";
  title: string | null;
  folder_path: string;
  discovered_at: string;
  cover_storage_key: string | null;
  author_names: string | null;
  pct: number | null;
  completed_at: string | null;
  duration_seconds: number | null;
  doc_format: string | null;
}

const placeholders = (n: number) => Array(n).fill("?").join(", ");

// Columns + joins shared by both feeds and the global category-detail query; the
// caller supplies `pct` and `completed_at` (NULL for recent, the progress row for
// continue / category detail).
export const FEED_COLUMNS = `
  library_items.id,
  libraries.type AS kind,
  item_metadata.title AS title,
  library_items.folder_path,
  library_items.discovered_at,
  item_metadata.cover_storage_key,
  GROUP_CONCAT(DISTINCT authors.name) AS author_names,
  audiobook_details.duration_seconds,
  (SELECT format FROM document_files WHERE document_files.item_id = library_items.id AND document_files.status = 'available' LIMIT 1) AS doc_format`;

export const FEED_JOINS = `
  FROM library_items
  JOIN libraries ON libraries.id = library_items.library_id
  LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
  LEFT JOIN item_people ON item_people.item_id = library_items.id AND item_people.role = 'author'
  LEFT JOIN people AS authors ON authors.id = item_people.person_id
  LEFT JOIN audiobook_details ON audiobook_details.item_id = library_items.id`;

// One progress row per item — the most-recent activity from either table. SQLite
// returns the pct/completed_at from the MAX(updated_at) row (bare-column + max).
export const PROGRESS_CTE = `
  WITH prog AS (
    SELECT item_id, percent_complete AS pct, completed_at, MAX(updated_at) AS updated_at
    FROM playback_progress WHERE user_id = ? GROUP BY item_id
    UNION ALL
    SELECT item_id, percent_complete AS pct, completed_at, MAX(updated_at) AS updated_at
    FROM reading_progress WHERE user_id = ? GROUP BY item_id
  )`;

export function mapRow(row: FeedRow): FeedItem {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title ?? row.folder_path.split("/").pop() ?? row.folder_path,
    authors: row.author_names ? row.author_names.split(",").map((name) => name.trim()).filter(Boolean) : [],
    coverUrl: row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null,
    percentComplete: row.pct ?? null,
    completedAt: row.completed_at ?? null,
    discoveredAt: row.discovered_at,
    durationSeconds: row.duration_seconds ?? null,
    format: row.doc_format ?? null
  };
}

// Every library id of a book-like type the user can access (audiobooks + ebooks,
// and any future BOOK_LIBRARY_TYPES). Shared by the feeds and the cross-type
// category / tag browse.
export function bookLibraryIds(user: { id: string; role: string }): string[] {
  return BOOK_LIBRARY_TYPES.flatMap((type) => [...accessibleLibraryIds(user.id, user.role, type)]);
}

// Books of any book-like type matching an extra membership predicate, mapped to
// the cross-type FeedItem shape (carrying `kind`). Powers the global category and
// tag detail pages — the caller supplies the WHERE fragment + its bound args.
export function crossTypeBooksByFilter(
  userId: string,
  libIds: string[],
  filterSql: string,
  filterArgs: unknown[]
): FeedItem[] {
  if (libIds.length === 0) return [];
  const rows = db.prepare(`
    ${PROGRESS_CTE}
    SELECT ${FEED_COLUMNS}, prog.pct AS pct, prog.completed_at AS completed_at
    ${FEED_JOINS}
    LEFT JOIN prog ON prog.item_id = library_items.id
    WHERE library_items.deleted_at IS NULL
      AND library_items.library_id IN (${placeholders(libIds.length)})
      AND ${filterSql}
    GROUP BY library_items.id
    ORDER BY COALESCE(item_metadata.sort_title, item_metadata.title, library_items.folder_path) COLLATE NOCASE, library_items.id
  `).all(userId, userId, ...libIds, ...filterArgs) as FeedRow[];
  return rows.map(mapRow);
}

// Newest additions across audiobooks + ebooks.
export function recentlyAdded(user: { id: string; role: string }, limit: number, offset: number): { items: FeedItem[]; total: number } {
  const libIds = bookLibraryIds(user);
  if (libIds.length === 0) return { items: [], total: 0 };
  const inLibs = placeholders(libIds.length);

  const rows = db.prepare(`
    SELECT ${FEED_COLUMNS}, NULL AS pct, NULL AS completed_at
    ${FEED_JOINS}
    WHERE library_items.deleted_at IS NULL AND library_items.library_id IN (${inLibs})
    GROUP BY library_items.id
    ORDER BY library_items.discovered_at DESC, library_items.id
    LIMIT ? OFFSET ?
  `).all(...libIds, limit, offset) as FeedRow[];

  const total = (db.prepare(`
    SELECT COUNT(*) AS n FROM library_items
    WHERE library_items.deleted_at IS NULL AND library_items.library_id IN (${inLibs})
  `).get(...libIds) as { n: number }).n;

  return { items: rows.map(mapRow), total };
}

// In-progress across audiobooks + ebooks, most-recent activity first.
export function inProgress(user: { id: string; role: string }, limit: number, offset: number): { items: FeedItem[]; total: number } {
  const libIds = bookLibraryIds(user);
  if (libIds.length === 0) return { items: [], total: 0 };
  const inLibs = placeholders(libIds.length);
  const where = `
    WHERE library_items.deleted_at IS NULL
      AND library_items.library_id IN (${inLibs})
      AND prog.completed_at IS NULL
      AND prog.pct IS NOT NULL AND prog.pct > 0`;

  const rows = db.prepare(`
    ${PROGRESS_CTE}
    SELECT ${FEED_COLUMNS}, prog.pct AS pct, prog.completed_at AS completed_at
    ${FEED_JOINS}
    JOIN prog ON prog.item_id = library_items.id
    ${where}
    GROUP BY library_items.id
    ORDER BY prog.updated_at DESC, library_items.id
    LIMIT ? OFFSET ?
  `).all(user.id, user.id, ...libIds, limit, offset) as FeedRow[];

  const total = (db.prepare(`
    ${PROGRESS_CTE}
    SELECT COUNT(*) AS n
    FROM library_items JOIN prog ON prog.item_id = library_items.id
    ${where}
  `).get(user.id, user.id, ...libIds) as { n: number }).n;

  return { items: rows.map(mapRow), total };
}

export function registerFeedRoutes(app: FastifyInstance) {
  const paging = (query: unknown) => {
    const q = (query ?? {}) as { limit?: string; offset?: string };
    const limit = Math.min(Math.max(parseInt(q.limit ?? "24", 10) || 24, 1), 100);
    const offset = Math.max(parseInt(q.offset ?? "0", 10) || 0, 0);
    return { limit, offset };
  };

  app.get("/api/library/feed/recent", { preHandler: app.authenticate }, async (request) => {
    const { limit, offset } = paging(request.query);
    return recentlyAdded(request.user!, limit, offset);
  });

  app.get("/api/library/feed/continue", { preHandler: app.authenticate }, async (request) => {
    const { limit, offset } = paging(request.query);
    return inProgress(request.user!, limit, offset);
  });
}
