import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "../../../db.js";
import { builtinCategoryImageUrl, isBuiltinCategoryImageKey } from "../../../categories-seed.js";
import { type MetadataCandidate } from "./providers/index.js";
import { sortTitle, writeCoverImages } from "./scanner.js";
import { writeMetadataExport } from "../shared/metadata.js";
import { pathIsInside } from "../shared/storage-roots.js";
import { setEntityTags, addEntityTags } from "./categorize.js";
import { type AudiobookBookRow, type BookFileRow } from "./types.js";

export function largeCoverUrl(storageKey: string | null) {
  if (!storageKey) {
    return null;
  }

  return `/api/library/covers/${storageKey.replace(/-cover\.webp$/i, "-cover-large.webp")}`;
}

export const progressUpdateSchema = z.object({
  fileId: z.string().min(1),
  positionSeconds: z.number().int().min(0)
});

export const metadataCandidateSchema = z.object({
  title: z.string().trim().min(1),
  subtitle: z.string().trim().optional(),
  authors: z.array(z.string().trim().min(1)).default([]),
  narrators: z.array(z.string().trim().min(1)).optional(),
  publisher: z.string().trim().optional(),
  year: z.number().int().optional(),
  description: z.string().trim().optional(),
  coverUrl: z.string().url().optional(),
  isbn: z.string().trim().optional(),
  asin: z.string().trim().optional(),
  genres: z.array(z.string().trim().min(1)).optional(),
  language: z.string().trim().optional(),
  source: z.enum(["itunes", "openlibrary", "fantlab"])
});

export const metadataMatchSchema = z.object({
  candidate: metadataCandidateSchema,
  updateDetails: z.boolean().default(true),
  updateCover: z.boolean().default(true)
});

export const coverSourceSchema = z.object({
  relativePath: z.string().trim().min(1).max(1000)
});

export const manualMetadataSchema = z.object({
  title: z.string().trim().min(1).max(240),
  authors: z.array(z.string().trim().min(1).max(160)).default([]),
  narrators: z.array(z.string().trim().min(1).max(160)).default([]),
  tags: z.array(z.string().trim().min(1).max(120)).default([]),
  categoryKey: z.string().trim().min(1).max(64).nullable().optional(),
  publisher: z.string().trim().max(240).nullable().optional(),
  yearPublished: z.number().int().min(0).max(3000).nullable().optional(),
  description: z.string().trim().max(20000).nullable().optional(),
  language: z.string().trim().max(24).nullable().optional(),
  isbn: z.string().trim().max(64).nullable().optional(),
  asin: z.string().trim().max(64).nullable().optional(),
  series: z.string().trim().max(240).nullable().optional(),
  seriesPosition: z.number().min(0).nullable().optional()
});

export function splitGroupConcat(value: string | null) {
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

export function uniqueValues(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function upsertAuthor(libraryId: string, name: string) {
  db.prepare("INSERT OR IGNORE INTO authors (id, library_id, name, sort_name) VALUES (?, ?, ?, ?)")
    .run(nanoid(16), libraryId, name, sortTitle(name));
  return db.prepare("SELECT id FROM authors WHERE library_id = ? AND name = ?").get(libraryId, name) as { id: string };
}

export function replaceBookPeople(bookId: string, libraryId: string, role: "author" | "narrator", names: string[]) {
  db.prepare("DELETE FROM book_authors WHERE book_id = ? AND role = ?").run(bookId, role);
  uniqueValues(names).forEach((name, index) => {
    const author = upsertAuthor(libraryId, name);
    db.prepare("INSERT INTO book_authors (book_id, author_id, role, sort_order) VALUES (?, ?, ?, ?)")
      .run(bookId, author.id, role, index);
  });
}

export function upsertSeries(libraryId: string, name: string) {
  db.prepare("INSERT OR IGNORE INTO series (id, library_id, name, sort_name) VALUES (?, ?, ?, ?)")
    .run(nanoid(16), libraryId, name, sortTitle(name));
  return db.prepare("SELECT id FROM series WHERE library_id = ? AND name = ?").get(libraryId, name) as { id: string };
}

export interface CategoryRow {
  id: string;
  key: string;
  name: string;
  icon: string | null;
  image_storage_key: string | null;
}

export function categoryImageUrl(imageStorageKey: string | null) {
  if (isBuiltinCategoryImageKey(imageStorageKey)) {
    return builtinCategoryImageUrl(imageStorageKey);
  }
  return imageStorageKey ? `/api/library/covers/${imageStorageKey}` : null;
}

export function categoryPayload(categoryId: string | null) {
  if (!categoryId) {
    return null;
  }
  const row = db.prepare("SELECT id, key, name, icon, image_storage_key FROM categories WHERE id = ?").get(categoryId) as CategoryRow | undefined;
  return row ? { key: row.key, name: row.name, icon: row.icon, imageUrl: categoryImageUrl(row.image_storage_key) } : null;
}

export function bookTags(bookId: string): string[] {
  const rows = db.prepare(`
    SELECT tags.display_name AS name
    FROM taggables
    JOIN tags ON tags.id = taggables.tag_id
    WHERE taggables.entity_type = 'book' AND taggables.entity_id = ?
    ORDER BY tags.display_name COLLATE NOCASE
  `).all(bookId) as { name: string }[];
  return rows.map((r) => r.name);
}

export const MAX_COVER_BYTES = 10 * 1024 * 1024;
export const COVER_FETCH_TIMEOUT_MS = 10_000;

export function isBlockedAddress(address: string) {
  // Block loopback, link-local, and private ranges to prevent SSRF into the
  // local network or cloud metadata endpoints (e.g. 169.254.169.254).
  const v4 = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }

  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fe80") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("::ffff:")) return isBlockedAddress(normalized.slice(7));
  return false;
}

export async function downloadCover(url: string) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Unsupported cover URL.");
  }

  const { address } = await dns.lookup(parsed.hostname);
  if (isBlockedAddress(address)) {
    throw new Error("Cover URL resolves to a disallowed address.");
  }

  const response = await fetch(parsed, {
    redirect: "error",
    signal: AbortSignal.timeout(COVER_FETCH_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error("Unable to download cover.");
  }

  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > MAX_COVER_BYTES) {
    throw new Error("Cover image is too large.");
  }

  // Enforce the cap while reading — Content-Length may be absent or untruthful.
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of streamFromResponse(response)) {
    total += chunk.byteLength;
    if (total > MAX_COVER_BYTES) {
      throw new Error("Cover image is too large.");
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

export async function* streamFromResponse(response: Response): AsyncGenerator<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > 0) yield buffer;
    return;
  }
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) yield value;
  }
}

export const coverImageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export function imageMimeType(filePath: string) {
  return {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp"
  }[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function getBookCoverFolder(bookId: string) {
  const row = db.prepare(`
    SELECT books.folder_path, libraries.source_path
    FROM books
    JOIN libraries ON libraries.id = books.library_id
    WHERE books.id = ?
      AND books.deleted_at IS NULL
  `).get(bookId) as { folder_path: string; source_path: string } | undefined;

  if (!row) {
    return null;
  }

  const folderPath = path.resolve(row.source_path, ...row.folder_path.split("/"));
  if (!pathIsInside(folderPath, row.source_path) || !fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    return null;
  }

  return { sourcePath: row.source_path, folderPath };
}

export function coverFilePathFromRelative(bookId: string, relativePath: string) {
  const context = getBookCoverFolder(bookId);
  if (!context) {
    return null;
  }

  const candidate = path.resolve(context.folderPath, ...relativePath.split("/"));
  if (!pathIsInside(candidate, context.folderPath) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    return null;
  }

  if (!coverImageExtensions.has(path.extname(candidate).toLowerCase())) {
    return null;
  }

  return candidate;
}

export function updateBookCover(bookId: string, coverStorageKey: string) {
  const updated = db.prepare(`
    UPDATE book_metadata
    SET source = 'manual',
      cover_storage_key = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE book_id = ?
  `).run(coverStorageKey, bookId);

  if (updated.changes === 0) {
    db.prepare(`
      INSERT INTO book_metadata (id, book_id, source, cover_storage_key)
      VALUES (?, ?, 'manual', ?)
    `).run(nanoid(16), bookId, coverStorageKey);
  }

  return getAudiobookBookDetail(bookId);
}

export function getBookForMetadata(bookId: string) {
  return db.prepare(`
    SELECT
      books.id,
      books.library_id,
      book_metadata.title,
      book_metadata.description,
      book_metadata.year_published,
      book_metadata.language,
      book_metadata.cover_storage_key,
      book_metadata.isbn,
      book_metadata.asin,
      book_metadata.publisher,
      book_metadata.category_id,
      GROUP_CONCAT(DISTINCT authors.name) AS author_names,
      GROUP_CONCAT(DISTINCT narrators.name) AS narrator_names
    FROM books
    LEFT JOIN book_metadata ON book_metadata.book_id = books.id
    LEFT JOIN book_authors ON book_authors.book_id = books.id AND book_authors.role = 'author'
    LEFT JOIN authors ON authors.id = book_authors.author_id
    LEFT JOIN book_authors AS book_narrators ON book_narrators.book_id = books.id AND book_narrators.role = 'narrator'
    LEFT JOIN authors AS narrators ON narrators.id = book_narrators.author_id
    WHERE books.id = ?
      AND books.deleted_at IS NULL
    GROUP BY books.id
  `).get(bookId) as {
    id: string;
    library_id: string;
    title: string | null;
    description: string | null;
    year_published: number | null;
    language: string | null;
    cover_storage_key: string | null;
    isbn: string | null;
    asin: string | null;
    publisher: string | null;
    category_id: string | null;
    author_names: string | null;
    narrator_names: string | null;
  } | undefined;
}

export function exportBookMetadata(bookId: string) {
  const book = getBookForMetadata(bookId);
  if (!book) {
    return;
  }

  try {
    writeMetadataExport(bookId, {
      title: book.title,
      authors: splitGroupConcat(book.author_names),
      narrators: splitGroupConcat(book.narrator_names),
      genres: bookTags(book.id),
      publisher: book.publisher,
      year: book.year_published,
      description: book.description,
      language: book.language,
      isbn: book.isbn,
      asin: book.asin
    });
  } catch {
    // export is best-effort; never fail a save because of it
  }
}

export async function applyMetadataCandidate(bookId: string, candidate: MetadataCandidate, updateDetails: boolean, updateCover: boolean) {
  const current = getBookForMetadata(bookId);
  if (!current) {
    return null;
  }

  let coverStorageKey = current.cover_storage_key;
  if (updateCover && candidate.coverUrl) {
    const cover = await downloadCover(candidate.coverUrl);
    coverStorageKey = await writeCoverImages(current.library_id, bookId, cover);
  }

  const next = {
    title: updateDetails || !current.title ? candidate.title : current.title,
    description: updateDetails || !current.description ? candidate.description ?? current.description : current.description,
    yearPublished: updateDetails || !current.year_published ? candidate.year ?? current.year_published : current.year_published,
    language: updateDetails || !current.language ? candidate.language ?? current.language : current.language,
    isbn: updateDetails || !current.isbn ? candidate.isbn ?? current.isbn : current.isbn,
    asin: updateDetails || !current.asin ? candidate.asin ?? current.asin : current.asin,
    publisher: updateDetails || !current.publisher ? candidate.publisher ?? current.publisher : current.publisher
  };

  db.transaction(() => {
    db.prepare(`
      INSERT INTO book_metadata (
        id, book_id, source, title, sort_title, description, year_published, language,
        duration_seconds, cover_storage_key, isbn, asin, publisher
      )
      SELECT lower(hex(randomblob(8))), ?, 'manual', ?, ?, ?, ?, ?, duration_seconds, ?, ?, ?, ?
      FROM book_metadata
      WHERE book_id = ?
      ON CONFLICT(book_id) DO UPDATE SET
        source = 'manual',
        title = excluded.title,
        sort_title = excluded.sort_title,
        description = excluded.description,
        year_published = excluded.year_published,
        language = excluded.language,
        cover_storage_key = excluded.cover_storage_key,
        isbn = excluded.isbn,
        asin = excluded.asin,
        publisher = excluded.publisher,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      bookId,
      next.title,
      sortTitle(next.title),
      next.description,
      next.yearPublished,
      next.language,
      coverStorageKey,
      next.isbn,
      next.asin,
      next.publisher,
      bookId
    );

    if (updateDetails || splitGroupConcat(current.author_names).length === 0) {
      replaceBookPeople(bookId, current.library_id, "author", candidate.authors);
    }
    if (candidate.narrators && (updateDetails || splitGroupConcat(current.narrator_names).length === 0)) {
      replaceBookPeople(bookId, current.library_id, "narrator", candidate.narrators);
    }
    if (candidate.genres && (updateDetails || bookTags(current.id).length === 0)) {
      addEntityTags("book", bookId, candidate.genres);
    }
  })();

  exportBookMetadata(bookId);
  return getAudiobookBookDetail(bookId);
}

export function updateManualMetadata(bookId: string, metadata: z.infer<typeof manualMetadataSchema>) {
  const current = getBookForMetadata(bookId);
  if (!current) {
    return null;
  }

  db.transaction(() => {
    const categoryId = metadata.categoryKey
      ? (db.prepare("SELECT id FROM categories WHERE key = ?").get(metadata.categoryKey) as { id: string } | undefined)?.id ?? null
      : null;
    db.prepare(`
      INSERT INTO book_metadata (
        id, book_id, source, title, sort_title, description, year_published, language,
        duration_seconds, cover_storage_key, isbn, asin, publisher, category_id
      )
      SELECT lower(hex(randomblob(8))), ?, 'manual', ?, ?, ?, ?, ?, duration_seconds, cover_storage_key, ?, ?, ?, ?
      FROM book_metadata
      WHERE book_id = ?
      ON CONFLICT(book_id) DO UPDATE SET
        source = 'manual',
        title = excluded.title,
        sort_title = excluded.sort_title,
        description = excluded.description,
        year_published = excluded.year_published,
        language = excluded.language,
        isbn = excluded.isbn,
        asin = excluded.asin,
        publisher = excluded.publisher,
        category_id = excluded.category_id,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      bookId,
      metadata.title,
      sortTitle(metadata.title),
      metadata.description ?? null,
      metadata.yearPublished ?? null,
      metadata.language ?? null,
      metadata.isbn ?? null,
      metadata.asin ?? null,
      metadata.publisher ?? null,
      categoryId,
      bookId
    );

    replaceBookPeople(bookId, current.library_id, "author", metadata.authors);
    replaceBookPeople(bookId, current.library_id, "narrator", metadata.narrators);
    setEntityTags("book", bookId, metadata.tags);
  })();

  if (metadata.series) {
    const series = upsertSeries(current.library_id, metadata.series);
    db.prepare("UPDATE books SET series_id = ?, series_position = ? WHERE id = ?")
      .run(series.id, metadata.seriesPosition ?? null, bookId);
  } else {
    db.prepare("UPDATE books SET series_id = NULL, series_position = NULL WHERE id = ?").run(bookId);
  }

  exportBookMetadata(bookId);
  return getAudiobookBookDetail(bookId);
}

// Bulk overwrite of shared metadata across many selected books. Only the fields
// present in the payload are written; an absent field leaves each book untouched.
// Tags replace the book's existing tags. Author/narrator accept a comma-separated
// list. Touched books are flipped to source='manual' like a single-book edit.
export const bulkMetadataSchema = z.object({
  bookIds: z.array(z.string().trim().min(1)).min(1).max(1000),
  authors: z.array(z.string().trim().min(1).max(160)).max(50).optional(),
  narrators: z.array(z.string().trim().min(1).max(160)).max(50).optional(),
  categoryKey: z.string().trim().min(1).max(64).optional(),
  language: z.string().trim().min(1).max(24).optional(),
  description: z.string().trim().max(20000).optional(),
  tags: z.array(z.string().trim().min(1).max(120)).max(50).optional()
});

export const BULK_METADATA_FIELDS = ["authors", "narrators", "categoryKey", "language", "description", "tags"] as const;

export function applyBulkMetadata(bookId: string, patch: z.infer<typeof bulkMetadataSchema>): boolean {
  const current = getBookForMetadata(bookId);
  if (!current) {
    return false;
  }

  db.transaction(() => {
    // Ensure a metadata row exists so the column updates have somewhere to land.
    const hasRow = db.prepare("SELECT 1 FROM book_metadata WHERE book_id = ?").get(bookId);
    if (!hasRow) {
      db.prepare("INSERT INTO book_metadata (id, book_id, source) VALUES (?, ?, 'manual')").run(nanoid(16), bookId);
    }

    const sets = ["source = 'manual'", "updated_at = CURRENT_TIMESTAMP"];
    const args: unknown[] = [];
    if (patch.description !== undefined) { sets.push("description = ?"); args.push(patch.description || null); }
    if (patch.language !== undefined) { sets.push("language = ?"); args.push(patch.language || null); }
    if (patch.categoryKey !== undefined) {
      const categoryId = (db.prepare("SELECT id FROM categories WHERE key = ?").get(patch.categoryKey) as { id: string } | undefined)?.id ?? null;
      sets.push("category_id = ?");
      args.push(categoryId);
    }
    db.prepare(`UPDATE book_metadata SET ${sets.join(", ")} WHERE book_id = ?`).run(...args, bookId);

    if (patch.authors !== undefined) {
      replaceBookPeople(bookId, current.library_id, "author", patch.authors);
    }
    if (patch.narrators !== undefined) {
      replaceBookPeople(bookId, current.library_id, "narrator", patch.narrators);
    }
    if (patch.tags !== undefined) {
      setEntityTags("book", bookId, patch.tags);
    }
  })();

  exportBookMetadata(bookId);
  return true;
}

export function getAudiobookBookDetail(id: string) {
  const book = db.prepare(`
    SELECT
      books.id,
      books.library_id,
      books.folder_path,
      books.status,
      books.discovered_at,
      books.updated_at,
      books.deleted_at,
      books.series_position,
      libraries.name AS library_name,
      series.name AS series_name,
      series.id AS series_id,
      book_metadata.title,
      book_metadata.sort_title,
      book_metadata.description,
      book_metadata.year_published,
      book_metadata.language,
      book_metadata.duration_seconds,
      book_metadata.cover_storage_key,
      book_metadata.source AS metadata_source,
      book_metadata.isbn,
      book_metadata.asin,
      book_metadata.publisher,
      book_metadata.openlibrary_id,
      book_metadata.category_id,
      GROUP_CONCAT(DISTINCT authors.name) AS author_names,
      GROUP_CONCAT(DISTINCT narrators.name) AS narrator_names,
      (
        SELECT COALESCE(SUM(book_files.size), 0)
        FROM book_files
        WHERE book_files.book_id = books.id
          AND book_files.status = 'available'
      ) AS total_size
    FROM books
    JOIN libraries ON libraries.id = books.library_id
    LEFT JOIN series ON series.id = books.series_id
    LEFT JOIN book_metadata ON book_metadata.book_id = books.id
    LEFT JOIN book_authors ON book_authors.book_id = books.id AND book_authors.role = 'author'
    LEFT JOIN authors ON authors.id = book_authors.author_id
    LEFT JOIN book_authors AS book_narrators ON book_narrators.book_id = books.id AND book_narrators.role = 'narrator'
    LEFT JOIN authors AS narrators ON narrators.id = book_narrators.author_id
    WHERE books.id = ?
      AND books.deleted_at IS NULL
    GROUP BY books.id
  `).get(id) as (AudiobookBookRow & {
    library_name: string;
    series_name: string | null;
    series_id: string | null;
    series_position: number | null;
    description: string | null;
    year_published: number | null;
    isbn: string | null;
    asin: string | null;
    publisher: string | null;
    openlibrary_id: string | null;
    category_id: string | null;
    narrator_names: string | null;
    metadata_source: "scan" | "manual";
  }) | undefined;

  if (!book) {
    return null;
  }

  const files = db.prepare(`
    SELECT id, relative_path, mime_type, track_number, chapter_title, duration_seconds, size, modified_at, status
    FROM book_files
    WHERE book_id = ?
    ORDER BY track_number, relative_path COLLATE NOCASE
  `).all(id) as BookFileRow[];

  const documents = db.prepare(`
    SELECT id, relative_path, format, mime_type, size
    FROM book_documents
    WHERE book_id = ? AND status = 'available'
    ORDER BY relative_path COLLATE NOCASE
  `).all(id) as { id: string; relative_path: string; format: string; mime_type: string | null; size: number | null }[];

  return {
    id: book.id,
    libraryId: book.library_id,
    libraryName: book.library_name,
    folderPath: book.folder_path,
    status: book.status,
    title: book.title ?? path.basename(book.folder_path),
    sortTitle: book.sort_title,
    series: book.series_name ?? null,
    seriesId: book.series_id ?? null,
    seriesPosition: book.series_position ?? null,
    description: book.description,
    yearPublished: book.year_published,
    language: book.language,
    authors: splitGroupConcat(book.author_names),
    narrators: splitGroupConcat(book.narrator_names),
    category: categoryPayload(book.category_id),
    tags: bookTags(book.id),
    totalSize: book.total_size ?? 0,
    durationSeconds: book.duration_seconds,
    coverUrl: book.cover_storage_key ? `/api/library/covers/${book.cover_storage_key}` : null,
    coverLargeUrl: largeCoverUrl(book.cover_storage_key),
    isbn: book.isbn,
    asin: book.asin,
    publisher: book.publisher,
    openLibraryId: book.openlibrary_id,
    metadataSource: book.metadata_source ?? "scan",
    discoveredAt: book.discovered_at,
    updatedAt: book.updated_at,
    files: files.map((file) => ({
      id: file.id,
      relativePath: file.relative_path,
      mimeType: file.mime_type,
      trackNumber: file.track_number,
      chapterTitle: file.chapter_title,
      durationSeconds: file.duration_seconds,
      size: file.size ?? 0,
      modifiedAt: file.modified_at,
      status: file.status
    })),
    documents: documents.map((doc) => ({
      id: doc.id,
      fileName: doc.relative_path.split("/").pop() ?? doc.relative_path,
      format: doc.format,
      mimeType: doc.mime_type,
      size: doc.size ?? 0,
      url: `/api/library/books/${book.id}/documents/${doc.id}`
    }))
  };
}

// ── Shared list/catalog row shape ───────────────────────────────────────────
// Columns + joins shared by the per-library list route and the paged catalog
// query, so both return an identical book shape. The trailing playback_progress
// and book_saves joins each bind the user id — they are the FIRST TWO positional
// ? in any query using these joins (pass the user id twice, in this order).
export const BOOK_LIST_COLUMNS = `
        books.id,
        books.library_id,
        books.folder_path,
        books.status,
        books.discovered_at,
        books.updated_at,
        books.deleted_at,
        books.series_position,
        series.name AS series_name,
        book_metadata.title,
        book_metadata.sort_title,
        book_metadata.language,
        book_metadata.duration_seconds,
        book_metadata.cover_storage_key,
        book_metadata.publisher,
        book_metadata.asin,
        book_metadata.category_id,
        GROUP_CONCAT(DISTINCT authors.name) AS author_names,
        GROUP_CONCAT(DISTINCT narrators.name) AS narrator_names,
        progress.percent_complete AS progress_percent,
        progress.completed_at AS progress_completed_at,
        (book_saves.id IS NOT NULL) AS saved,
        (SELECT COUNT(*) FROM book_files WHERE book_files.book_id = books.id AND book_files.status = 'available') AS file_count,
        (SELECT COALESCE(SUM(book_files.size), 0) FROM book_files WHERE book_files.book_id = books.id AND book_files.status = 'available') AS total_size`;

export const BOOK_LIST_JOINS = `
      FROM books
      LEFT JOIN series ON series.id = books.series_id
      LEFT JOIN book_metadata ON book_metadata.book_id = books.id
      LEFT JOIN book_authors ON book_authors.book_id = books.id AND book_authors.role = 'author'
      LEFT JOIN authors ON authors.id = book_authors.author_id
      LEFT JOIN book_authors AS book_narrators ON book_narrators.book_id = books.id AND book_narrators.role = 'narrator'
      LEFT JOIN authors AS narrators ON narrators.id = book_narrators.author_id
      LEFT JOIN playback_progress AS progress ON progress.book_id = books.id AND progress.user_id = ?
      LEFT JOIN book_saves ON book_saves.book_id = books.id AND book_saves.user_id = ?`;

export type BookListRow = AudiobookBookRow & {
  series_name: string | null;
  series_position: number | null;
  category_id: string | null;
  progress_percent: number | null;
  progress_completed_at: string | null;
  saved: number;
};

export function mapBookListRow(book: BookListRow) {
  return {
    id: book.id,
    libraryId: book.library_id,
    folderPath: book.folder_path,
    status: book.status,
    title: book.title ?? path.basename(book.folder_path),
    sortTitle: book.sort_title,
    series: book.series_name ?? null,
    seriesPosition: book.series_position ?? null,
    language: book.language,
    authors: splitGroupConcat(book.author_names),
    narrators: splitGroupConcat(book.narrator_names),
    category: categoryPayload(book.category_id),
    tags: bookTags(book.id),
    fileCount: book.file_count,
    totalSize: book.total_size ?? 0,
    durationSeconds: book.duration_seconds,
    coverUrl: book.cover_storage_key ? `/api/library/covers/${book.cover_storage_key}` : null,
    coverLargeUrl: largeCoverUrl(book.cover_storage_key),
    publisher: book.publisher,
    asin: book.asin,
    progress: {
      percentComplete: book.progress_percent,
      completedAt: book.progress_completed_at
    },
    saved: Boolean(book.saved),
    discoveredAt: book.discovered_at,
    updatedAt: book.updated_at
  };
}
