// Audiobook numbers for the admin Statistics page. Registered into the core
// status registry from audiobookPlugin, so core/ never has to know that
// audio_files or audiobook_details exist. See core/status-contributors.ts.

import { db } from "../../../db.js";
import { registerStatusContributor } from "../../../core/status-contributors.js";

interface LibraryStatsRow {
  id: string;
  name: string;
  book_count: number;
  total_size_bytes: number;
  total_duration_seconds: number;
}

interface PersonStatsRow {
  name: string;
  book_count: number;
  total_duration_seconds: number;
}

interface LongestBookRow {
  id: string;
  title: string;
  library_name: string;
  author_names: string | null;
  total_size_bytes: number;
  total_duration_seconds: number;
}

function audiobookLibraryStats() {
  const libraries = db.prepare(`
    WITH file_totals AS (
      SELECT
        item_id,
        SUM(COALESCE(size, 0)) AS size_bytes,
        SUM(COALESCE(duration_seconds, 0)) AS duration_seconds
      FROM audio_files
      WHERE deleted_at IS NULL AND status = 'available'
      GROUP BY item_id
    ),
    book_totals AS (
      SELECT
        library_items.id,
        library_items.library_id,
        COALESCE(audiobook_details.duration_seconds, file_totals.duration_seconds, 0) AS duration_seconds,
        COALESCE(file_totals.size_bytes, 0) AS size_bytes
      FROM library_items
      LEFT JOIN audiobook_details ON audiobook_details.item_id = library_items.id
      LEFT JOIN file_totals ON file_totals.item_id = library_items.id
      WHERE library_items.deleted_at IS NULL
    )
    SELECT
      libraries.id,
      libraries.name,
      COUNT(book_totals.id) AS book_count,
      COALESCE(SUM(book_totals.size_bytes), 0) AS total_size_bytes,
      COALESCE(SUM(book_totals.duration_seconds), 0) AS total_duration_seconds
    FROM libraries
    LEFT JOIN book_totals ON book_totals.library_id = libraries.id
    WHERE libraries.type = 'audiobook'
    GROUP BY libraries.id, libraries.name
    ORDER BY libraries.name COLLATE NOCASE
  `).all() as LibraryStatsRow[];

  const peopleByRole = (role: "author" | "narrator") => db.prepare(`
    WITH file_totals AS (
      SELECT
        item_id,
        SUM(COALESCE(duration_seconds, 0)) AS duration_seconds
      FROM audio_files
      WHERE deleted_at IS NULL AND status = 'available'
      GROUP BY item_id
    ),
    book_totals AS (
      SELECT
        library_items.id,
        COALESCE(audiobook_details.duration_seconds, file_totals.duration_seconds, 0) AS duration_seconds
      FROM library_items
      JOIN libraries ON libraries.id = library_items.library_id AND libraries.type = 'audiobook'
      LEFT JOIN audiobook_details ON audiobook_details.item_id = library_items.id
      LEFT JOIN file_totals ON file_totals.item_id = library_items.id
      WHERE library_items.deleted_at IS NULL
    )
    SELECT
      MIN(people.name) AS name,
      COUNT(DISTINCT book_totals.id) AS book_count,
      COALESCE(SUM(book_totals.duration_seconds), 0) AS total_duration_seconds
    FROM item_people
    JOIN people ON people.id = item_people.person_id
    JOIN book_totals ON book_totals.id = item_people.item_id
    WHERE item_people.role = ?
    GROUP BY lower(people.name)
    ORDER BY book_count DESC, total_duration_seconds DESC, name COLLATE NOCASE
    LIMIT 10
  `).all(role) as PersonStatsRow[];

  const longestBooks = db.prepare(`
    WITH file_totals AS (
      SELECT
        item_id,
        SUM(COALESCE(size, 0)) AS size_bytes,
        SUM(COALESCE(duration_seconds, 0)) AS duration_seconds
      FROM audio_files
      WHERE deleted_at IS NULL AND status = 'available'
      GROUP BY item_id
    ),
    book_totals AS (
      SELECT
        library_items.id,
        library_items.library_id,
        COALESCE(NULLIF(item_metadata.title, ''), library_items.folder_path) AS title,
        COALESCE(audiobook_details.duration_seconds, file_totals.duration_seconds, 0) AS duration_seconds,
        COALESCE(file_totals.size_bytes, 0) AS size_bytes
      FROM library_items
      LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
      LEFT JOIN audiobook_details ON audiobook_details.item_id = library_items.id
      LEFT JOIN file_totals ON file_totals.item_id = library_items.id
      WHERE library_items.deleted_at IS NULL
    )
    SELECT
      book_totals.id,
      book_totals.title,
      libraries.name AS library_name,
      COALESCE((
        SELECT GROUP_CONCAT(name, ', ')
        FROM (
          SELECT people.name
          FROM item_people
          JOIN people ON people.id = item_people.person_id
          WHERE item_people.item_id = book_totals.id AND item_people.role = 'author'
          ORDER BY item_people.sort_order, people.name COLLATE NOCASE
        )
      ), '') AS author_names,
      book_totals.size_bytes AS total_size_bytes,
      book_totals.duration_seconds AS total_duration_seconds
    FROM book_totals
    JOIN libraries ON libraries.id = book_totals.library_id AND libraries.type = 'audiobook'
    ORDER BY total_duration_seconds DESC, total_size_bytes DESC, title COLLATE NOCASE
    LIMIT 10
  `).all() as LongestBookRow[];

  const totalSizeBytes = libraries.reduce((sum, library) => sum + library.total_size_bytes, 0);
  const totalDurationSeconds = libraries.reduce((sum, library) => sum + library.total_duration_seconds, 0);
  const totalBooks = libraries.reduce((sum, library) => sum + library.book_count, 0);

  return {
    totalLibraries: libraries.length,
    totalBooks,
    totalSizeBytes,
    totalDurationSeconds,
    libraries: libraries.map((library) => ({
      id: library.id,
      name: library.name,
      bookCount: library.book_count,
      totalSizeBytes: library.total_size_bytes,
      totalDurationSeconds: library.total_duration_seconds
    })),
    topAuthors: peopleByRole("author").map((author) => ({
      name: author.name,
      bookCount: author.book_count,
      totalDurationSeconds: author.total_duration_seconds
    })),
    topNarrators: peopleByRole("narrator").map((narrator) => ({
      name: narrator.name,
      bookCount: narrator.book_count,
      totalDurationSeconds: narrator.total_duration_seconds
    })),
    longestBooks: longestBooks.map((book) => ({
      id: book.id,
      title: book.title,
      libraryName: book.library_name,
      authors: book.author_names ? book.author_names.split(", ").filter(Boolean) : [],
      totalSizeBytes: book.total_size_bytes,
      totalDurationSeconds: book.total_duration_seconds
    }))
  };
}

export function registerAudiobookStats(): void {
  registerStatusContributor("audiobook", ["audiobookLibraries", "audiobookBooks", "libraryStats"], () => ({
    audiobookLibraries: (db.prepare("SELECT COUNT(*) AS count FROM libraries WHERE type = 'audiobook'").get() as { count: number }).count,
    audiobookBooks: (db.prepare("SELECT COUNT(*) AS count FROM library_items WHERE deleted_at IS NULL").get() as { count: number }).count,
    libraryStats: audiobookLibraryStats()
  }));
}
