import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { searchAllMetadataProviders, searchMetadataProvider, type MetadataCandidate, type MetadataProvider } from "./providers/index.js";
import { rescanSingleBook, sortTitle, writeCoverImages } from "./scanner.js";
import { writeMetadataExport } from "../shared/metadata.js";
import { normaliseRelativePath, pathIsInside } from "../shared/storage-roots.js";
import type { AudiobookBookRow, BookFileRow } from "./types.js";

function largeCoverUrl(storageKey: string | null) {
  if (!storageKey) {
    return null;
  }

  return `/api/library/covers/${storageKey.replace(/-cover\.webp$/i, "-cover-large.webp")}`;
}

const progressUpdateSchema = z.object({
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
  source: z.enum(["itunes", "openlibrary", "fantlab"])
});

const metadataMatchSchema = z.object({
  candidate: metadataCandidateSchema,
  updateDetails: z.boolean().default(true),
  updateCover: z.boolean().default(true)
});

const coverSourceSchema = z.object({
  relativePath: z.string().trim().min(1).max(1000)
});

const manualMetadataSchema = z.object({
  title: z.string().trim().min(1).max(240),
  authors: z.array(z.string().trim().min(1).max(160)).default([]),
  narrators: z.array(z.string().trim().min(1).max(160)).default([]),
  genres: z.array(z.string().trim().min(1).max(120)).default([]),
  publisher: z.string().trim().max(240).nullable().optional(),
  yearPublished: z.number().int().min(0).max(3000).nullable().optional(),
  description: z.string().trim().max(20000).nullable().optional(),
  language: z.string().trim().max(24).nullable().optional(),
  isbn: z.string().trim().max(64).nullable().optional(),
  asin: z.string().trim().max(64).nullable().optional()
});

function splitGroupConcat(value: string | null) {
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function uniqueValues(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function upsertAuthor(libraryId: string, name: string) {
  db.prepare(`
    INSERT INTO authors (id, library_id, name, sort_name)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(library_id, name) DO NOTHING
  `).run(nanoid(16), libraryId, name, sortTitle(name));
  return db.prepare("SELECT id FROM authors WHERE library_id = ? AND name = ?").get(libraryId, name) as { id: string };
}

function replaceBookPeople(bookId: string, libraryId: string, role: "author" | "narrator", names: string[]) {
  db.prepare("DELETE FROM book_authors WHERE book_id = ? AND role = ?").run(bookId, role);
  uniqueValues(names).forEach((name, index) => {
    const author = upsertAuthor(libraryId, name);
    db.prepare(`
      INSERT INTO book_authors (book_id, author_id, role, sort_order)
      VALUES (?, ?, ?, ?)
    `).run(bookId, author.id, role, index);
  });
}

function upsertGenre(libraryId: string, name: string) {
  db.prepare(`
    INSERT INTO genres (id, library_id, name)
    VALUES (?, ?, ?)
    ON CONFLICT(library_id, name) DO NOTHING
  `).run(nanoid(16), libraryId, name);
  return db.prepare("SELECT id FROM genres WHERE library_id = ? AND name = ?").get(libraryId, name) as { id: string };
}

function mergeBookGenres(bookId: string, libraryId: string, names: string[]) {
  uniqueValues(names).forEach((name) => {
    const genre = upsertGenre(libraryId, name);
    db.prepare(`
      INSERT INTO book_genres (book_id, genre_id)
      VALUES (?, ?)
      ON CONFLICT(book_id, genre_id) DO NOTHING
    `).run(bookId, genre.id);
  });
}

function replaceBookGenres(bookId: string, libraryId: string, names: string[]) {
  db.prepare("DELETE FROM book_genres WHERE book_id = ?").run(bookId);
  mergeBookGenres(bookId, libraryId, names);
}

async function downloadCover(url: string) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Unsupported cover URL.");
  }

  const response = await fetch(parsed);
  if (!response.ok) {
    throw new Error("Unable to download cover.");
  }

  const size = Number(response.headers.get("content-length") ?? 0);
  if (size > 10 * 1024 * 1024) {
    throw new Error("Cover image is too large.");
  }

  return Buffer.from(await response.arrayBuffer());
}

const coverImageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function imageMimeType(filePath: string) {
  return {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp"
  }[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function getBookCoverFolder(bookId: string) {
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

function coverFilePathFromRelative(bookId: string, relativePath: string) {
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

function updateBookCover(bookId: string, coverStorageKey: string) {
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

function getBookForMetadata(bookId: string) {
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
      GROUP_CONCAT(DISTINCT authors.name) AS author_names,
      GROUP_CONCAT(DISTINCT narrators.name) AS narrator_names,
      GROUP_CONCAT(DISTINCT genres.name) AS genre_names
    FROM books
    LEFT JOIN book_metadata ON book_metadata.book_id = books.id
    LEFT JOIN book_authors ON book_authors.book_id = books.id AND book_authors.role = 'author'
    LEFT JOIN authors ON authors.id = book_authors.author_id
    LEFT JOIN book_authors AS book_narrators ON book_narrators.book_id = books.id AND book_narrators.role = 'narrator'
    LEFT JOIN authors AS narrators ON narrators.id = book_narrators.author_id
    LEFT JOIN book_genres ON book_genres.book_id = books.id
    LEFT JOIN genres ON genres.id = book_genres.genre_id
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
    author_names: string | null;
    narrator_names: string | null;
    genre_names: string | null;
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
      genres: splitGroupConcat(book.genre_names),
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

async function applyMetadataCandidate(bookId: string, candidate: MetadataCandidate, updateDetails: boolean, updateCover: boolean) {
  const current = getBookForMetadata(bookId);
  if (!current) {
    return null;
  }

  let coverStorageKey = current.cover_storage_key;
  if (updateCover && candidate.coverUrl) {
    const cover = await downloadCover(candidate.coverUrl);
    coverStorageKey = await writeCoverImages(bookId, cover);
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
    if (candidate.genres && (updateDetails || splitGroupConcat(current.genre_names).length === 0)) {
      mergeBookGenres(bookId, current.library_id, candidate.genres);
    }
  })();

  exportBookMetadata(bookId);
  return getAudiobookBookDetail(bookId);
}

function updateManualMetadata(bookId: string, metadata: z.infer<typeof manualMetadataSchema>) {
  const current = getBookForMetadata(bookId);
  if (!current) {
    return null;
  }

  db.transaction(() => {
    db.prepare(`
      INSERT INTO book_metadata (
        id, book_id, source, title, sort_title, description, year_published, language,
        duration_seconds, cover_storage_key, isbn, asin, publisher
      )
      SELECT lower(hex(randomblob(8))), ?, 'manual', ?, ?, ?, ?, ?, duration_seconds, cover_storage_key, ?, ?, ?
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
      bookId
    );

    replaceBookPeople(bookId, current.library_id, "author", metadata.authors);
    replaceBookPeople(bookId, current.library_id, "narrator", metadata.narrators);
    replaceBookGenres(bookId, current.library_id, metadata.genres);
  })();

  exportBookMetadata(bookId);
  return getAudiobookBookDetail(bookId);
}

function getAudiobookBookDetail(id: string) {
  const book = db.prepare(`
    SELECT
      books.id,
      books.library_id,
      books.folder_path,
      books.status,
      books.discovered_at,
      books.updated_at,
      books.deleted_at,
      libraries.name AS library_name,
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
      GROUP_CONCAT(DISTINCT authors.name) AS author_names,
      GROUP_CONCAT(DISTINCT narrators.name) AS narrator_names,
      GROUP_CONCAT(DISTINCT genres.name) AS genre_names,
      (
        SELECT COALESCE(SUM(book_files.size), 0)
        FROM book_files
        WHERE book_files.book_id = books.id
          AND book_files.status = 'available'
      ) AS total_size
    FROM books
    JOIN libraries ON libraries.id = books.library_id
    LEFT JOIN book_metadata ON book_metadata.book_id = books.id
    LEFT JOIN book_authors ON book_authors.book_id = books.id AND book_authors.role = 'author'
    LEFT JOIN authors ON authors.id = book_authors.author_id
    LEFT JOIN book_authors AS book_narrators ON book_narrators.book_id = books.id AND book_narrators.role = 'narrator'
    LEFT JOIN authors AS narrators ON narrators.id = book_narrators.author_id
    LEFT JOIN book_genres ON book_genres.book_id = books.id
    LEFT JOIN genres ON genres.id = book_genres.genre_id
    WHERE books.id = ?
      AND books.deleted_at IS NULL
    GROUP BY books.id
  `).get(id) as (AudiobookBookRow & {
    library_name: string;
    description: string | null;
    year_published: number | null;
    isbn: string | null;
    asin: string | null;
    publisher: string | null;
    openlibrary_id: string | null;
    narrator_names: string | null;
    genre_names: string | null;
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

  return {
    id: book.id,
    libraryId: book.library_id,
    libraryName: book.library_name,
    folderPath: book.folder_path,
    status: book.status,
    title: book.title ?? path.basename(book.folder_path),
    sortTitle: book.sort_title,
    description: book.description,
    yearPublished: book.year_published,
    language: book.language,
    authors: splitGroupConcat(book.author_names),
    narrators: splitGroupConcat(book.narrator_names),
    genres: splitGroupConcat(book.genre_names),
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
    }))
  };
}

export async function audiobookBooksPlugin(app: FastifyInstance) {
  app.addContentTypeParser(["image/jpeg", "image/png", "image/webp"], { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.get("/api/library/audiobook-libraries/:id/books", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const library = db.prepare("SELECT id FROM libraries WHERE id = ? AND type = 'audiobook'").get(id);
    if (!library) {
      reply.code(404).send({ error: "Audiobook library not found" });
      return;
    }

    const books = db.prepare(`
      SELECT
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
        book_metadata.duration_seconds,
        book_metadata.cover_storage_key,
        book_metadata.publisher,
        book_metadata.asin,
        GROUP_CONCAT(DISTINCT authors.name) AS author_names,
        GROUP_CONCAT(DISTINCT narrators.name) AS narrator_names,
        GROUP_CONCAT(DISTINCT genres.name) AS genre_names,
        (
          SELECT COUNT(*)
          FROM book_files
          WHERE book_files.book_id = books.id
            AND book_files.status = 'available'
        ) AS file_count,
        (
          SELECT COALESCE(SUM(book_files.size), 0)
          FROM book_files
          WHERE book_files.book_id = books.id
            AND book_files.status = 'available'
        ) AS total_size
      FROM books
      LEFT JOIN book_metadata ON book_metadata.book_id = books.id
      LEFT JOIN book_authors ON book_authors.book_id = books.id AND book_authors.role = 'author'
      LEFT JOIN authors ON authors.id = book_authors.author_id
      LEFT JOIN book_authors AS book_narrators ON book_narrators.book_id = books.id AND book_narrators.role = 'narrator'
      LEFT JOIN authors AS narrators ON narrators.id = book_narrators.author_id
      LEFT JOIN book_genres ON book_genres.book_id = books.id
      LEFT JOIN genres ON genres.id = book_genres.genre_id
      WHERE books.library_id = ?
        AND books.deleted_at IS NULL
      GROUP BY books.id
      ORDER BY COALESCE(book_metadata.sort_title, book_metadata.title, books.folder_path) COLLATE NOCASE
    `).all(id) as AudiobookBookRow[];

    return {
      books: books.map((book) => ({
        id: book.id,
        libraryId: book.library_id,
        folderPath: book.folder_path,
        status: book.status,
        title: book.title ?? path.basename(book.folder_path),
        sortTitle: book.sort_title,
        language: book.language,
        authors: splitGroupConcat(book.author_names),
        narrators: splitGroupConcat(book.narrator_names),
        genres: splitGroupConcat(book.genre_names),
        fileCount: book.file_count,
        totalSize: book.total_size ?? 0,
        durationSeconds: book.duration_seconds,
        coverUrl: book.cover_storage_key ? `/api/library/covers/${book.cover_storage_key}` : null,
        coverLargeUrl: largeCoverUrl(book.cover_storage_key),
        publisher: book.publisher,
        asin: book.asin,
        discoveredAt: book.discovered_at,
        updatedAt: book.updated_at
      }))
    };
  });

  app.get("/api/library/books/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const book = getAudiobookBookDetail(id);
    if (!book) {
      reply.code(404).send({ error: "Audiobook not found" });
      return;
    }

    reply.send({ book });
  });

  app.get("/api/library/books/:id/metadata-search", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const book = getAudiobookBookDetail(id);
    if (!book) {
      reply.code(404).send({ error: "Audiobook not found" });
      return;
    }

    const query = request.query as { q?: string; author?: string; provider?: string };
    const searchQuery = (query.q || book.title).trim();
    const author = query.author?.trim() ?? "";
    const provider = (query.provider || "all") as MetadataProvider | "all";
    if (!["all", "itunes", "openlibrary", "fantlab"].includes(provider)) {
      reply.code(400).send({ error: "Unsupported metadata provider" });
      return;
    }
    if (!searchQuery) {
      reply.code(400).send({ error: "Search query is required" });
      return;
    }

    const input = { query: searchQuery, author, limit: 8 };
    try {
      const candidates = provider === "all"
        ? await searchAllMetadataProviders(input)
        : await searchMetadataProvider(provider, input);
      reply.send({ candidates });
    } catch (err) {
      reply.code(502).send({ error: err instanceof Error ? err.message : "Metadata provider search failed" });
    }
  });

  app.post("/api/library/books/:id/metadata-match", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = parseBody(metadataMatchSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid metadata match", details: parsed.error });
      return;
    }

    try {
      const book = await applyMetadataCandidate(
        id,
        { ...parsed.data.candidate, authors: parsed.data.candidate.authors ?? [] },
        parsed.data.updateDetails ?? true,
        parsed.data.updateCover ?? true
      );
      if (!book) {
        reply.code(404).send({ error: "Audiobook not found" });
        return;
      }

      reply.send({ updated: true, book });
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : "Unable to apply metadata" });
    }
  });

  app.patch("/api/library/books/:id/metadata", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = parseBody(manualMetadataSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid metadata details", details: parsed.error });
      return;
    }

    const book = updateManualMetadata(id, {
      ...parsed.data,
      authors: parsed.data.authors ?? [],
      narrators: parsed.data.narrators ?? [],
      genres: parsed.data.genres ?? []
    });
    if (!book) {
      reply.code(404).send({ error: "Audiobook not found" });
      return;
    }

    reply.send({ updated: true, book });
  });

  app.get("/api/library/books/:id/cover-candidates", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const context = getBookCoverFolder(id);
    if (!context) {
      reply.code(404).send({ error: "Audiobook not found" });
      return;
    }

    const candidates = fs.readdirSync(context.folderPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && coverImageExtensions.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => {
        const filePath = path.join(context.folderPath, entry.name);
        const stat = fs.statSync(filePath);
        const relativePath = normaliseRelativePath(path.relative(context.folderPath, filePath));
        return {
          name: entry.name,
          relativePath,
          size: stat.size,
          previewUrl: `/api/library/books/${id}/cover-candidate?path=${encodeURIComponent(relativePath)}`
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));

    reply.send({ covers: candidates });
  });

  app.get("/api/library/books/:id/cover-candidate", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const relativePath = String((request.query as { path?: string }).path ?? "");
    const filePath = coverFilePathFromRelative(id, relativePath);
    if (!filePath) {
      reply.code(404).send({ error: "Cover file not found" });
      return;
    }

    reply
      .type(imageMimeType(filePath))
      .header("Cache-Control", "private, max-age=300")
      .send(fs.createReadStream(filePath));
  });

  app.post("/api/library/books/:id/cover", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = parseBody(coverSourceSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid cover selection", details: parsed.error });
      return;
    }

    const filePath = coverFilePathFromRelative(id, parsed.data.relativePath);
    if (!filePath) {
      reply.code(404).send({ error: "Cover file not found" });
      return;
    }

    try {
      const coverStorageKey = await writeCoverImages(id, filePath);
      const book = updateBookCover(id, coverStorageKey);
      reply.send({ updated: true, book });
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : "Unable to apply cover" });
    }
  });

  app.put("/api/library/books/:id/cover", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const existing = db.prepare("SELECT id FROM books WHERE id = ? AND deleted_at IS NULL").get(id);
    if (!existing) {
      reply.code(404).send({ error: "Audiobook not found" });
      return;
    }

    const contentType = request.headers["content-type"]?.split(";")[0]?.toLowerCase();
    if (!contentType || !["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
      reply.code(415).send({ error: "Upload a JPEG, PNG, or WebP image." });
      return;
    }

    const body = request.body;
    if (!Buffer.isBuffer(body) || body.byteLength === 0) {
      reply.code(400).send({ error: "Cover image is required." });
      return;
    }
    if (body.byteLength > 10 * 1024 * 1024) {
      reply.code(400).send({ error: "Cover image is too large." });
      return;
    }

    try {
      const coverStorageKey = await writeCoverImages(id, body);
      const book = updateBookCover(id, coverStorageKey);
      reply.send({ updated: true, book });
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : "Unable to upload cover" });
    }
  });

  app.get("/api/library/books/:id/progress", { preHandler: app.authenticate }, async (request, reply) => {
    const bookId = (request.params as { id: string }).id;
    const userId = request.user!.id;

    const row = db.prepare(`
      SELECT current_file_id, position_seconds, percent_complete, completed_at
      FROM playback_progress
      WHERE book_id = ? AND user_id = ?
    `).get(bookId, userId) as {
      current_file_id: string | null;
      position_seconds: number;
      percent_complete: number | null;
      completed_at: string | null;
    } | undefined;

    reply.send({
      progress: row
        ? {
            fileId: row.current_file_id,
            positionSeconds: row.position_seconds,
            percentComplete: row.percent_complete,
            completedAt: row.completed_at
          }
        : null
    });
  });

  app.patch("/api/library/books/:id/progress", { preHandler: app.authenticate }, async (request, reply) => {
    const bookId = (request.params as { id: string }).id;
    const userId = request.user!.id;
    const parsed = parseBody(progressUpdateSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid progress update", details: parsed.error });
      return;
    }

    const { fileId, positionSeconds } = parsed.data;

    const cumulative = db.prepare(`
      SELECT COALESCE(SUM(bf.duration_seconds), 0) AS before_seconds
      FROM book_files bf
      JOIN book_files current_file ON current_file.id = ? AND current_file.book_id = ? AND current_file.book_id = bf.book_id
      WHERE bf.track_number < current_file.track_number
        AND bf.status = 'available'
    `).get(fileId, bookId) as { before_seconds: number } | undefined;

    const currentFile = db.prepare(`
      SELECT id
      FROM book_files
      WHERE id = ?
        AND book_id = ?
        AND status = 'available'
    `).get(fileId, bookId);
    if (!currentFile) {
      reply.code(404).send({ error: "Audio file not found" });
      return;
    }

    const totalDuration = (db.prepare("SELECT duration_seconds FROM book_metadata WHERE book_id = ?").get(bookId) as { duration_seconds: number | null } | undefined)?.duration_seconds ?? null;

    const absoluteSeconds = (cumulative?.before_seconds ?? 0) + positionSeconds;
    const percentComplete = totalDuration ? Math.min(absoluteSeconds / totalDuration, 1) : null;
    const isComplete = percentComplete !== null && percentComplete >= 0.98;

    db.prepare(`
      INSERT INTO playback_progress (id, user_id, book_id, current_file_id, position_seconds, duration_seconds, percent_complete, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
      ON CONFLICT(user_id, book_id) DO UPDATE SET
        current_file_id = excluded.current_file_id,
        position_seconds = excluded.position_seconds,
        duration_seconds = excluded.duration_seconds,
        percent_complete = excluded.percent_complete,
        updated_at = CURRENT_TIMESTAMP,
        completed_at = CASE WHEN excluded.completed_at IS NOT NULL THEN excluded.completed_at ELSE completed_at END
    `).run(
      nanoid(16),
      userId,
      bookId,
      fileId,
      positionSeconds,
      totalDuration,
      percentComplete,
      isComplete ? new Date().toISOString() : null
    );

    reply.send({ updated: true });
  });

  app.post("/api/library/books/:id/progress/complete", { preHandler: app.authenticate }, async (request, reply) => {
    const bookId = (request.params as { id: string }).id;
    const userId = request.user!.id;
    const file = db.prepare(`
      SELECT id, duration_seconds
      FROM book_files
      WHERE book_id = ?
        AND status = 'available'
      ORDER BY track_number DESC, relative_path COLLATE NOCASE DESC
      LIMIT 1
    `).get(bookId) as { id: string; duration_seconds: number | null } | undefined;

    if (!file) {
      reply.code(404).send({ error: "No audio files available" });
      return;
    }

    const totalDuration = (db.prepare("SELECT duration_seconds FROM book_metadata WHERE book_id = ?").get(bookId) as { duration_seconds: number | null } | undefined)?.duration_seconds ?? null;
    db.prepare(`
      INSERT INTO playback_progress (id, user_id, book_id, current_file_id, position_seconds, duration_seconds, percent_complete, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, book_id) DO UPDATE SET
        current_file_id = excluded.current_file_id,
        position_seconds = excluded.position_seconds,
        duration_seconds = excluded.duration_seconds,
        percent_complete = 1,
        updated_at = CURRENT_TIMESTAMP,
        completed_at = CURRENT_TIMESTAMP
    `).run(nanoid(16), userId, bookId, file.id, file.duration_seconds ?? totalDuration ?? 0, totalDuration);

    reply.send({ updated: true });
  });

  app.delete("/api/library/books/:id/progress", { preHandler: app.authenticate }, async (request, reply) => {
    const bookId = (request.params as { id: string }).id;
    const userId = request.user!.id;
    db.prepare("DELETE FROM playback_progress WHERE book_id = ? AND user_id = ?").run(bookId, userId);
    reply.send({ reset: true });
  });

  app.post("/api/library/books/:id/metadata-reset", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const existing = db.prepare("SELECT id FROM books WHERE id = ? AND deleted_at IS NULL").get(id);
    if (!existing) {
      reply.code(404).send({ error: "Audiobook not found" });
      return;
    }

    db.prepare("UPDATE book_metadata SET source = 'scan', updated_at = CURRENT_TIMESTAMP WHERE book_id = ?").run(id);

    try {
      await rescanSingleBook(id);
    } catch {
      // rescan best-effort; metadata source is already reset
    }

    const book = getAudiobookBookDetail(id);
    reply.send({ reset: true, book });
  });
}
