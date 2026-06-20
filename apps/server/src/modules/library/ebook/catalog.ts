import {
  resolveScopeLibraryIds as coreResolveScopeLibraryIds,
  queryCatalog as coreQueryCatalog,
  catalogFacets as coreCatalogFacets,
  editionRepresentativeSql,
  type CatalogConfig,
  type CatalogQuery
} from "../shared/catalog-core.js";
import { splitGroupConcat, categoryPayload, bookTags, largeCoverUrl } from "../audiobook/book-helpers.js";

// Columns/joins for the ebook catalog. Unlike audiobooks, content is documents
// (document_files) and progress is per-document reading_progress — folded to the
// most recently touched row per item so the shared status SQL (which reads the
// `progress` alias) works unchanged. The page query binds the user id twice
// (progress, then saves); the COUNT query binds it once (progress).
const EBOOK_PROGRESS_JOIN = `
      LEFT JOIN (
        SELECT item_id, percent_complete, completed_at,
          ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY datetime(updated_at) DESC) AS rn
        FROM reading_progress
        WHERE user_id = ?
      ) AS progress ON progress.item_id = library_items.id AND progress.rn = 1`;

const EBOOK_LIST_COLUMNS = `
        library_items.id,
        library_items.library_id,
        library_items.folder_path,
        library_items.status,
        library_items.discovered_at,
        library_items.updated_at,
        library_items.deleted_at,
        item_metadata.title,
        item_metadata.sort_title,
        item_metadata.language,
        item_metadata.year_published,
        item_metadata.cover_storage_key,
        (SELECT ic.category_id FROM item_categories ic WHERE ic.item_id = library_items.id AND ic.is_primary = 1 LIMIT 1) AS category_id,
        GROUP_CONCAT(DISTINCT authors.name) AS author_names,
        (SELECT format FROM document_files WHERE document_files.item_id = library_items.id AND document_files.status = 'available' ORDER BY CASE format WHEN 'epub' THEN 0 WHEN 'pdf' THEN 1 ELSE 2 END, relative_path LIMIT 1) AS format,
        (SELECT id FROM document_files WHERE document_files.item_id = library_items.id AND document_files.status = 'available' ORDER BY CASE format WHEN 'epub' THEN 0 WHEN 'pdf' THEN 1 ELSE 2 END, relative_path LIMIT 1) AS document_id,
        (SELECT GROUP_CONCAT(id || ':' || format) FROM document_files WHERE document_files.item_id = library_items.id AND document_files.status = 'available') AS documents,
        (SELECT COUNT(*) FROM document_files WHERE document_files.item_id = library_items.id AND document_files.status = 'available') AS file_count,
        (SELECT COALESCE(SUM(document_files.size), 0) FROM document_files WHERE document_files.item_id = library_items.id AND document_files.status = 'available') AS total_size,
        (SELECT COUNT(*) FROM work_items wsib
           JOIN work_items wself ON wself.work_id = wsib.work_id
           JOIN library_items wli ON wli.id = wsib.item_id AND wli.deleted_at IS NULL
           WHERE wself.item_id = library_items.id) AS edition_count,
        progress.percent_complete AS progress_percent,
        progress.completed_at AS progress_completed_at,
        (item_saves.id IS NOT NULL) AS saved`;

const EBOOK_LIST_JOINS = `
      FROM library_items
      LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
      LEFT JOIN item_people ON item_people.item_id = library_items.id AND item_people.role = 'author'
      LEFT JOIN people AS authors ON authors.id = item_people.person_id${EBOOK_PROGRESS_JOIN}
      LEFT JOIN item_saves ON item_saves.item_id = library_items.id AND item_saves.user_id = ?`;

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
  documents: string | null;
  file_count: number;
  total_size: number;
  edition_count: number;
  progress_percent: number | null;
  progress_completed_at: string | null;
  saved: number;
}

const FORMAT_RANK: Record<string, number> = { epub: 0, pdf: 1 };
const formatRank = (format: string): number => FORMAT_RANK[format] ?? 2;

function mapEbookRow(row: EbookCatalogRow) {
  const coverUrl = row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null;
  // "id:format" pairs from GROUP_CONCAT → an ordered list (EPUB first) for the format
  // chips and OPDS per-format acquisition links.
  const documents = (row.documents ?? "")
    .split(",")
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf(":");
      return { id: pair.slice(0, idx), format: pair.slice(idx + 1) };
    })
    .sort((a, b) => formatRank(a.format) - formatRank(b.format));
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
    documents,
    formats: documents.map((doc) => doc.format),
    fileCount: row.file_count,
    totalSize: row.total_size ?? 0,
    editionCount: row.edition_count ?? 0,
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
      LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id${EBOOK_PROGRESS_JOIN}`,
  orderBy: {
    title: "COALESCE(item_metadata.sort_title, item_metadata.title, library_items.folder_path) COLLATE NOCASE ASC",
    title_desc: "COALESCE(item_metadata.sort_title, item_metadata.title, library_items.folder_path) COLLATE NOCASE DESC",
    recent: "library_items.discovered_at DESC",
    author: "(SELECT p.name FROM item_people ip JOIN people p ON p.id = ip.person_id WHERE ip.item_id = library_items.id AND ip.role = 'author' ORDER BY ip.sort_order LIMIT 1) COLLATE NOCASE ASC, COALESCE(item_metadata.sort_title, item_metadata.title) COLLATE NOCASE ASC"
  },
  searchSql: "(item_metadata.title LIKE ? OR EXISTS (SELECT 1 FROM item_people ip JOIN people p ON p.id = ip.person_id WHERE ip.item_id = library_items.id AND p.name LIKE ?))",
  searchArgs: 2,
  extraClauses: [],
  facetQueries: {
    authors: (inLibs) => `SELECT DISTINCT p.name AS v FROM people p JOIN item_people ip ON ip.person_id = p.id JOIN library_items b ON b.id = ip.item_id WHERE ip.role = 'author' AND b.deleted_at IS NULL AND b.library_id IN (${inLibs}) AND ${editionRepresentativeSql("b")} ORDER BY p.name COLLATE NOCASE`,
    categories: (inLibs) => `SELECT DISTINCT c.name AS v FROM categories c JOIN item_categories ic ON ic.category_id = c.id JOIN library_items b ON b.id = ic.item_id WHERE b.deleted_at IS NULL AND b.library_id IN (${inLibs}) AND ${editionRepresentativeSql("b")} ORDER BY c.name COLLATE NOCASE`,
    tags: (inLibs) => `SELECT DISTINCT t.display_name AS v FROM tags t JOIN taggables tg ON tg.tag_id = t.id JOIN library_items b ON b.id = tg.entity_id WHERE tg.entity_type = 'library_item' AND b.deleted_at IS NULL AND b.library_id IN (${inLibs}) AND ${editionRepresentativeSql("b")} ORDER BY t.display_name COLLATE NOCASE`,
    languages: (inLibs) => `SELECT DISTINCT m.language AS v FROM item_metadata m JOIN library_items b ON b.id = m.item_id WHERE m.language IS NOT NULL AND m.language <> '' AND b.deleted_at IS NULL AND b.library_id IN (${inLibs}) AND ${editionRepresentativeSql("b")} ORDER BY m.language COLLATE NOCASE`
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
