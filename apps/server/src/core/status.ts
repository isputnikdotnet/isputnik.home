import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db.js";
import { config } from "../config.js";
import { RECENT_VERSION_COUNT, VERSION_UPDATES } from "../changelog.js";
import { anyFaceLibraryEnabled } from "../modules/library/gallery/faces/settings.js";

// Paging for the changelog tail. `limit` is capped so a caller cannot ask for
// the whole history in one response; a bad value falls back to the defaults
// rather than erroring, since this only ever feeds a "show earlier" button.
const changelogQuery = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(25)
});

function faceStats() {
  return {
    enabled: anyFaceLibraryEnabled(),
    people: (db.prepare("SELECT COUNT(*) n FROM gallery_people").get() as { n: number }).n,
    faces: (db.prepare("SELECT COUNT(*) n FROM gallery_faces").get() as { n: number }).n,
    scannedItems: (db.prepare("SELECT COUNT(*) n FROM gallery_face_scans").get() as { n: number }).n
  };
}

function databaseSize() {
  return [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`].reduce((total, file) => (
    total + (fs.existsSync(file) ? fs.statSync(file).size : 0)
  ), 0);
}

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

interface GalleryLibraryStatsRow {
  id: string;
  name: string;
  item_count: number;
  photo_count: number;
  video_count: number;
  total_size_bytes: number;
  total_duration_seconds: number;
}

interface LargestGalleryRow {
  id: string;
  title: string;
  library_name: string;
  kind: string;
  total_size_bytes: number;
  duration_seconds: number;
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

function galleryLibraryStats() {
  const libraries = db.prepare(`
    SELECT
      libraries.id,
      libraries.name,
      COUNT(library_items.id) AS item_count,
      COALESCE(SUM(CASE WHEN gallery_details.kind = 'photo' THEN 1 ELSE 0 END), 0) AS photo_count,
      COALESCE(SUM(CASE WHEN gallery_details.kind = 'video' THEN 1 ELSE 0 END), 0) AS video_count,
      COALESCE(SUM(COALESCE(gallery_details.size, 0)), 0) AS total_size_bytes,
      COALESCE(SUM(COALESCE(gallery_details.duration_seconds, 0)), 0) AS total_duration_seconds
    FROM libraries
    LEFT JOIN library_items ON library_items.library_id = libraries.id AND library_items.deleted_at IS NULL
    LEFT JOIN gallery_details ON gallery_details.item_id = library_items.id
    WHERE libraries.type = 'gallery'
    GROUP BY libraries.id, libraries.name
    ORDER BY libraries.name COLLATE NOCASE
  `).all() as GalleryLibraryStatsRow[];

  const largestItems = db.prepare(`
    SELECT
      library_items.id,
      COALESCE(NULLIF(item_metadata.title, ''), gallery_details.relative_path, library_items.folder_path) AS title,
      libraries.name AS library_name,
      gallery_details.kind,
      COALESCE(gallery_details.size, 0) AS total_size_bytes,
      COALESCE(gallery_details.duration_seconds, 0) AS duration_seconds
    FROM library_items
    JOIN libraries ON libraries.id = library_items.library_id AND libraries.type = 'gallery'
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
    WHERE library_items.deleted_at IS NULL
    ORDER BY total_size_bytes DESC, title COLLATE NOCASE
    LIMIT 10
  `).all() as LargestGalleryRow[];

  const totalSizeBytes = libraries.reduce((sum, library) => sum + library.total_size_bytes, 0);
  const totalDurationSeconds = libraries.reduce((sum, library) => sum + library.total_duration_seconds, 0);
  const totalItems = libraries.reduce((sum, library) => sum + library.item_count, 0);
  const totalPhotos = libraries.reduce((sum, library) => sum + library.photo_count, 0);
  const totalVideos = libraries.reduce((sum, library) => sum + library.video_count, 0);

  return {
    totalLibraries: libraries.length,
    totalItems,
    totalPhotos,
    totalVideos,
    totalSizeBytes,
    totalDurationSeconds,
    libraries: libraries.map((library) => ({
      id: library.id,
      name: library.name,
      itemCount: library.item_count,
      photoCount: library.photo_count,
      videoCount: library.video_count,
      totalSizeBytes: library.total_size_bytes,
      totalDurationSeconds: library.total_duration_seconds
    })),
    largestItems: largestItems.map((item) => ({
      id: item.id,
      title: item.title,
      libraryName: item.library_name,
      kind: item.kind,
      totalSizeBytes: item.total_size_bytes,
      durationSeconds: item.duration_seconds
    }))
  };
}

export async function statusPlugin(app: FastifyInstance) {
  app.get("/api/status", { preHandler: app.requireAdmin }, async () => {
    const users = db.prepare("SELECT COUNT(*) AS count FROM users WHERE deleted_at IS NULL").get() as { count: number };
    const sessions = db.prepare(`
      SELECT COUNT(*) AS count FROM sessions
      WHERE revoked_at IS NULL AND datetime(expires_at) > datetime('now')
    `).get() as { count: number };
    const activeInvites = db.prepare(`
      SELECT COUNT(*) AS count FROM invites
      WHERE revoked_at IS NULL AND used_at IS NULL AND datetime(expires_at) > datetime('now')
    `).get() as { count: number };
    const events = db.prepare("SELECT COUNT(*) AS count FROM activity_logs").get() as { count: number };
    const audiobookLibraries = db.prepare("SELECT COUNT(*) AS count FROM libraries WHERE type = 'audiobook'").get() as { count: number };
    const audiobookBooks = db.prepare("SELECT COUNT(*) AS count FROM library_items WHERE deleted_at IS NULL").get() as { count: number };
    const libraryStats = audiobookLibraryStats();
    const ebookStats = ebookLibraryStats();
    const galleryStats = galleryLibraryStats();

    return {
      status: {
        health: "Operational",
        databaseBytes: databaseSize(),
        users: users.count,
        activeSessions: sessions.count,
        activeInvites: activeInvites.count,
        logEntries: events.count,
        audiobookLibraries: audiobookLibraries.count,
        audiobookBooks: audiobookBooks.count,
        libraryStats,
        ebookStats,
        galleryStats,
        faceStats: faceStats(),
        uptimeSeconds: Math.floor(process.uptime()),
        generatedAt: new Date().toISOString()
      }
    };
  });

  app.get("/api/db/info", { preHandler: app.requireAdmin }, async () => {
    const dbPath = config.dbPath;
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;

    const statOrNull = (p: string) => {
      try { return fs.statSync(p); } catch { return null; }
    };

    const mainStat = statOrNull(dbPath);
    const walStat = statOrNull(walPath);

    const sizeBytes = mainStat?.size ?? 0;
    const walSizeBytes = walStat?.size ?? 0;
    const lastModified = mainStat?.mtime.toISOString() ?? null;

    return {
      db: {
        path: dbPath,
        directory: path.dirname(dbPath),
        filename: path.basename(dbPath),
        sizeBytes,
        walSizeBytes,
        totalSizeBytes: sizeBytes + walSizeBytes + (statOrNull(shmPath)?.size ?? 0),
        lastModified
      }
    };
  });

  app.get("/api/about", { preHandler: app.authenticate }, async () => ({
    about: {
      name: "isputnik.home",
      version: config.version,
      description: config.description,
      runtime: `Node.js ${process.version}`,
      database: "SQLite (WAL mode)",
      server: "Fastify + TypeScript",
      frontend: "React + TypeScript",
      // Only the newest releases travel with /api/about; the rest are paged in
      // from the endpoint below when the reader asks for them. See changelog.ts.
      versionUpdates: VERSION_UPDATES.slice(0, RECENT_VERSION_COUNT),
      versionUpdatesTotal: VERSION_UPDATES.length
    }
  }));

  // Older releases, oldest-page-last, for the About timeline's "show earlier"
  // control. Bounded per request so no caller can ask for the whole history in
  // one go — the reason any of this was split out in the first place.
  app.get("/api/about/changelog", { preHandler: app.authenticate }, async (request) => {
    const query = changelogQuery.safeParse(request.query);
    const { offset, limit } = query.success ? query.data : { offset: 0, limit: 25 };
    return {
      versionUpdates: VERSION_UPDATES.slice(offset, offset + limit),
      total: VERSION_UPDATES.length
    };
  });
}