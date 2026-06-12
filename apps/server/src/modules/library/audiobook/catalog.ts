import { db } from "../../../db.js";
import { canUserAccessLibrary } from "../shared/library-access.js";
import { BOOK_LIST_COLUMNS, BOOK_LIST_JOINS, mapBookListRow, type BookListRow } from "./book-helpers.js";

export interface CatalogFilters {
  authors: string[];
  narrators: string[];
  categories: string[];
  tags: string[];
  series: string[];
  languages: string[];
  status: string[];
  durations: string[];
}

export interface CatalogQuery {
  q: string;
  sort: string;
  limit: number;
  offset: number;
  filters: CatalogFilters;
}

const placeholders = (n: number) => Array(n).fill("?").join(", ");

interface LibraryRow {
  id: string;
}

// Audiobook library ids the user can see for a scope:
//   all      → every accessible library
//   library  → one library
export function resolveScopeLibraryIds(
  user: { id: string; role: string },
  scope: string,
  libraryId?: string
): string[] {
  const rows = db.prepare(
    "SELECT id FROM libraries WHERE type = 'audiobook'"
  ).all() as LibraryRow[];

  return rows
    .filter((row) => canUserAccessLibrary(row, user.id, user.role))
    .filter((row) => (scope === "library" ? row.id === libraryId : true))
    .map((row) => row.id);
}

const ORDER_BY: Record<string, string> = {
  title: "COALESCE(book_metadata.sort_title, book_metadata.title, books.folder_path) COLLATE NOCASE ASC",
  title_desc: "COALESCE(book_metadata.sort_title, book_metadata.title, books.folder_path) COLLATE NOCASE DESC",
  recent: "books.discovered_at DESC",
  duration: "book_metadata.duration_seconds DESC",
  author: "(SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = books.id AND ba.role = 'author' ORDER BY ba.sort_order LIMIT 1) COLLATE NOCASE ASC, COALESCE(book_metadata.sort_title, book_metadata.title) COLLATE NOCASE ASC",
  series: "series.name IS NULL, series.name COLLATE NOCASE ASC, books.series_position ASC, COALESCE(book_metadata.sort_title, book_metadata.title) COLLATE NOCASE ASC"
};

const STATUS_SQL: Record<string, string> = {
  finished: "(progress.completed_at IS NOT NULL)",
  in_progress: "(progress.completed_at IS NULL AND progress.percent_complete > 0)",
  not_started: "(progress.completed_at IS NULL AND (progress.percent_complete IS NULL OR progress.percent_complete = 0))"
};

const DURATION_SQL: Record<string, string> = {
  short: "book_metadata.duration_seconds < 7200",
  medium: "book_metadata.duration_seconds >= 7200 AND book_metadata.duration_seconds < 21600",
  long: "book_metadata.duration_seconds >= 21600 AND book_metadata.duration_seconds < 43200",
  epic: "book_metadata.duration_seconds >= 43200"
};

// Builds the shared WHERE clause + its bound args (after the leading user-id param).
function buildWhere(libIds: string[], q: string, f: CatalogFilters): { where: string; args: unknown[] } {
  const clauses: string[] = ["books.deleted_at IS NULL", `books.library_id IN (${placeholders(libIds.length)})`];
  const args: unknown[] = [...libIds];

  if (q) {
    const like = `%${q}%`;
    clauses.push(
      "(book_metadata.title LIKE ? OR series.name LIKE ? OR EXISTS (SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = books.id AND a.name LIKE ?))"
    );
    args.push(like, like, like);
  }
  if (f.authors.length) {
    clauses.push(`EXISTS (SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = books.id AND ba.role = 'author' AND a.name IN (${placeholders(f.authors.length)}))`);
    args.push(...f.authors);
  }
  if (f.narrators.length) {
    clauses.push(`EXISTS (SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = books.id AND ba.role = 'narrator' AND a.name IN (${placeholders(f.narrators.length)}))`);
    args.push(...f.narrators);
  }
  if (f.categories.length) {
    clauses.push(`book_metadata.category_id IN (SELECT id FROM categories WHERE name IN (${placeholders(f.categories.length)}))`);
    args.push(...f.categories);
  }
  if (f.tags.length) {
    clauses.push(`EXISTS (SELECT 1 FROM taggables tg JOIN tags t ON t.id = tg.tag_id WHERE tg.entity_type = 'book' AND tg.entity_id = books.id AND t.display_name IN (${placeholders(f.tags.length)}))`);
    args.push(...f.tags);
  }
  if (f.series.length) {
    clauses.push(`series.name IN (${placeholders(f.series.length)})`);
    args.push(...f.series);
  }
  if (f.languages.length) {
    clauses.push(`book_metadata.language IN (${placeholders(f.languages.length)})`);
    args.push(...f.languages);
  }
  const statusParts = f.status.map((s) => STATUS_SQL[s]).filter(Boolean);
  if (statusParts.length) clauses.push(`(${statusParts.join(" OR ")})`);
  const durationParts = f.durations.map((d) => DURATION_SQL[d]).filter(Boolean).map((p) => `(${p})`);
  if (durationParts.length) clauses.push(`(${durationParts.join(" OR ")})`);

  return { where: clauses.join("\n        AND "), args };
}

export function queryCatalog(userId: string, libIds: string[], opts: CatalogQuery): { books: ReturnType<typeof mapBookListRow>[]; total: number } {
  if (libIds.length === 0) return { books: [], total: 0 };

  const { where, args } = buildWhere(libIds, opts.q, opts.filters);
  const order = ORDER_BY[opts.sort] ?? ORDER_BY.title;

  const rows = db.prepare(`
    SELECT ${BOOK_LIST_COLUMNS}
    ${BOOK_LIST_JOINS}
      WHERE ${where}
      GROUP BY books.id
      ORDER BY ${order}, books.id
      LIMIT ? OFFSET ?
  `).all(userId, userId, ...args, opts.limit, opts.offset) as BookListRow[];

  const total = (db.prepare(`
    SELECT COUNT(*) AS n
    FROM books
    LEFT JOIN book_metadata ON book_metadata.book_id = books.id
    LEFT JOIN series ON series.id = books.series_id
    LEFT JOIN playback_progress AS progress ON progress.book_id = books.id AND progress.user_id = ?
    WHERE ${where}
  `).get(userId, ...args) as { n: number }).n;

  return { books: rows.map(mapBookListRow), total };
}

// Distinct filter options for the scope (the filter panel can't derive them from
// a single page). Status/duration are fixed enumerations on the client.
export function catalogFacets(libIds: string[]) {
  const empty = { authors: [], narrators: [], categories: [], tags: [], series: [], languages: [] };
  if (libIds.length === 0) return empty;
  const inLibs = placeholders(libIds.length);
  const col = (sql: string) => (db.prepare(sql).all(...libIds) as { v: string }[]).map((r) => r.v);

  return {
    authors: col(`SELECT DISTINCT a.name AS v FROM authors a JOIN book_authors ba ON ba.author_id = a.id JOIN books b ON b.id = ba.book_id WHERE ba.role = 'author' AND b.deleted_at IS NULL AND b.library_id IN (${inLibs}) ORDER BY a.name COLLATE NOCASE`),
    narrators: col(`SELECT DISTINCT a.name AS v FROM authors a JOIN book_authors ba ON ba.author_id = a.id JOIN books b ON b.id = ba.book_id WHERE ba.role = 'narrator' AND b.deleted_at IS NULL AND b.library_id IN (${inLibs}) ORDER BY a.name COLLATE NOCASE`),
    categories: col(`SELECT DISTINCT c.name AS v FROM categories c JOIN book_metadata m ON m.category_id = c.id JOIN books b ON b.id = m.book_id WHERE b.deleted_at IS NULL AND b.library_id IN (${inLibs}) ORDER BY c.name COLLATE NOCASE`),
    tags: col(`SELECT DISTINCT t.display_name AS v FROM tags t JOIN taggables tg ON tg.tag_id = t.id JOIN books b ON b.id = tg.entity_id WHERE tg.entity_type = 'book' AND b.deleted_at IS NULL AND b.library_id IN (${inLibs}) ORDER BY t.display_name COLLATE NOCASE`),
    series: col(`SELECT DISTINCT s.name AS v FROM series s JOIN books b ON b.series_id = s.id WHERE b.deleted_at IS NULL AND b.library_id IN (${inLibs}) ORDER BY s.name COLLATE NOCASE`),
    languages: col(`SELECT DISTINCT m.language AS v FROM book_metadata m JOIN books b ON b.id = m.book_id WHERE m.language IS NOT NULL AND m.language <> '' AND b.deleted_at IS NULL AND b.library_id IN (${inLibs}) ORDER BY m.language COLLATE NOCASE`)
  };
}
