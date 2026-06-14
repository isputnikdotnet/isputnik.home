// Cross-type home feeds. Audiobooks and ebooks are both rows in `books`
// (distinguished by their library's type), so "recently added" and "continue"
// are one query across both — progress just comes from two tables (audiobook
// playback_progress, ebook reading_progress). Lives at the library level rather
// than in one media plugin, like the Recycle Bin.
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { accessibleLibraryIds } from "./shared/library-access.js";

export interface FeedItem {
  id: string;
  kind: "audiobook" | "ebook";
  title: string;
  authors: string[];
  coverUrl: string | null;
  percentComplete: number | null;
  completedAt: string | null;
  discoveredAt: string;
}

interface FeedRow {
  id: string;
  kind: "audiobook" | "ebook";
  title: string | null;
  folder_path: string;
  discovered_at: string;
  cover_storage_key: string | null;
  author_names: string | null;
  pct: number | null;
  completed_at: string | null;
}

const placeholders = (n: number) => Array(n).fill("?").join(", ");

// Columns + joins shared by both feeds; the per-feed query supplies `pct` and
// `completed_at` (NULL for recent, the progress row for continue).
const FEED_COLUMNS = `
  books.id,
  libraries.type AS kind,
  book_metadata.title AS title,
  books.folder_path,
  books.discovered_at,
  book_metadata.cover_storage_key,
  GROUP_CONCAT(DISTINCT authors.name) AS author_names`;

const FEED_JOINS = `
  FROM books
  JOIN libraries ON libraries.id = books.library_id
  LEFT JOIN book_metadata ON book_metadata.book_id = books.id
  LEFT JOIN book_authors ON book_authors.book_id = books.id AND book_authors.role = 'author'
  LEFT JOIN authors ON authors.id = book_authors.author_id`;

// One progress row per book — the most-recent activity from either table. SQLite
// returns the pct/completed_at from the MAX(updated_at) row (bare-column + max).
const PROGRESS_CTE = `
  WITH prog AS (
    SELECT book_id, percent_complete AS pct, completed_at, MAX(updated_at) AS updated_at
    FROM playback_progress WHERE user_id = ? GROUP BY book_id
    UNION ALL
    SELECT book_id, percent_complete AS pct, completed_at, MAX(updated_at) AS updated_at
    FROM reading_progress WHERE user_id = ? GROUP BY book_id
  )`;

function mapRow(row: FeedRow): FeedItem {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title ?? row.folder_path.split("/").pop() ?? row.folder_path,
    authors: row.author_names ? row.author_names.split(",").map((name) => name.trim()).filter(Boolean) : [],
    coverUrl: row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null,
    percentComplete: row.pct ?? null,
    completedAt: row.completed_at ?? null,
    discoveredAt: row.discovered_at
  };
}

function libraryIds(user: { id: string; role: string }): string[] {
  return [
    ...accessibleLibraryIds(user.id, user.role, "audiobook"),
    ...accessibleLibraryIds(user.id, user.role, "ebook")
  ];
}

// Newest additions across audiobooks + ebooks.
export function recentlyAdded(user: { id: string; role: string }, limit: number, offset: number): { items: FeedItem[]; total: number } {
  const libIds = libraryIds(user);
  if (libIds.length === 0) return { items: [], total: 0 };
  const inLibs = placeholders(libIds.length);

  const rows = db.prepare(`
    SELECT ${FEED_COLUMNS}, NULL AS pct, NULL AS completed_at
    ${FEED_JOINS}
    WHERE books.deleted_at IS NULL AND books.library_id IN (${inLibs})
    GROUP BY books.id
    ORDER BY books.discovered_at DESC, books.id
    LIMIT ? OFFSET ?
  `).all(...libIds, limit, offset) as FeedRow[];

  const total = (db.prepare(`
    SELECT COUNT(*) AS n FROM books
    WHERE books.deleted_at IS NULL AND books.library_id IN (${inLibs})
  `).get(...libIds) as { n: number }).n;

  return { items: rows.map(mapRow), total };
}

// In-progress across audiobooks + ebooks, most-recent activity first.
export function inProgress(user: { id: string; role: string }, limit: number, offset: number): { items: FeedItem[]; total: number } {
  const libIds = libraryIds(user);
  if (libIds.length === 0) return { items: [], total: 0 };
  const inLibs = placeholders(libIds.length);
  const where = `
    WHERE books.deleted_at IS NULL
      AND books.library_id IN (${inLibs})
      AND prog.completed_at IS NULL
      AND prog.pct IS NOT NULL AND prog.pct > 0`;

  const rows = db.prepare(`
    ${PROGRESS_CTE}
    SELECT ${FEED_COLUMNS}, prog.pct AS pct, prog.completed_at AS completed_at
    ${FEED_JOINS}
    JOIN prog ON prog.book_id = books.id
    ${where}
    GROUP BY books.id
    ORDER BY prog.updated_at DESC, books.id
    LIMIT ? OFFSET ?
  `).all(user.id, user.id, ...libIds, limit, offset) as FeedRow[];

  const total = (db.prepare(`
    ${PROGRESS_CTE}
    SELECT COUNT(*) AS n
    FROM books JOIN prog ON prog.book_id = books.id
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
