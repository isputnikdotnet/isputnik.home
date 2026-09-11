import { nanoid } from "nanoid";
import { db } from "../../../../db.js";
import { applyItemAlphaIndex } from "../../shared/alphabet-index.js";
import { matchCategoryId, setEntityTags } from "../../shared/tagging.js";
import { sortTitle } from "./folder-parse.js";
import type { PreparedBookScan } from "./types.js";

// Map a scanned name through the merge alias table so renamed/merged people stay
// merged across rescans (e.g. "A.G. Riddle" -> "A. G. Riddle").
function resolvePersonName(name: string): string {
  const row = db.prepare("SELECT canonical_name FROM person_aliases WHERE alias = ?")
    .get(name.trim()) as { canonical_name: string } | undefined;
  return row ? row.canonical_name : name;
}

function upsertAuthor(libraryId: string, name: string) {
  void libraryId; // people are global now
  const resolved = resolvePersonName(name);
  db.prepare("INSERT OR IGNORE INTO people (id, name, sort_name) VALUES (?, ?, ?)")
    .run(nanoid(16), resolved, sortTitle(resolved));
  return db.prepare("SELECT id FROM people WHERE name = ?")
    .get(resolved) as { id: string };
}


function upsertSeries(libraryId: string, name: string) {
  db.prepare("INSERT OR IGNORE INTO series (id, library_id, name, sort_name) VALUES (?, ?, ?, ?)")
    .run(nanoid(16), libraryId, name, sortTitle(name));
  return db.prepare("SELECT id FROM series WHERE library_id = ? AND name = ?")
    .get(libraryId, name) as { id: string };
}

export function writeBookScan(libraryId: string, book: PreparedBookScan) {
  const existingBook = db.prepare("SELECT id FROM library_items WHERE id = ?").get(book.bookId);

  if (existingBook) {
    db.prepare(`
      UPDATE library_items
      SET status = 'ready', scan_rule_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_at = NULL
      WHERE id = ?
    `).run(book.scanRuleId, book.bookId);
  } else {
    db.prepare(`
      INSERT INTO library_items (id, library_id, type, folder_path, status, scan_rule_id)
      VALUES (?, ?, 'audiobook', ?, 'ready', ?)
    `).run(book.bookId, libraryId, book.folderPath, book.scanRuleId);
  }

  // Manual ownership is read from the live row, not the caller's flag, so a book
  // the user has edited is never clobbered by a rescan (and stays consistent with
  // the per-field manual preservation in the item_metadata upsert below).
  const metaIsManual = (db.prepare("SELECT source FROM item_metadata WHERE item_id = ?")
    .get(book.bookId) as { source?: string } | undefined)?.source === "manual";

  if (!book.skipMetadataUpdate) {
    // Shared descriptive metadata; manual edits are preserved field-by-field.
    db.prepare(`
      INSERT INTO item_metadata (
        item_id, source, title, sort_title, description, year_published, language,
        cover_storage_key, isbn, publisher
      )
      VALUES (?, 'scan', ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        title = CASE WHEN item_metadata.source = 'manual' THEN item_metadata.title ELSE excluded.title END,
        sort_title = CASE WHEN item_metadata.source = 'manual' THEN item_metadata.sort_title ELSE excluded.sort_title END,
        description = CASE WHEN item_metadata.source = 'manual' THEN item_metadata.description ELSE excluded.description END,
        year_published = CASE WHEN item_metadata.source = 'manual' THEN item_metadata.year_published ELSE excluded.year_published END,
        language = CASE WHEN item_metadata.source = 'manual' THEN item_metadata.language ELSE excluded.language END,
        cover_storage_key = CASE
          WHEN item_metadata.source = 'manual' THEN item_metadata.cover_storage_key
          ELSE COALESCE(excluded.cover_storage_key, item_metadata.cover_storage_key)
        END,
        isbn = CASE WHEN item_metadata.source = 'manual' THEN item_metadata.isbn ELSE excluded.isbn END,
        publisher = CASE WHEN item_metadata.source = 'manual' THEN item_metadata.publisher ELSE excluded.publisher END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(
      book.bookId,
      book.title,
      book.sortTitle,
      book.description,
      book.yearPublished,
      book.language,
      book.coverStorageKey,
      book.isbn,
      book.publisher
    );

    // Whatever title survived that upsert (scanned or manually owned) decides the
    // A–Z bucket, so the index is re-derived from the stored row, not from
    // book.sortTitle.
    applyItemAlphaIndex(book.bookId);

    // Audiobook-specific: duration always refreshes; asin is preserved on manual.
    db.prepare(`
      INSERT INTO audiobook_details (item_id, asin, duration_seconds)
      VALUES (?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        duration_seconds = excluded.duration_seconds,
        asin = CASE WHEN ? = 1 THEN audiobook_details.asin ELSE excluded.asin END
    `).run(book.bookId, book.asin, book.durationSeconds, metaIsManual ? 1 : 0);

    // Primary category from the scanned genres — left alone when metadata is manual.
    if (!metaIsManual) {
      const categoryId = matchCategoryId(book.genres);
      db.prepare("DELETE FROM item_categories WHERE item_id = ? AND is_primary = 1").run(book.bookId);
      db.prepare(`
        INSERT INTO item_categories (item_id, category_id, is_primary, source) VALUES (?, ?, 1, 'scan')
        ON CONFLICT(item_id, category_id) DO UPDATE SET is_primary = 1, source = 'scan'
      `).run(book.bookId, categoryId);
    }
  }

  if (!metaIsManual && !book.skipMetadataUpdate) {
    // Series is auto-managed only when the user hasn't curated it by hand
    // (library_items.series_source = 'manual'). A manually pinned/cleared series
    // survives rescans even when the folder/tags carry one of their own.
    const seriesRow = db.prepare("SELECT series_source FROM library_items WHERE id = ?")
      .get(book.bookId) as { series_source: string } | undefined;
    if (seriesRow?.series_source !== "manual") {
      db.prepare("DELETE FROM series_items WHERE item_id = ?").run(book.bookId);
      if (book.seriesName) {
        const series = upsertSeries(libraryId, book.seriesName);
        db.prepare("INSERT INTO series_items (series_id, item_id, position, source) VALUES (?, ?, ?, 'scan')")
          .run(series.id, book.bookId, book.seriesPosition);
      }
    }

    db.prepare("DELETE FROM item_people WHERE item_id = ? AND role IN ('author', 'narrator')").run(book.bookId);
    book.authors.forEach((authorName, index) => {
      const author = upsertAuthor(libraryId, authorName);
      db.prepare(`
        INSERT OR IGNORE INTO item_people (item_id, person_id, role, sort_order)
        VALUES (?, ?, 'author', ?)
      `).run(book.bookId, author.id, index);
    });
    book.narrators.forEach((narratorName, index) => {
      const narrator = upsertAuthor(libraryId, narratorName);
      db.prepare(`
        INSERT OR IGNORE INTO item_people (item_id, person_id, role, sort_order)
        VALUES (?, ?, 'narrator', ?)
      `).run(book.bookId, narrator.id, index);
    });

    // Raw genres become global, freeform tags (the descriptive layer); the primary
    // category is derived from them above.
    setEntityTags("library_item", book.bookId, book.genres);
  }

  db.prepare("UPDATE audio_files SET status = 'missing', deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_id = ?").run(book.bookId);
  for (const file of book.files) {
    db.prepare(`
      INSERT INTO audio_files (
        id, item_id, relative_path, mime_type, track_number, title, duration_seconds,
        size, modified_at, content_hash, status, deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', NULL)
      ON CONFLICT(item_id, relative_path) DO UPDATE SET
        mime_type = excluded.mime_type,
        track_number = excluded.track_number,
        title = excluded.title,
        duration_seconds = excluded.duration_seconds,
        size = excluded.size,
        modified_at = excluded.modified_at,
        content_hash = excluded.content_hash,
        status = 'available',
        deleted_at = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(
      nanoid(16),
      book.bookId,
      file.relativePath,
      file.mimeType,
      file.trackNumber,
      file.chapterTitle,
      file.durationSeconds,
      file.size,
      file.modifiedAt,
      file.contentHash
    );

    // Re-sync embedded chapters for this file. undefined = not re-parsed this scan
    // (fast path), so existing rows are left intact; otherwise replace them wholesale.
    if (file.chapters !== undefined) {
      const fileRow = db.prepare("SELECT id FROM audio_files WHERE item_id = ? AND relative_path = ?")
        .get(book.bookId, file.relativePath) as { id: string } | undefined;
      if (fileRow) {
        db.prepare("DELETE FROM audio_chapters WHERE audio_file_id = ?").run(fileRow.id);
        file.chapters.forEach((chapter, ordinal) => {
          db.prepare(`
            INSERT INTO audio_chapters (id, audio_file_id, ordinal, title, start_seconds, end_seconds)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(nanoid(16), fileRow.id, ordinal, chapter.title, chapter.startSeconds, chapter.endSeconds);
        });
      }
    }
  }

  // Companion documents — re-synced from disk on every scan, like audio_files.
  db.prepare("UPDATE document_files SET status = 'missing', deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_id = ? AND role = 'companion'").run(book.bookId);
  for (const doc of book.documents) {
    db.prepare(`
      INSERT INTO document_files (id, item_id, role, relative_path, format, mime_type, size, status, deleted_at)
      VALUES (?, ?, 'companion', ?, ?, ?, ?, 'available', NULL)
      ON CONFLICT(item_id, relative_path) DO UPDATE SET
        role = 'companion',
        format = excluded.format,
        mime_type = excluded.mime_type,
        size = excluded.size,
        status = 'available',
        deleted_at = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(nanoid(16), book.bookId, doc.relativePath, doc.format, doc.mimeType, doc.size);
  }
}
