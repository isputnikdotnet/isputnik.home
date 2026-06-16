import fs from "node:fs";
import path from "node:path";
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
import { normalizeLibrarySettings } from "../shared/library-settings.js";
import { downloadImage } from "../shared/remote-image.js";

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

const metadataCandidateSchema = z.object({
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
  source: z.enum(["itunes", "openlibrary", "fantlab", "librivox", "audible"])
});

export const metadataMatchSchema = z.object({
  candidate: metadataCandidateSchema,
  updateDetails: z.boolean().default(true),
  updateCover: z.boolean().default(true)
});

export const coverSourceSchema = z.object({
  relativePath: z.string().trim().min(1).max(1000)
});

export const coverFromUrlSchema = z.object({
  url: z.string().trim().url().max(2000)
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

function uniqueValues(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

// People and series are global (cross-library). The libraryId arg is retained for
// call-site compatibility but no longer scopes uniqueness.
export function upsertAuthor(libraryId: string, name: string) {
  void libraryId;
  db.prepare("INSERT OR IGNORE INTO people (id, name, sort_name) VALUES (?, ?, ?)")
    .run(nanoid(16), name, sortTitle(name));
  return db.prepare("SELECT id FROM people WHERE name = ?").get(name) as { id: string };
}

function replaceBookPeople(bookId: string, libraryId: string, role: "author" | "narrator", names: string[]) {
  db.prepare("DELETE FROM item_people WHERE item_id = ? AND role = ?").run(bookId, role);
  uniqueValues(names).forEach((name, index) => {
    const person = upsertAuthor(libraryId, name);
    db.prepare("INSERT OR IGNORE INTO item_people (item_id, person_id, role, sort_order) VALUES (?, ?, ?, ?)")
      .run(bookId, person.id, role, index);
  });
}

export function upsertSeries(libraryId: string, name: string) {
  void libraryId;
  db.prepare("INSERT OR IGNORE INTO series (id, name, sort_name) VALUES (?, ?, ?)")
    .run(nanoid(16), name, sortTitle(name));
  return db.prepare("SELECT id FROM series WHERE name = ?").get(name) as { id: string };
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
    WHERE taggables.entity_type = 'library_item' AND taggables.entity_id = ?
    ORDER BY tags.display_name COLLATE NOCASE
  `).all(bookId) as { name: string }[];
  return rows.map((r) => r.name);
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
    SELECT library_items.folder_path, libraries.source_path
    FROM library_items
    JOIN libraries ON libraries.id = library_items.library_id
    WHERE library_items.id = ?
      AND library_items.deleted_at IS NULL
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
    UPDATE item_metadata
    SET source = 'manual',
      cover_storage_key = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE item_id = ?
  `).run(coverStorageKey, bookId);

  if (updated.changes === 0) {
    db.prepare(`
      INSERT INTO item_metadata (item_id, source, cover_storage_key)
      VALUES (?, 'manual', ?)
    `).run(bookId, coverStorageKey);
  }

  return getAudiobookBookDetail(bookId);
}

function getBookForMetadata(bookId: string) {
  return db.prepare(`
    SELECT
      library_items.id,
      library_items.library_id,
      item_metadata.title,
      item_metadata.description,
      item_metadata.year_published,
      item_metadata.language,
      item_metadata.cover_storage_key,
      item_metadata.isbn,
      audiobook_details.asin,
      item_metadata.publisher,
      (SELECT ic.category_id FROM item_categories ic WHERE ic.item_id = library_items.id AND ic.is_primary = 1 LIMIT 1) AS category_id,
      GROUP_CONCAT(DISTINCT authors.name) AS author_names,
      GROUP_CONCAT(DISTINCT narrators.name) AS narrator_names
    FROM library_items
    LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
    LEFT JOIN audiobook_details ON audiobook_details.item_id = library_items.id
    LEFT JOIN item_people ON item_people.item_id = library_items.id AND item_people.role = 'author'
    LEFT JOIN people AS authors ON authors.id = item_people.person_id
    LEFT JOIN item_people AS narrator_people ON narrator_people.item_id = library_items.id AND narrator_people.role = 'narrator'
    LEFT JOIN people AS narrators ON narrators.id = narrator_people.person_id
    WHERE library_items.id = ?
      AND library_items.deleted_at IS NULL
    GROUP BY library_items.id
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

function exportBookMetadata(bookId: string) {
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
    const cover = await downloadImage(candidate.coverUrl);
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
      INSERT INTO item_metadata (
        item_id, source, title, sort_title, description, year_published, language,
        cover_storage_key, isbn, publisher
      )
      VALUES (?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        source = 'manual',
        title = excluded.title,
        sort_title = excluded.sort_title,
        description = excluded.description,
        year_published = excluded.year_published,
        language = excluded.language,
        cover_storage_key = excluded.cover_storage_key,
        isbn = excluded.isbn,
        publisher = excluded.publisher,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(
      bookId,
      next.title,
      sortTitle(next.title),
      next.description,
      next.yearPublished,
      next.language,
      coverStorageKey,
      next.isbn,
      next.publisher
    );
    db.prepare(`
      INSERT INTO audiobook_details (item_id, asin) VALUES (?, ?)
      ON CONFLICT(item_id) DO UPDATE SET asin = excluded.asin
    `).run(bookId, next.asin);

    if (updateDetails || splitGroupConcat(current.author_names).length === 0) {
      replaceBookPeople(bookId, current.library_id, "author", candidate.authors);
    }
    if (candidate.narrators && (updateDetails || splitGroupConcat(current.narrator_names).length === 0)) {
      replaceBookPeople(bookId, current.library_id, "narrator", candidate.narrators);
    }
    if (candidate.genres && (updateDetails || bookTags(current.id).length === 0)) {
      addEntityTags("library_item", bookId, candidate.genres);
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
      INSERT INTO item_metadata (
        item_id, source, title, sort_title, description, year_published, language,
        isbn, publisher
      )
      VALUES (?, 'manual', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        source = 'manual',
        title = excluded.title,
        sort_title = excluded.sort_title,
        description = excluded.description,
        year_published = excluded.year_published,
        language = excluded.language,
        isbn = excluded.isbn,
        publisher = excluded.publisher,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(
      bookId,
      metadata.title,
      sortTitle(metadata.title),
      metadata.description ?? null,
      metadata.yearPublished ?? null,
      metadata.language ?? null,
      metadata.isbn ?? null,
      metadata.publisher ?? null
    );
    db.prepare(`
      INSERT INTO audiobook_details (item_id, asin) VALUES (?, ?)
      ON CONFLICT(item_id) DO UPDATE SET asin = excluded.asin
    `).run(bookId, metadata.asin ?? null);

    // Primary category (manual): replace any existing primary.
    db.prepare("DELETE FROM item_categories WHERE item_id = ? AND is_primary = 1").run(bookId);
    if (categoryId) {
      db.prepare(`
        INSERT INTO item_categories (item_id, category_id, is_primary, source) VALUES (?, ?, 1, 'manual')
        ON CONFLICT(item_id, category_id) DO UPDATE SET is_primary = 1, source = 'manual'
      `).run(bookId, categoryId);
    }

    replaceBookPeople(bookId, current.library_id, "author", metadata.authors);
    replaceBookPeople(bookId, current.library_id, "narrator", metadata.narrators);
    setEntityTags("library_item", bookId, metadata.tags);

    // A book edited by hand owns its series too, so the scanner leaves it alone
    // (library_items.series_source = 'manual'). Clearing removes the membership.
    db.prepare("UPDATE library_items SET series_source = 'manual' WHERE id = ?").run(bookId);
    db.prepare("DELETE FROM series_items WHERE item_id = ?").run(bookId);
    if (metadata.series) {
      const series = upsertSeries(current.library_id, metadata.series);
      db.prepare("INSERT INTO series_items (series_id, item_id, position, source) VALUES (?, ?, ?, 'manual')")
        .run(series.id, bookId, metadata.seriesPosition ?? null);
    }
  })();

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
    const hasRow = db.prepare("SELECT 1 FROM item_metadata WHERE item_id = ?").get(bookId);
    if (!hasRow) {
      db.prepare("INSERT INTO item_metadata (item_id, source) VALUES (?, 'manual')").run(bookId);
    }

    const sets = ["source = 'manual'", "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')"];
    const args: unknown[] = [];
    if (patch.description !== undefined) { sets.push("description = ?"); args.push(patch.description || null); }
    if (patch.language !== undefined) { sets.push("language = ?"); args.push(patch.language || null); }
    db.prepare(`UPDATE item_metadata SET ${sets.join(", ")} WHERE item_id = ?`).run(...args, bookId);

    if (patch.categoryKey !== undefined) {
      const categoryId = (db.prepare("SELECT id FROM categories WHERE key = ?").get(patch.categoryKey) as { id: string } | undefined)?.id ?? null;
      db.prepare("DELETE FROM item_categories WHERE item_id = ? AND is_primary = 1").run(bookId);
      if (categoryId) {
        db.prepare("INSERT INTO item_categories (item_id, category_id, is_primary, source) VALUES (?, ?, 1, 'manual') ON CONFLICT(item_id, category_id) DO UPDATE SET is_primary = 1, source = 'manual'").run(bookId, categoryId);
      }
    }

    if (patch.authors !== undefined) {
      replaceBookPeople(bookId, current.library_id, "author", patch.authors);
    }
    if (patch.narrators !== undefined) {
      replaceBookPeople(bookId, current.library_id, "narrator", patch.narrators);
    }
    if (patch.tags !== undefined) {
      setEntityTags("library_item", bookId, patch.tags);
    }
  })();

  exportBookMetadata(bookId);
  return true;
}

export function getAudiobookBookDetail(id: string) {
  const book = db.prepare(`
    SELECT
      library_items.id,
      library_items.library_id,
      library_items.folder_path,
      library_items.status,
      library_items.discovered_at,
      library_items.updated_at,
      library_items.deleted_at,
      series_items.position AS series_position,
      libraries.name AS library_name,
      libraries.settings_json AS settings_json,
      series.name AS series_name,
      series.id AS series_id,
      item_metadata.title,
      item_metadata.sort_title,
      item_metadata.description,
      item_metadata.year_published,
      item_metadata.language,
      audiobook_details.duration_seconds,
      item_metadata.cover_storage_key,
      item_metadata.source AS metadata_source,
      item_metadata.isbn,
      audiobook_details.asin,
      item_metadata.publisher,
      item_metadata.openlibrary_id,
      (SELECT ic.category_id FROM item_categories ic WHERE ic.item_id = library_items.id AND ic.is_primary = 1 LIMIT 1) AS category_id,
      GROUP_CONCAT(DISTINCT authors.name) AS author_names,
      GROUP_CONCAT(DISTINCT narrators.name) AS narrator_names,
      (
        SELECT COALESCE(SUM(audio_files.size), 0)
        FROM audio_files
        WHERE audio_files.item_id = library_items.id
          AND audio_files.status = 'available'
      ) AS total_size
    FROM library_items
    JOIN libraries ON libraries.id = library_items.library_id
    LEFT JOIN series_items ON series_items.item_id = library_items.id
    LEFT JOIN series ON series.id = series_items.series_id
    LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
    LEFT JOIN audiobook_details ON audiobook_details.item_id = library_items.id
    LEFT JOIN item_people ON item_people.item_id = library_items.id AND item_people.role = 'author'
    LEFT JOIN people AS authors ON authors.id = item_people.person_id
    LEFT JOIN item_people AS narrator_people ON narrator_people.item_id = library_items.id AND narrator_people.role = 'narrator'
    LEFT JOIN people AS narrators ON narrators.id = narrator_people.person_id
    WHERE library_items.id = ?
      AND library_items.deleted_at IS NULL
    GROUP BY library_items.id
  `).get(id) as (AudiobookBookRow & {
    library_name: string;
    settings_json: string;
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
    SELECT id, relative_path, mime_type, track_number, title AS chapter_title, duration_seconds, size, modified_at, status
    FROM audio_files
    WHERE item_id = ?
    ORDER BY track_number, relative_path COLLATE NOCASE
  `).all(id) as BookFileRow[];

  // Embedded chapters (m4b / MP3 CHAP), grouped onto their owning file below. Most
  // books have none, in which case this is empty and files carry no `chapters`.
  const chapterRows = db.prepare(`
    SELECT audio_chapters.id, audio_chapters.audio_file_id, audio_chapters.title,
           audio_chapters.start_seconds, audio_chapters.end_seconds
    FROM audio_chapters
    JOIN audio_files ON audio_files.id = audio_chapters.audio_file_id
    WHERE audio_files.item_id = ?
    ORDER BY audio_chapters.audio_file_id, audio_chapters.ordinal
  `).all(id) as {
    id: string;
    audio_file_id: string;
    title: string;
    start_seconds: number;
    end_seconds: number | null;
  }[];
  const chaptersByFile = new Map<string, { id: string; title: string; startSeconds: number; endSeconds: number | null }[]>();
  for (const row of chapterRows) {
    const list = chaptersByFile.get(row.audio_file_id) ?? [];
    list.push({ id: row.id, title: row.title, startSeconds: row.start_seconds, endSeconds: row.end_seconds });
    chaptersByFile.set(row.audio_file_id, list);
  }

  const documents = db.prepare(`
    SELECT id, relative_path, format, mime_type, size
    FROM document_files
    WHERE item_id = ? AND status = 'available'
    ORDER BY relative_path COLLATE NOCASE
  `).all(id) as { id: string; relative_path: string; format: string; mime_type: string | null; size: number | null }[];

  return {
    id: book.id,
    libraryId: book.library_id,
    libraryName: book.library_name,
    progressMode: normalizeLibrarySettings("audiobook", book.settings_json).progress_mode === "episodic" ? "episodic" : "linear",
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
      status: file.status,
      chapters: chaptersByFile.get(file.id)
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
        library_items.id,
        library_items.library_id,
        library_items.folder_path,
        library_items.status,
        library_items.discovered_at,
        library_items.updated_at,
        library_items.deleted_at,
        series_items.position AS series_position,
        series.name AS series_name,
        item_metadata.title,
        item_metadata.sort_title,
        item_metadata.language,
        audiobook_details.duration_seconds,
        item_metadata.cover_storage_key,
        item_metadata.publisher,
        audiobook_details.asin,
        (SELECT ic.category_id FROM item_categories ic WHERE ic.item_id = library_items.id AND ic.is_primary = 1 LIMIT 1) AS category_id,
        GROUP_CONCAT(DISTINCT authors.name) AS author_names,
        GROUP_CONCAT(DISTINCT narrators.name) AS narrator_names,
        progress.percent_complete AS progress_percent,
        progress.completed_at AS progress_completed_at,
        (item_saves.id IS NOT NULL) AS saved,
        (SELECT COUNT(*) FROM audio_files WHERE audio_files.item_id = library_items.id AND audio_files.status = 'available') AS file_count,
        (SELECT COALESCE(SUM(audio_files.size), 0) FROM audio_files WHERE audio_files.item_id = library_items.id AND audio_files.status = 'available') AS total_size`;

export const BOOK_LIST_JOINS = `
      FROM library_items
      LEFT JOIN series_items ON series_items.item_id = library_items.id
      LEFT JOIN series ON series.id = series_items.series_id
      LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
      LEFT JOIN audiobook_details ON audiobook_details.item_id = library_items.id
      LEFT JOIN item_people ON item_people.item_id = library_items.id AND item_people.role = 'author'
      LEFT JOIN people AS authors ON authors.id = item_people.person_id
      LEFT JOIN item_people AS narrator_people ON narrator_people.item_id = library_items.id AND narrator_people.role = 'narrator'
      LEFT JOIN people AS narrators ON narrators.id = narrator_people.person_id
      LEFT JOIN playback_progress AS progress ON progress.item_id = library_items.id AND progress.user_id = ?
      LEFT JOIN item_saves ON item_saves.item_id = library_items.id AND item_saves.user_id = ?`;

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
