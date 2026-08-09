// Ebook numbers for the admin Statistics page. Registered into the core status
// registry from ebookPlugin. See core/status-contributors.ts.

import { db } from "../../../db.js";
import { registerStatusContributor } from "../../../core/status-contributors.js";

interface EbookLibraryStatsRow {
  id: string;
  name: string;
  book_count: number;
  total_size_bytes: number;
}

interface EbookPersonStatsRow {
  name: string;
  book_count: number;
}

interface FormatStatsRow {
  format: string;
  count: number;
}

interface LargestEbookRow {
  id: string;
  title: string;
  library_name: string;
  author_names: string | null;
  total_size_bytes: number;
  formats: string | null;
}

function ebookLibraryStats() {
  const libraries = db.prepare(`
    WITH file_totals AS (
      SELECT item_id, SUM(COALESCE(size, 0)) AS size_bytes
      FROM document_files
      WHERE role = 'content' AND status = 'available' AND deleted_at IS NULL
      GROUP BY item_id
    ),
    book_totals AS (
      SELECT
        library_items.id,
        library_items.library_id,
        COALESCE(file_totals.size_bytes, 0) AS size_bytes
      FROM library_items
      LEFT JOIN file_totals ON file_totals.item_id = library_items.id
      WHERE library_items.deleted_at IS NULL
    )
    SELECT
      libraries.id,
      libraries.name,
      COUNT(book_totals.id) AS book_count,
      COALESCE(SUM(book_totals.size_bytes), 0) AS total_size_bytes
    FROM libraries
    LEFT JOIN book_totals ON book_totals.library_id = libraries.id
    WHERE libraries.type = 'ebook'
    GROUP BY libraries.id, libraries.name
    ORDER BY libraries.name COLLATE NOCASE
  `).all() as EbookLibraryStatsRow[];

  const topAuthors = db.prepare(`
    SELECT
      MIN(people.name) AS name,
      COUNT(DISTINCT library_items.id) AS book_count
    FROM item_people
    JOIN people ON people.id = item_people.person_id
    JOIN library_items ON library_items.id = item_people.item_id AND library_items.deleted_at IS NULL
    JOIN libraries ON libraries.id = library_items.library_id AND libraries.type = 'ebook'
    WHERE item_people.role = 'author'
    GROUP BY lower(people.name)
    ORDER BY book_count DESC, name COLLATE NOCASE
    LIMIT 10
  `).all() as EbookPersonStatsRow[];

  const formats = db.prepare(`
    SELECT
      UPPER(document_files.format) AS format,
      COUNT(*) AS count
    FROM document_files
    JOIN library_items ON library_items.id = document_files.item_id AND library_items.deleted_at IS NULL
    JOIN libraries ON libraries.id = library_items.library_id AND libraries.type = 'ebook'
    WHERE document_files.role = 'content' AND document_files.status = 'available' AND document_files.deleted_at IS NULL
    GROUP BY lower(document_files.format)
    ORDER BY count DESC, format COLLATE NOCASE
  `).all() as FormatStatsRow[];

  const largestBooks = db.prepare(`
    WITH file_totals AS (
      SELECT
        item_id,
        SUM(COALESCE(size, 0)) AS size_bytes,
        GROUP_CONCAT(DISTINCT UPPER(format)) AS formats
      FROM document_files
      WHERE role = 'content' AND status = 'available' AND deleted_at IS NULL
      GROUP BY item_id
    )
    SELECT
      library_items.id,
      COALESCE(NULLIF(item_metadata.title, ''), library_items.folder_path) AS title,
      libraries.name AS library_name,
      COALESCE((
        SELECT GROUP_CONCAT(name, ', ')
        FROM (
          SELECT people.name
          FROM item_people
          JOIN people ON people.id = item_people.person_id
          WHERE item_people.item_id = library_items.id AND item_people.role = 'author'
          ORDER BY item_people.sort_order, people.name COLLATE NOCASE
        )
      ), '') AS author_names,
      COALESCE(file_totals.size_bytes, 0) AS total_size_bytes,
      file_totals.formats AS formats
    FROM library_items
    JOIN libraries ON libraries.id = library_items.library_id AND libraries.type = 'ebook'
    LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
    LEFT JOIN file_totals ON file_totals.item_id = library_items.id
    WHERE library_items.deleted_at IS NULL
    ORDER BY total_size_bytes DESC, title COLLATE NOCASE
    LIMIT 10
  `).all() as LargestEbookRow[];

  const totalSizeBytes = libraries.reduce((sum, library) => sum + library.total_size_bytes, 0);
  const totalBooks = libraries.reduce((sum, library) => sum + library.book_count, 0);

  return {
    totalLibraries: libraries.length,
    totalBooks,
    totalSizeBytes,
    libraries: libraries.map((library) => ({
      id: library.id,
      name: library.name,
      bookCount: library.book_count,
      totalSizeBytes: library.total_size_bytes
    })),
    topAuthors: topAuthors.map((author) => ({
      name: author.name,
      bookCount: author.book_count
    })),
    formats: formats.map((row) => ({ format: row.format, count: row.count })),
    largestBooks: largestBooks.map((book) => ({
      id: book.id,
      title: book.title,
      libraryName: book.library_name,
      authors: book.author_names ? book.author_names.split(", ").filter(Boolean) : [],
      formats: book.formats ? book.formats.split(",").filter(Boolean) : [],
      totalSizeBytes: book.total_size_bytes
    }))
  };
}

export function registerEbookStats(): void {
  registerStatusContributor("ebook", ["ebookStats"], () => ({ ebookStats: ebookLibraryStats() }));
}
