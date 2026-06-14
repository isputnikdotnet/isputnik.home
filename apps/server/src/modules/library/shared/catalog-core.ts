import { db } from "../../../db.js";
import { canUserAccessLibrary } from "./library-access.js";

// Generic, server-side book catalog engine shared by every library type. The
// type-specific SQL (which progress/size tables to join, which sorts/facets
// apply, how to map a row) is supplied by a CatalogConfig; the scaffolding here —
// scope resolution, the WHERE builder, pagination, COUNT and facets — is common.

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

export type FacetKey = "authors" | "narrators" | "categories" | "tags" | "series" | "languages";

// A type-specific filter clause: returns SQL + its bound args, or null when the
// filter is empty for this request.
export type ExtraClause = (filters: CatalogFilters) => { sql: string; args: unknown[] } | null;

export interface CatalogConfig<Row = Record<string, unknown>, Mapped = unknown> {
  libraryType: string;
  // SELECT column list for the page query. With listJoins it binds the user id
  // TWICE (progress, then saves) as the first two positional params.
  listColumns: string;
  listJoins: string;
  // Join block for the COUNT query (no "FROM books") — binds the user id ONCE
  // (progress), and must include whatever the WHERE/status clauses reference.
  countJoins: string;
  // sort key -> ORDER BY expression. `title` is the fallback.
  orderBy: Record<string, string>;
  // Free-text search clause and how many `?` placeholders it carries (each bound
  // to the same `%q%`).
  searchSql: string;
  searchArgs: number;
  // Type-specific filter clauses (e.g. audiobook narrators/series/durations).
  extraClauses: ExtraClause[];
  // Facet name -> SQL builder (given the libraryId IN-placeholders). Omitted
  // facets come back empty, so the client shape is always complete.
  facetQueries: Partial<Record<FacetKey, (inLibs: string) => string>>;
  mapRow: (row: Row) => Mapped;
}

const placeholders = (n: number) => Array(n).fill("?").join(", ");

interface LibraryRow {
  id: string;
}

// Library ids the user can see for a scope:
//   all      → every accessible library of this type
//   library  → one library (when accessible)
export function resolveScopeLibraryIds(
  user: { id: string; role: string },
  scope: string,
  libraryId: string | undefined,
  libraryType: string
): string[] {
  const rows = db.prepare("SELECT id FROM libraries WHERE type = ?").all(libraryType) as LibraryRow[];
  return rows
    .filter((row) => canUserAccessLibrary(row, user.id, user.role))
    .filter((row) => (scope === "library" ? row.id === libraryId : true))
    .map((row) => row.id);
}

// Status is shared across types: every config exposes the user's progress through
// a join aliased `progress` with completed_at / percent_complete columns.
const STATUS_SQL: Record<string, string> = {
  finished: "(progress.completed_at IS NOT NULL)",
  in_progress: "(progress.completed_at IS NULL AND progress.percent_complete > 0)",
  not_started: "(progress.completed_at IS NULL AND (progress.percent_complete IS NULL OR progress.percent_complete = 0))"
};

// Builds the WHERE clause + its bound args (after the leading user-id param[s]).
// Common book filters (authors/categories/tags/languages/status) are handled here;
// the config adds the free-text search clause and any type-specific extras.
function buildWhere(libIds: string[], q: string, f: CatalogFilters, config: CatalogConfig): { where: string; args: unknown[] } {
  const clauses: string[] = ["books.deleted_at IS NULL", `books.library_id IN (${placeholders(libIds.length)})`];
  const args: unknown[] = [...libIds];

  if (q) {
    clauses.push(config.searchSql);
    const like = `%${q}%`;
    for (let i = 0; i < config.searchArgs; i += 1) args.push(like);
  }
  if (f.authors.length) {
    clauses.push(`EXISTS (SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = books.id AND ba.role = 'author' AND a.name IN (${placeholders(f.authors.length)}))`);
    args.push(...f.authors);
  }
  if (f.categories.length) {
    clauses.push(`book_metadata.category_id IN (SELECT id FROM categories WHERE name IN (${placeholders(f.categories.length)}))`);
    args.push(...f.categories);
  }
  if (f.tags.length) {
    clauses.push(`EXISTS (SELECT 1 FROM taggables tg JOIN tags t ON t.id = tg.tag_id WHERE tg.entity_type = 'book' AND tg.entity_id = books.id AND t.display_name IN (${placeholders(f.tags.length)}))`);
    args.push(...f.tags);
  }
  if (f.languages.length) {
    clauses.push(`book_metadata.language IN (${placeholders(f.languages.length)})`);
    args.push(...f.languages);
  }
  const statusParts = f.status.map((s) => STATUS_SQL[s]).filter(Boolean);
  if (statusParts.length) clauses.push(`(${statusParts.join(" OR ")})`);

  for (const extra of config.extraClauses) {
    const clause = extra(f);
    if (clause) { clauses.push(clause.sql); args.push(...clause.args); }
  }

  return { where: clauses.join("\n        AND "), args };
}

export function queryCatalog<Mapped>(
  userId: string,
  libIds: string[],
  opts: CatalogQuery,
  config: CatalogConfig<Record<string, unknown>, Mapped>
): { books: Mapped[]; total: number } {
  if (libIds.length === 0) return { books: [], total: 0 };

  const { where, args } = buildWhere(libIds, opts.q, opts.filters, config);
  const order = config.orderBy[opts.sort] ?? config.orderBy.title;

  const rows = db.prepare(`
    SELECT ${config.listColumns}
    ${config.listJoins}
      WHERE ${where}
      GROUP BY books.id
      ORDER BY ${order}, books.id
      LIMIT ? OFFSET ?
  `).all(userId, userId, ...args, opts.limit, opts.offset) as Record<string, unknown>[];

  const total = (db.prepare(`
    SELECT COUNT(*) AS n
    FROM books
    ${config.countJoins}
    WHERE ${where}
  `).get(userId, ...args) as { n: number }).n;

  return { books: rows.map(config.mapRow), total };
}

// Distinct filter options for the scope (a single page can't derive them).
// Status/duration are fixed enumerations on the client, so they aren't returned.
export function catalogFacets(libIds: string[], config: CatalogConfig): Record<FacetKey, string[]> {
  const empty: Record<FacetKey, string[]> = { authors: [], narrators: [], categories: [], tags: [], series: [], languages: [] };
  if (libIds.length === 0) return empty;

  const inLibs = placeholders(libIds.length);
  const run = (sql: string) => (db.prepare(sql).all(...libIds) as { v: string }[]).map((r) => r.v);
  const keys: FacetKey[] = ["authors", "narrators", "categories", "tags", "series", "languages"];
  for (const key of keys) {
    const build = config.facetQueries[key];
    if (build) empty[key] = run(build(inLibs));
  }
  return empty;
}
