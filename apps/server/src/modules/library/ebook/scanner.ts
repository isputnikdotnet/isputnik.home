import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import sharp from "sharp";
import { nanoid } from "nanoid";
import { db } from "../../../db.js";
import { normaliseRelativePath } from "../shared/storage-roots.js";
import { thumbnailAbsolutePath, thumbnailStorageKey } from "../shared/thumbnail.js";
import { matchCategoryId, setEntityTags } from "../audiobook/categorize.js";
import { validateLibrarySource, LibrarySourceError } from "../shared/library-source.js";
import {
  normalizeLibrarySettings,
  normalizeScanSources,
  sourceEnabled,
  type ScanSourceConfig
} from "../shared/library-settings.js";

const scanJobType = "SCAN_EBOOK_LIBRARY";

const ebookMimeTypes: Record<string, string> = {
  ".epub": "application/epub+zip",
  ".pdf": "application/pdf"
};

export interface EbookScanOptions {
  // One-shot override of the library's persisted scan_sources (rescan).
  sources?: ScanSourceConfig[];
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
  void libraryId; // people are global
  const resolved = resolvePersonName(name);
  db.prepare("INSERT OR IGNORE INTO people (id, name, sort_name) VALUES (?, ?, ?)")
    .run(nanoid(16), resolved, sortName(resolved));
  return (db.prepare("SELECT id FROM people WHERE name = ?").get(resolved) as { id: string }).id;
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

function walkEbookFiles(rootPath: string, extensions: Set<string>): EbookFileEntry[] {
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
      if (!extensions.has(extension)) continue;
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

// Catalog one ebook file as a book — insert/update the book row, its scanned
// metadata (unless the book was hand-edited), and its single document. Shared by
// the full-library walk and the single-file upload path. Returns the book id.
async function ingestEbookFile(
  libraryId: string,
  file: EbookFileEntry,
  settings: ReturnType<typeof normalizeLibrarySettings>,
  fileMetaEnabled: boolean
): Promise<string> {
  const existing = db.prepare("SELECT id FROM library_items WHERE library_id = ? AND folder_path = ?")
    .get(libraryId, file.relativePath) as { id: string } | undefined;
  const metaRow = existing
    ? db.prepare("SELECT source FROM item_metadata WHERE item_id = ?").get(existing.id) as { source: string } | undefined
    : undefined;
  const manual = metaRow?.source === "manual";
  const bookId = existing?.id ?? nanoid(16);

  const meta = fileMetaEnabled && file.extension === ".epub"
    ? (extractEpubMetadata(file.absolutePath) ?? pdfMetadata(file))
    : pdfMetadata(file);
  const title = meta.title || path.basename(file.fileName, file.extension);
  const coverKey = (!manual && meta.coverBuffer) ? await generateEbookCover(libraryId, bookId, meta.coverBuffer) : null;

  db.transaction(() => {
    if (existing) {
      db.prepare("UPDATE library_items SET status = 'ready', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_at = NULL WHERE id = ?").run(bookId);
    } else {
      db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, ?, 'ebook', ?, 'ready')")
        .run(bookId, libraryId, file.relativePath);
    }

    if (!manual) {
      db.prepare(`
        INSERT INTO item_metadata (item_id, source, title, sort_title, description, year_published, language, isbn, cover_storage_key)
        VALUES (?, 'scan', ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET
          title = excluded.title,
          sort_title = excluded.sort_title,
          description = excluded.description,
          year_published = excluded.year_published,
          language = excluded.language,
          isbn = excluded.isbn,
          cover_storage_key = COALESCE(excluded.cover_storage_key, item_metadata.cover_storage_key),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      `).run(
        bookId, title, sortName(title), meta.description,
        meta.year, meta.language || settings.default_language || null, meta.isbn, coverKey
      );

      // Primary category from the ebook's subjects.
      const categoryId = matchCategoryId(meta.subjects);
      db.prepare("DELETE FROM item_categories WHERE item_id = ? AND is_primary = 1").run(bookId);
      db.prepare(`
        INSERT INTO item_categories (item_id, category_id, is_primary, source) VALUES (?, ?, 1, 'scan')
        ON CONFLICT(item_id, category_id) DO UPDATE SET is_primary = 1, source = 'scan'
      `).run(bookId, categoryId);

      db.prepare("DELETE FROM item_people WHERE item_id = ? AND role = 'author'").run(bookId);
      meta.authors.forEach((name, index) => {
        const authorId = upsertAuthor(libraryId, name);
        db.prepare("INSERT OR IGNORE INTO item_people (item_id, person_id, role, sort_order) VALUES (?, ?, 'author', ?)")
          .run(bookId, authorId, index);
      });

      setEntityTags("library_item", bookId, meta.subjects);
    }

    // The ebook file itself is stored as the item's content document.
    db.prepare("UPDATE document_files SET status = 'missing', deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_id = ? AND role = 'content'").run(bookId);
    db.prepare(`
      INSERT INTO document_files (id, item_id, role, relative_path, format, mime_type, size, status, deleted_at)
      VALUES (?, ?, 'content', ?, ?, ?, ?, 'available', NULL)
      ON CONFLICT(item_id, relative_path) DO UPDATE SET
        role = 'content', format = excluded.format, mime_type = excluded.mime_type, size = excluded.size,
        status = 'available', deleted_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(nanoid(16), bookId, file.relativePath, file.extension.slice(1), ebookMimeTypes[file.extension] ?? "application/octet-stream", file.size);
  })();

  return bookId;
}

// Ingest a single newly-added ebook file (e.g. an upload) by its path relative to
// the library source, without re-walking the whole library. Returns the new/updated
// book id, or null if the library or file can't be read.
export async function scanSingleEbookFile(libraryId: string, relativePath: string): Promise<string | null> {
  const library = db.prepare("SELECT id, source_path, settings_json FROM libraries WHERE id = ? AND type = 'ebook'")
    .get(libraryId) as { id: string; source_path: string; settings_json: string } | undefined;
  if (!library) return null;

  const settings = normalizeLibrarySettings("ebook", library.settings_json);
  const fileMetaEnabled = sourceEnabled(settings.scan_sources, "file_metadata");
  const rootPath = validateLibrarySource(library.source_path);
  const normalized = normaliseRelativePath(relativePath);
  const absolutePath = path.join(rootPath, normalized);
  let size = 0;
  try { size = fs.statSync(absolutePath).size; } catch { return null; }

  const file: EbookFileEntry = {
    absolutePath,
    relativePath: normalized,
    fileName: path.basename(absolutePath),
    extension: path.extname(absolutePath).toLowerCase(),
    size
  };
  return ingestEbookFile(libraryId, file, settings, fileMetaEnabled);
}

async function scanEbookLibrary(libraryId: string, options: EbookScanOptions = {}) {
  const library = db.prepare("SELECT id, source_path, settings_json FROM libraries WHERE id = ? AND type = 'ebook'")
    .get(libraryId) as { id: string; source_path: string; settings_json: string } | undefined;
  if (!library) throw new Error("Ebook library not found.");

  const settings = normalizeLibrarySettings("ebook", library.settings_json);
  const sources = options.sources ? normalizeScanSources("ebook", options.sources) : settings.scan_sources;
  // file_metadata gates EPUB OPF extraction; off = filename-derived records only.
  const fileMetaEnabled = sourceEnabled(sources, "file_metadata");
  const rootPath = validateLibrarySource(library.source_path);
  const files = walkEbookFiles(rootPath, new Set(settings.scan_extensions.map((extension) => `.${extension}`)));
  const seenPaths = new Set<string>();

  for (const file of files) {
    seenPaths.add(file.relativePath);
    await ingestEbookFile(libraryId, file, settings, fileMetaEnabled);
  }

  // Soft-delete books whose files vanished.
  const known = db.prepare("SELECT id, folder_path FROM library_items WHERE library_id = ? AND deleted_at IS NULL")
    .all(libraryId) as { id: string; folder_path: string }[];
  for (const book of known) {
    if (!seenPaths.has(book.folder_path)) {
      db.prepare("UPDATE library_items SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(book.id);
      db.prepare("UPDATE document_files SET status = 'missing', deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_id = ?").run(book.id);
    }
  }

  db.prepare("UPDATE libraries SET scan_status = 'idle', last_scanned_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .run(libraryId);
  return { books: files.length };
}

// ── Job queue (mirrors the audiobook scan worker) ──

export function enqueueEbookScan(libraryId: string, options: EbookScanOptions = {}): string {
  const jobId = nanoid(16);
  db.prepare("UPDATE libraries SET scan_status = 'scanning', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(libraryId);
  db.prepare("INSERT INTO jobs (id, type, payload, status) VALUES (?, ?, ?, 'pending')")
    .run(jobId, scanJobType, JSON.stringify({ libraryId, options }));
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
        UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_by = ?
        WHERE id = ? AND status = 'pending'
      `).run(process.pid.toString(), job.id);
      if (claim.changes === 0) continue;

      const payload = JSON.parse(job.payload) as { libraryId: string; options?: EbookScanOptions };
      try {
        const result = await scanEbookLibrary(payload.libraryId, payload.options ?? {});
        db.prepare(`
          UPDATE jobs SET status = 'completed', payload = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL
          WHERE id = ?
        `).run(JSON.stringify({ ...payload, result }), job.id);
      } catch (err) {
        // A bad/missing source folder is a permanent configuration error — fail the
        // job at once instead of retrying while the library is stuck on "scanning".
        const permanent = err instanceof LibrarySourceError;
        const message = err instanceof Error ? err.message : "Ebook scan failed";
        const attempts = (db.prepare("SELECT attempts, max_attempts FROM jobs WHERE id = ?").get(job.id) as { attempts: number; max_attempts: number });
        if (!permanent && attempts.attempts < attempts.max_attempts) {
          const runAt = new Date(Date.now() + 5000).toISOString();
          db.prepare("UPDATE jobs SET status = 'pending', run_at = ?, locked_at = NULL, locked_by = NULL, error = ? WHERE id = ?")
            .run(runAt, message, job.id);
        } else {
          db.prepare("UPDATE jobs SET status = 'failed', failed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL, error = ? WHERE id = ?")
            .run(message, job.id);
          db.prepare("UPDATE libraries SET scan_status = 'error', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND scan_status = 'scanning'")
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
