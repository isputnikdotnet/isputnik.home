import {
  resolveScopeLibraryIds as coreResolveScopeLibraryIds,
  queryCatalog as coreQueryCatalog,
  catalogFacets as coreCatalogFacets,
  type CatalogConfig,
  type CatalogQuery
} from "../shared/catalog-core.js";
import { splitGroupConcat, categoryPayload, bookTags, largeCoverUrl } from "../audiobook/book-helpers.js";

// Columns/joins for the ebook catalog. Unlike audiobooks, content is documents
// (book_documents) and progress is per-document reading_progress — folded to the
// most recently touched row per book so the shared status SQL (which reads the
// `progress` alias) works unchanged. The page query binds the user id twice
// (progress, then saves); the COUNT query binds it once (progress).
const EBOOK_PROGRESS_JOIN = `
      LEFT JOIN (
        SELECT book_id, percent_complete, completed_at,
          ROW_NUMBER() OVER (PARTITION BY book_id ORDER BY datetime(updated_at) DESC) AS rn
        FROM reading_progress
        WHERE user_id = ?
      ) AS progress ON progress.book_id = books.id AND progress.rn = 1`;

const EBOOK_LIST_COLUMNS = `
        books.id,
        books.library_id,
        books.folder_path,
        books.status,
        books.discovered_at,
        books.updated_at,
        books.deleted_at,
        book_metadata.title,
        book_metadata.sort_title,
        book_metadata.language,
        book_metadata.year_published,
        book_metadata.cover_storage_key,
        book_metadata.category_id,
        GROUP_CONCAT(DISTINCT authors.name) AS author_names,
        (SELECT format FROM book_documents WHERE book_documents.book_id = books.id AND book_documents.status = 'available' LIMIT 1) AS format,
        (SELECT id FROM book_documents WHERE book_documents.book_id = books.id AND book_documents.status = 'available' LIMIT 1) AS document_id,
        (SELECT COUNT(*) FROM book_documents WHERE book_documents.book_id = books.id AND book_documents.status = 'available') AS file_count,
        (SELECT COALESCE(SUM(book_documents.size), 0) FROM book_documents WHERE book_documents.book_id = books.id AND book_documents.status = 'available') AS total_size,
        progress.percent_complete AS progress_percent,
        progress.completed_at AS progress_completed_at,
        (book_saves.id IS NOT NULL) AS saved`;

const EBOOK_LIST_JOINS = `
      FROM books
      LEFT JOIN book_metadata ON book_metadata.book_id = books.id
      LEFT JOIN book_authors ON book_authors.book_id = books.id AND book_authors.role = 'author'
      LEFT JOIN authors ON authors.id = book_authors.author_id${EBOOK_PROGRESS_JOIN}
      LEFT JOIN book_saves ON book_saves.book_id = books.id AND book_saves.user_id = ?`;

interface EbookCatalogRow {
  id: string;
  library_id: string;
  folder_path: string;
  status: string;
  discovered_at: string;
  updated_at: string;
  title: string | null;
  language: string | null;
  year_published: number | null;
  cover_storage_key: string | null;
  category_id: string | null;
  author_names: string | null;
  format: string | null;
  document_id: string | null;
  file_count: number;
  total_size: number;
  progress_percent: number | null;
  progress_completed_at: string | null;
  saved: number;
}

function mapEbookRow(row: EbookCatalogRow) {
  const coverUrl = row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null;
  return {
    id: row.id,
    libraryId: row.library_id,
    folderPath: row.folder_path,
    status: row.status,
    title: row.title ?? row.folder_path.split("/").pop() ?? row.folder_path,
    series: null,
    seriesPosition: null,
    authors: splitGroupConcat(row.author_names),
    narrators: [],
    category: categoryPayload(row.category_id),
    tags: bookTags(row.id),
    language: row.language,
    format: row.format,
    documentId: row.document_id,
    fileCount: row.file_count,
    totalSize: row.total_size ?? 0,
    durationSeconds: null,
    yearPublished: row.year_published,
    coverUrl,
    coverLargeUrl: largeCoverUrl(row.cover_storage_key),
    publisher: null,
    asin: null,
    progress: { percentComplete: row.progress_percent, completedAt: row.progress_completed_at },
    saved: Boolean(row.saved),
    discoveredAt: row.discovered_at,
    updatedAt: row.updated_at
  };
}

// Ebook-specific catalog wiring for the shared engine. No durations, narrators, or
// series — search and facets cover title/author/category/tag/language only.
export const ebookCatalogConfig: CatalogConfig = {
  libraryType: "ebook",
  listColumns: EBOOK_LIST_COLUMNS,
  listJoins: EBOOK_LIST_JOINS,
  countJoins: `
      LEFT JOIN book_metadata ON book_metadata.book_id = books.id${EBOOK_PROGRESS_JOIN}`,
  orderBy: {
    title: "COALESCE(book_metadata.sort_title, book_metadata.title, books.folder_path) COLLATE NOCASE ASC",
    title_desc: "COALESCE(book_metadata.sort_title, book_metadata.title, books.folder_path) COLLATE NOCASE DESC",
    recent: "books.discovered_at DESC",
    author: "(SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = books.id AND ba.role = 'author' ORDER BY ba.sort_order LIMIT 1) COLLATE NOCASE ASC, COALESCE(book_metadata.sort_title, book_metadata.title) COLLATE NOCASE ASC"
  },
  searchSql: "(book_metadata.title LIKE ? OR EXISTS (SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = books.id AND a.name LIKE ?))",
  searchArgs: 2,
  extraClauses: [],
  facetQueries: {
    authors: (inLibs) => `SELECT DISTINCT a.name AS v FROM authors a JOIN book_authors ba ON ba.author_id = a.id JOIN books b ON b.id = ba.book_id WHERE ba.role = 'author' AND b.deleted_at IS NULL AND b.library_id IN (${inLibs}) ORDER BY a.name COLLATE NOCASE`,
    categories: (inLibs) => `SELECT DISTINCT c.name AS v FROM categories c JOIN book_metadata m ON m.category_id = c.id JOIN books b ON b.id = m.book_id WHERE b.deleted_at IS NULL AND b.library_id IN (${inLibs}) ORDER BY c.name COLLATE NOCASE`,
    tags: (inLibs) => `SELECT DISTINCT t.display_name AS v FROM tags t JOIN taggables tg ON tg.tag_id = t.id JOIN books b ON b.id = tg.entity_id WHERE tg.entity_type = 'book' AND b.deleted_at IS NULL AND b.library_id IN (${inLibs}) ORDER BY t.display_name COLLATE NOCASE`,
    languages: (inLibs) => `SELECT DISTINCT m.language AS v FROM book_metadata m JOIN books b ON b.id = m.book_id WHERE m.language IS NOT NULL AND m.language <> '' AND b.deleted_at IS NULL AND b.library_id IN (${inLibs}) ORDER BY m.language COLLATE NOCASE`
  },
  mapRow: (row) => mapEbookRow(row as unknown as EbookCatalogRow)
};

export function resolveEbookScopeLibraryIds(user: { id: string; role: string }, scope: string, libraryId?: string) {
  return coreResolveScopeLibraryIds(user, scope, libraryId, "ebook");
}

export function queryEbookCatalog(userId: string, libIds: string[], opts: CatalogQuery) {
  return coreQueryCatalog(userId, libIds, opts, ebookCatalogConfig);
}

export function ebookCatalogFacets(libIds: string[]) {
  return coreCatalogFacets(libIds, ebookCatalogConfig);
}
