import { BOOK_LIST_COLUMNS, BOOK_LIST_JOINS, mapBookListRow } from "./book-helpers.js";
import {
  resolveScopeLibraryIds as coreResolveScopeLibraryIds,
  queryCatalog as coreQueryCatalog,
  catalogFacets as coreCatalogFacets,
  type CatalogConfig,
  type CatalogQuery
} from "../shared/catalog-core.js";

export type { CatalogFilters, CatalogQuery } from "../shared/catalog-core.js";

const placeholders = (n: number) => Array(n).fill("?").join(", ");

const ORDER_BY: Record<string, string> = {
  title: "COALESCE(book_metadata.sort_title, book_metadata.title, books.folder_path) COLLATE NOCASE ASC",
  title_desc: "COALESCE(book_metadata.sort_title, book_metadata.title, books.folder_path) COLLATE NOCASE DESC",
  recent: "books.discovered_at DESC",
  duration: "book_metadata.duration_seconds DESC",
  author: "(SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = books.id AND ba.role = 'author' ORDER BY ba.sort_order LIMIT 1) COLLATE NOCASE ASC, COALESCE(book_metadata.sort_title, book_metadata.title) COLLATE NOCASE ASC",
  series: "series.name IS NULL, series.name COLLATE NOCASE ASC, books.series_position ASC, COALESCE(book_metadata.sort_title, book_metadata.title) COLLATE NOCASE ASC"
};

const DURATION_SQL: Record<string, string> = {
  short: "book_metadata.duration_seconds < 7200",
  medium: "book_metadata.duration_seconds >= 7200 AND book_metadata.duration_seconds < 21600",
  long: "book_metadata.duration_seconds >= 21600 AND book_metadata.duration_seconds < 43200",
  epic: "book_metadata.duration_seconds >= 43200"
};

// Audiobook-specific catalog wiring for the shared engine. The emitted SQL matches
// the per-library list route (BOOK_LIST_COLUMNS/JOINS/mapBookListRow), so the grid
// and the paged catalog return an identical book shape.
export const audiobookCatalogConfig: CatalogConfig = {
  libraryType: "audiobook",
  listColumns: BOOK_LIST_COLUMNS,
  listJoins: BOOK_LIST_JOINS,
  countJoins: `
      LEFT JOIN book_metadata ON book_metadata.book_id = books.id
      LEFT JOIN series ON series.id = books.series_id
      LEFT JOIN playback_progress AS progress ON progress.book_id = books.id AND progress.user_id = ?`,
  orderBy: ORDER_BY,
  searchSql: "(book_metadata.title LIKE ? OR series.name LIKE ? OR EXISTS (SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = books.id AND a.name LIKE ?))",
  searchArgs: 3,
  extraClauses: [
    (f) => f.narrators.length
      ? { sql: `EXISTS (SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = books.id AND ba.role = 'narrator' AND a.name IN (${placeholders(f.narrators.length)}))`, args: f.narrators }
      : null,
    (f) => f.series.length
      ? { sql: `series.name IN (${placeholders(f.series.length)})`, args: f.series }
      : null,
    (f) => {
      const parts = f.durations.map((d) => DURATION_SQL[d]).filter(Boolean).map((p) => `(${p})`);
      return parts.length ? { sql: `(${parts.join(" OR ")})`, args: [] } : null;
    }
  ],
  facetQueries: {
    authors: (inLibs) => `SELECT DISTINCT a.name AS v FROM authors a JOIN book_authors ba ON ba.author_id = a.id JOIN books b ON b.id = ba.book_id WHERE ba.role = 'author' AND b.deleted_at IS NULL AND b.library_id IN (${inLibs}) ORDER BY a.name COLLATE NOCASE`,
    narrators: (inLibs) => `SELECT DISTINCT a.name AS v FROM authors a JOIN book_authors ba ON ba.author_id = a.id JOIN books b ON b.id = ba.book_id WHERE ba.role = 'narrator' AND b.deleted_at IS NULL AND b.library_id IN (${inLibs}) ORDER BY a.name COLLATE NOCASE`,
    categories: (inLibs) => `SELECT DISTINCT c.name AS v FROM categories c JOIN book_metadata m ON m.category_id = c.id JOIN books b ON b.id = m.book_id WHERE b.deleted_at IS NULL AND b.library_id IN (${inLibs}) ORDER BY c.name COLLATE NOCASE`,
    tags: (inLibs) => `SELECT DISTINCT t.display_name AS v FROM tags t JOIN taggables tg ON tg.tag_id = t.id JOIN books b ON b.id = tg.entity_id WHERE tg.entity_type = 'book' AND b.deleted_at IS NULL AND b.library_id IN (${inLibs}) ORDER BY t.display_name COLLATE NOCASE`,
    series: (inLibs) => `SELECT DISTINCT s.name AS v FROM series s JOIN books b ON b.series_id = s.id WHERE b.deleted_at IS NULL AND b.library_id IN (${inLibs}) ORDER BY s.name COLLATE NOCASE`,
    languages: (inLibs) => `SELECT DISTINCT m.language AS v FROM book_metadata m JOIN books b ON b.id = m.book_id WHERE m.language IS NOT NULL AND m.language <> '' AND b.deleted_at IS NULL AND b.library_id IN (${inLibs}) ORDER BY m.language COLLATE NOCASE`
  },
  mapRow: (row) => mapBookListRow(row as unknown as Parameters<typeof mapBookListRow>[0])
};

// Thin audiobook-bound wrappers so the audiobook routes stay unchanged.
export function resolveScopeLibraryIds(user: { id: string; role: string }, scope: string, libraryId?: string) {
  return coreResolveScopeLibraryIds(user, scope, libraryId, "audiobook");
}

export function queryCatalog(userId: string, libIds: string[], opts: CatalogQuery) {
  return coreQueryCatalog(userId, libIds, opts, audiobookCatalogConfig);
}

export function catalogFacets(libIds: string[]) {
  return coreCatalogFacets(libIds, audiobookCatalogConfig);
}
