import { BOOK_LIST_COLUMNS, BOOK_LIST_JOINS, mapBookListRow } from "./book-helpers.js";
import {
  resolveScopeLibraryIds as coreResolveScopeLibraryIds,
  queryCatalog as coreQueryCatalog,
  catalogFacets as coreCatalogFacets,
  editionRepresentativeSql,
  type CatalogConfig,
  type CatalogQuery
} from "../shared/catalog-core.js";

export type { CatalogFilters, CatalogQuery } from "../shared/catalog-core.js";

const placeholders = (n: number) => Array(n).fill("?").join(", ");

const ORDER_BY: Record<string, string> = {
  title: "COALESCE(item_metadata.sort_title, item_metadata.title, library_items.folder_path) COLLATE NOCASE ASC",
  title_desc: "COALESCE(item_metadata.sort_title, item_metadata.title, library_items.folder_path) COLLATE NOCASE DESC",
  recent: "library_items.discovered_at DESC",
  duration: "audiobook_details.duration_seconds DESC",
  author: "(SELECT p.name FROM item_people ip JOIN people p ON p.id = ip.person_id WHERE ip.item_id = library_items.id AND ip.role = 'author' ORDER BY ip.sort_order LIMIT 1) COLLATE NOCASE ASC, COALESCE(item_metadata.sort_title, item_metadata.title) COLLATE NOCASE ASC",
  series: "series.name IS NULL, series.name COLLATE NOCASE ASC, series_items.position ASC, COALESCE(item_metadata.sort_title, item_metadata.title) COLLATE NOCASE ASC"
};

const DURATION_SQL: Record<string, string> = {
  short: "audiobook_details.duration_seconds < 7200",
  medium: "audiobook_details.duration_seconds >= 7200 AND audiobook_details.duration_seconds < 21600",
  long: "audiobook_details.duration_seconds >= 21600 AND audiobook_details.duration_seconds < 43200",
  epic: "audiobook_details.duration_seconds >= 43200"
};

// Audiobook-specific catalog wiring for the shared engine. The emitted SQL matches
// the per-library list route (BOOK_LIST_COLUMNS/JOINS/mapBookListRow), so the grid
// and the paged catalog return an identical book shape.
export const audiobookCatalogConfig: CatalogConfig = {
  libraryType: "audiobook",
  listColumns: BOOK_LIST_COLUMNS,
  listJoins: BOOK_LIST_JOINS,
  countJoins: `
      LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
      LEFT JOIN audiobook_details ON audiobook_details.item_id = library_items.id
      LEFT JOIN series_items ON series_items.item_id = library_items.id
      LEFT JOIN series ON series.id = series_items.series_id
      LEFT JOIN playback_progress AS progress ON progress.item_id = library_items.id AND progress.user_id = ?`,
  orderBy: ORDER_BY,
  searchSql: "(item_metadata.title LIKE ? OR series.name LIKE ? OR EXISTS (SELECT 1 FROM item_people ip JOIN people p ON p.id = ip.person_id WHERE ip.item_id = library_items.id AND p.name LIKE ?))",
  searchArgs: 3,
  extraClauses: [
    (f) => f.narrators.length
      ? { sql: `EXISTS (SELECT 1 FROM item_people ip JOIN people p ON p.id = ip.person_id WHERE ip.item_id = library_items.id AND ip.role = 'narrator' AND p.name IN (${placeholders(f.narrators.length)}))`, args: f.narrators }
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
    authors: (inLibs) => `SELECT DISTINCT p.name AS v FROM people p JOIN item_people ip ON ip.person_id = p.id JOIN library_items b ON b.id = ip.item_id WHERE ip.role = 'author' AND b.deleted_at IS NULL AND b.library_id IN (${inLibs}) AND ${editionRepresentativeSql("b")} ORDER BY p.name COLLATE NOCASE`,
    narrators: (inLibs) => `SELECT DISTINCT p.name AS v FROM people p JOIN item_people ip ON ip.person_id = p.id JOIN library_items b ON b.id = ip.item_id WHERE ip.role = 'narrator' AND b.deleted_at IS NULL AND b.library_id IN (${inLibs}) AND ${editionRepresentativeSql("b")} ORDER BY p.name COLLATE NOCASE`,
    categories: (inLibs) => `SELECT DISTINCT c.name AS v FROM categories c JOIN item_categories ic ON ic.category_id = c.id JOIN library_items b ON b.id = ic.item_id WHERE b.deleted_at IS NULL AND b.library_id IN (${inLibs}) AND ${editionRepresentativeSql("b")} ORDER BY c.name COLLATE NOCASE`,
    tags: (inLibs) => `SELECT DISTINCT t.display_name AS v FROM tags t JOIN taggables tg ON tg.tag_id = t.id JOIN library_items b ON b.id = tg.entity_id WHERE tg.entity_type = 'library_item' AND b.deleted_at IS NULL AND b.library_id IN (${inLibs}) AND ${editionRepresentativeSql("b")} ORDER BY t.display_name COLLATE NOCASE`,
    series: (inLibs) => `SELECT DISTINCT s.name AS v FROM series s JOIN series_items si ON si.series_id = s.id JOIN library_items b ON b.id = si.item_id WHERE b.deleted_at IS NULL AND b.library_id IN (${inLibs}) AND ${editionRepresentativeSql("b")} ORDER BY s.name COLLATE NOCASE`,
    languages: (inLibs) => `SELECT DISTINCT m.language AS v FROM item_metadata m JOIN library_items b ON b.id = m.item_id WHERE m.language IS NOT NULL AND m.language <> '' AND b.deleted_at IS NULL AND b.library_id IN (${inLibs}) AND ${editionRepresentativeSql("b")} ORDER BY m.language COLLATE NOCASE`
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
