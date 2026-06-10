import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import sharp from "sharp";
import { nanoid } from "nanoid";
import { db } from "../../../db.js";
import { normaliseRelativePath } from "../shared/storage-roots.js";
import { thumbnailAbsolutePath, thumbnailStorageKey } from "../shared/thumbnail.js";
import { matchCategoryId, setEntityTags } from "../audiobook/categorize.js";
import { validateLibrarySource } from "../shared/library-source.js";

const scanJobType = "SCAN_EBOOK_LIBRARY";

const ebookMimeTypes: Record<string, string> = {
  ".epub": "application/epub+zip",
  ".pdf": "application/pdf"
};
export const ebookExtensions = new Set(Object.keys(ebookMimeTypes));

export interface EbookSettings {
  default_language?: string;
}

interface EbookFileEntry {
  absolutePath: string;
  relativePath: string;
  fileName: string;
  extension: string;
  size: number;
}

interface EbookMetadata {
  title: string | null;
  authors: string[];
  language: string | null;
  description: string | null;
  subjects: string[];
  year: number | null;
  isbn: string | null;
  coverBuffer: Buffer | null;
}

// ── EPUB parsing (OPF is simple XML; targeted extraction, no XML dependency) ──

function decodeXml(value: string | null | undefined): string | null {
  if (value == null) return null;
  const text = value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstMatch(source: string, re: RegExp): string | null {
  return decodeXml(source.match(re)?.[1] ?? null);
}

function allMatches(source: string, re: RegExp): string[] {
  return [...source.matchAll(re)].map((m) => decodeXml(m[1])).filter((v): v is string => Boolean(v));
}

function extractEpubMetadata(filePath: string): EbookMetadata | null {
  let zip: AdmZip;
  try {
    zip = new AdmZip(filePath);
  } catch {
    return null;
  }

  const container = zip.getEntry("META-INF/container.xml")?.getData().toString("utf8");
  const opfPath = container?.match(/full-path=["']([^"']+)["']/i)?.[1];
  if (!opfPath) return null;
  const opf = zip.getEntry(opfPath)?.getData().toString("utf8");
  if (!opf) return null;
  const opfDir = path.posix.dirname(opfPath);

  const title = firstMatch(opf, /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i);
  const authors = allMatches(opf, /<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/gi);
  const language = firstMatch(opf, /<dc:language[^>]*>([\s\S]*?)<\/dc:language>/i);
  const description = firstMatch(opf, /<dc:description[^>]*>([\s\S]*?)<\/dc:description>/i);
  const subjects = allMatches(opf, /<dc:subject[^>]*>([\s\S]*?)<\/dc:subject>/gi);
  const dateRaw = firstMatch(opf, /<dc:date[^>]*>([\s\S]*?)<\/dc:date>/i);
  const yearNum = dateRaw ? parseInt(dateRaw.slice(0, 4), 10) : NaN;
  const year = Number.isFinite(yearNum) ? yearNum : null;
  const identifiers = allMatches(opf, /<dc:identifier[^>]*>([\s\S]*?)<\/dc:identifier>/gi);
  const isbn = identifiers.map((id) => id.replace(/^isbn:?/i, "").replace(/[^0-9Xx]/g, ""))
    .find((id) => id.length === 10 || id.length === 13) ?? null;

  // Cover: <meta name="cover" content="id"> -> manifest item href, or an item
  // flagged properties="cover-image".
  let coverHref: string | null = null;
  const coverId = opf.match(/<meta[^>]*name=["']cover["'][^>]*content=["']([^"']+)["']/i)?.[1];
  if (coverId) {
    const idRe = escapeRegex(coverId);
    coverHref = opf.match(new RegExp(`<item[^>]*id=["']${idRe}["'][^>]*href=["']([^"']+)["']`, "i"))?.[1]
      ?? opf.match(new RegExp(`<item[^>]*href=["']([^"']+)["'][^>]*id=["']${idRe}["']`, "i"))?.[1]
      ?? null;
  }
  if (!coverHref) {
    coverHref = opf.match(/<item[^>]*properties=["'][^"']*cover-image[^"']*["'][^>]*href=["']([^"']+)["']/i)?.[1]
      ?? opf.match(/<item[^>]*href=["']([^"']+)["'][^>]*properties=["'][^"']*cover-image[^"']*["']/i)?.[1]
      ?? null;
  }

  let coverBuffer: Buffer | null = null;
  if (coverHref) {
    const decodedHref = decodeURIComponent(coverHref);
    const coverPath = normaliseRelativePath(opfDir ? path.posix.join(opfDir, decodedHref) : decodedHref);
    coverBuffer = zip.getEntry(coverPath)?.getData() ?? null;
  }

  return { title, authors, language, description, subjects, year, isbn, coverBuffer };
}

function pdfMetadata(file: EbookFileEntry): EbookMetadata {
  // PDFs carry little reliable metadata; use the filename as the title.
  return {
    title: path.basename(file.fileName, file.extension).replace(/[_]+/g, " ").trim() || null,
    authors: [], language: null, description: null, subjects: [], year: null, isbn: null, coverBuffer: null
  };
}

// ── Shared lookups (alias-aware author upsert, mirrors the audiobook scanner) ──

function resolvePersonName(name: string): string {
  const row = db.prepare("SELECT canonical_name FROM person_aliases WHERE alias = ?")
    .get(name.trim()) as { canonical_name: string } | undefined;
  return row ? row.canonical_name : name;
}

function sortName(value: string): string {
  return value.trim().toLowerCase();
}

function upsertAuthor(libraryId: string, name: string): string {
  const resolved = resolvePersonName(name);
  db.prepare("INSERT OR IGNORE INTO authors (id, library_id, name, sort_name) VALUES (?, ?, ?, ?)")
    .run(nanoid(16), libraryId, resolved, sortName(resolved));
  return (db.prepare("SELECT id FROM authors WHERE library_id = ? AND name = ?").get(libraryId, resolved) as { id: string }).id;
}

async function generateEbookCover(libraryId: string, bookId: string, source: Buffer): Promise<string | null> {
  try {
    const coverKey = thumbnailStorageKey(libraryId, bookId, `${bookId}-cover.webp`);
    const largeKey = thumbnailStorageKey(libraryId, bookId, `${bookId}-cover-large.webp`);
    const coverPath = thumbnailAbsolutePath(coverKey);
    const largePath = thumbnailAbsolutePath(largeKey);
    fs.mkdirSync(path.dirname(coverPath), { recursive: true });
    await Promise.all([
      sharp(source).resize(400, 600, { fit: "inside" }).webp({ quality: 82 }).toFile(coverPath),
      sharp(source).resize(800, 1200, { fit: "inside" }).webp({ quality: 86 }).toFile(largePath)
    ]);
    return coverKey;
  } catch {
    return null;
  }
}

// ── Filesystem walk ──

function walkEbookFiles(rootPath: string): EbookFileEntry[] {
  const files: EbookFileEntry[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          if (!fs.realpathSync(absolutePath).startsWith(`${rootPath}${path.sep}`)) continue;
        } catch { continue; }
      }
      if (entry.isDirectory()) { walk(absolutePath); continue; }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (!ebookExtensions.has(extension)) continue;
      let size = 0;
      try { size = fs.statSync(absolutePath).size; } catch { continue; }
      files.push({
        absolutePath,
        relativePath: normaliseRelativePath(path.relative(rootPath, absolutePath)),
        fileName: entry.name,
        extension,
        size
      });
    }
  };
  walk(rootPath);
  return files;
}

// ── Scan ──

export async function scanEbookLibrary(libraryId: string) {
  const library = db.prepare("SELECT id, source_path, settings_json FROM libraries WHERE id = ? AND type = 'ebook'")
    .get(libraryId) as { id: string; source_path: string; settings_json: string } | undefined;
  if (!library) throw new Error("Ebook library not found.");

  const settings = JSON.parse(library.settings_json || "{}") as EbookSettings;
  const rootPath = validateLibrarySource(library.source_path);
  const files = walkEbookFiles(rootPath);
  const seenPaths = new Set<string>();

  for (const file of files) {
    seenPaths.add(file.relativePath);
    const existing = db.prepare("SELECT id FROM books WHERE library_id = ? AND folder_path = ?")
      .get(libraryId, file.relativePath) as { id: string } | undefined;
    const metaRow = existing
      ? db.prepare("SELECT source FROM book_metadata WHERE book_id = ?").get(existing.id) as { source: string } | undefined
      : undefined;
    const manual = metaRow?.source === "manual";
    const bookId = existing?.id ?? nanoid(16);

    const meta = file.extension === ".epub"
      ? (extractEpubMetadata(file.absolutePath) ?? pdfMetadata(file))
      : pdfMetadata(file);
    const title = meta.title || path.basename(file.fileName, file.extension);
    const coverKey = (!manual && meta.coverBuffer) ? await generateEbookCover(libraryId, bookId, meta.coverBuffer) : null;

    db.transaction(() => {
      if (existing) {
        db.prepare("UPDATE books SET status = 'ready', updated_at = CURRENT_TIMESTAMP, deleted_at = NULL WHERE id = ?").run(bookId);
      } else {
        db.prepare("INSERT INTO books (id, library_id, folder_path, status) VALUES (?, ?, ?, 'ready')")
          .run(bookId, libraryId, file.relativePath);
      }

      if (!manual) {
        db.prepare(`
          INSERT INTO book_metadata (id, book_id, source, title, sort_title, description, year_published, language, isbn, cover_storage_key, category_id)
          VALUES (?, ?, 'scan', ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(book_id) DO UPDATE SET
            title = excluded.title,
            sort_title = excluded.sort_title,
            description = excluded.description,
            year_published = excluded.year_published,
            language = excluded.language,
            isbn = excluded.isbn,
            cover_storage_key = COALESCE(excluded.cover_storage_key, book_metadata.cover_storage_key),
            category_id = excluded.category_id,
            updated_at = CURRENT_TIMESTAMP
        `).run(
          nanoid(16), bookId, title, sortName(title), meta.description,
          meta.year, meta.language || settings.default_language || null, meta.isbn, coverKey,
          matchCategoryId(meta.subjects)
        );

        db.prepare("DELETE FROM book_authors WHERE book_id = ? AND role = 'author'").run(bookId);
        meta.authors.forEach((name, index) => {
          const authorId = upsertAuthor(libraryId, name);
          db.prepare("INSERT OR IGNORE INTO book_authors (book_id, author_id, role, sort_order) VALUES (?, ?, 'author', ?)")
            .run(bookId, authorId, index);
        });

        setEntityTags("book", bookId, meta.subjects);
      }

      // The ebook file itself is stored as the book's document.
      db.prepare("UPDATE book_documents SET status = 'missing', deleted_at = CURRENT_TIMESTAMP WHERE book_id = ?").run(bookId);
      db.prepare(`
        INSERT INTO book_documents (id, book_id, relative_path, format, mime_type, size, status, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, 'available', NULL)
        ON CONFLICT(book_id, relative_path) DO UPDATE SET
          format = excluded.format, mime_type = excluded.mime_type, size = excluded.size,
          status = 'available', deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
      `).run(nanoid(16), bookId, file.relativePath, file.extension.slice(1), ebookMimeTypes[file.extension], file.size);
    })();
  }

  // Soft-delete books whose files vanished.
  const known = db.prepare("SELECT id, folder_path FROM books WHERE library_id = ? AND deleted_at IS NULL")
    .all(libraryId) as { id: string; folder_path: string }[];
  for (const book of known) {
    if (!seenPaths.has(book.folder_path)) {
      db.prepare("UPDATE books SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?").run(book.id);
      db.prepare("UPDATE book_documents SET status = 'missing', deleted_at = CURRENT_TIMESTAMP WHERE book_id = ?").run(book.id);
    }
  }

  db.prepare("UPDATE libraries SET scan_status = 'idle', last_scanned_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(libraryId);
  return { books: files.length };
}

// ── Job queue (mirrors the audiobook scan worker) ──

export function enqueueEbookScan(libraryId: string): string {
  const jobId = nanoid(16);
  db.prepare("UPDATE libraries SET scan_status = 'scanning', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(libraryId);
  db.prepare("INSERT INTO jobs (id, type, payload, status) VALUES (?, ?, ?, 'pending')")
    .run(jobId, scanJobType, JSON.stringify({ libraryId }));
  return jobId;
}

let queueRunning = false;

export async function processEbookScanQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    db.prepare("UPDATE jobs SET status = 'pending', locked_at = NULL, locked_by = NULL, error = NULL WHERE type = ? AND status = 'running'")
      .run(scanJobType);

    for (;;) {
      const job = db.prepare(`
        SELECT id, payload FROM jobs
        WHERE type = ? AND status = 'pending' AND datetime(run_at) <= datetime('now')
        ORDER BY datetime(run_at) ASC LIMIT 1
      `).get(scanJobType) as { id: string; payload: string } | undefined;
      if (!job) break;

      const claim = db.prepare(`
        UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = CURRENT_TIMESTAMP, locked_by = ?
        WHERE id = ? AND status = 'pending'
      `).run(process.pid.toString(), job.id);
      if (claim.changes === 0) continue;

      const payload = JSON.parse(job.payload) as { libraryId: string };
      try {
        const result = await scanEbookLibrary(payload.libraryId);
        db.prepare(`
          UPDATE jobs SET status = 'completed', payload = ?, completed_at = CURRENT_TIMESTAMP, locked_at = NULL, locked_by = NULL
          WHERE id = ?
        `).run(JSON.stringify({ ...payload, result }), job.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Ebook scan failed";
        const attempts = (db.prepare("SELECT attempts, max_attempts FROM jobs WHERE id = ?").get(job.id) as { attempts: number; max_attempts: number });
        if (attempts.attempts < attempts.max_attempts) {
          const runAt = new Date(Date.now() + 5000).toISOString();
          db.prepare("UPDATE jobs SET status = 'pending', run_at = ?, locked_at = NULL, locked_by = NULL, error = ? WHERE id = ?")
            .run(runAt, message, job.id);
        } else {
          db.prepare("UPDATE jobs SET status = 'failed', failed_at = CURRENT_TIMESTAMP, locked_at = NULL, locked_by = NULL, error = ? WHERE id = ?")
            .run(message, job.id);
          db.prepare("UPDATE libraries SET scan_status = 'error', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND scan_status = 'scanning'")
            .run(payload.libraryId);
        }
      }
    }
  } finally {
    queueRunning = false;
  }
}

export function startEbookScanWorker() {
  const timer = setInterval(() => { void processEbookScanQueue(); }, 2000);
  return () => clearInterval(timer);
}
