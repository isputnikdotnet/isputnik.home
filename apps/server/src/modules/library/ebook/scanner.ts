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
import { matchPattern } from "../shared/scan-rule-pattern.js";

const scanJobType = "SCAN_EBOOK_LIBRARY";

const ebookMimeTypes: Record<string, string> = {
  ".epub": "application/epub+zip",
  ".pdf": "application/pdf",
  ".fb2": "application/x-fictionbook+xml",
  ".mobi": "application/x-mobipocket-ebook",
  ".azw3": "application/vnd.amazon.ebook",
  ".cbz": "application/vnd.comicbook+zip",
  ".cbr": "application/vnd.comicbook-rar",
  ".txt": "text/plain",
  ".rtf": "application/rtf"
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

// ── FB2 parsing (FictionBook is XML; the <title-info> block holds the catalog
// metadata, and the cover is a base64 <binary> referenced from <coverpage>) ──

// FB2 splits names across <first-name>/<middle-name>/<last-name>; join them,
// falling back to <nickname> when a person has no real-name parts.
function fb2PersonName(block: string): string | null {
  const parts = [
    firstMatch(block, /<first-name[^>]*>([\s\S]*?)<\/first-name>/i),
    firstMatch(block, /<middle-name[^>]*>([\s\S]*?)<\/middle-name>/i),
    firstMatch(block, /<last-name[^>]*>([\s\S]*?)<\/last-name>/i)
  ].filter(Boolean);
  return parts.join(" ").trim() || firstMatch(block, /<nickname[^>]*>([\s\S]*?)<\/nickname>/i);
}

function fb2Cover(xml: string, titleInfo: string): Buffer | null {
  // <coverpage><image l:href="#id"/></coverpage> → <binary id="id">base64</binary>.
  const href = titleInfo.match(/<coverpage[\s\S]*?<image[^>]*?(?:l:href|xlink:href|href)=["']#?([^"']+)["']/i)?.[1];
  if (!href) return null;
  const b64 = xml.match(new RegExp(`<binary[^>]*\\bid=["']${escapeRegex(href)}["'][^>]*>([\\s\\S]*?)</binary>`, "i"))?.[1];
  if (!b64) return null;
  try {
    const buf = Buffer.from(b64.replace(/\s+/g, ""), "base64");
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

// Parse catalog metadata out of an FB2 document. Pure (takes the file bytes) so it
// can be unit-tested, and so we can honour the charset the XML prolog declares —
// older Russian FB2 files are commonly windows-1251 and would otherwise decode to
// mojibake if read as UTF-8.
export function parseFb2Metadata(raw: Buffer): EbookMetadata {
  const declared = raw.subarray(0, 200).toString("latin1")
    .match(/<\?xml[^>]*\bencoding=["']([^"']+)["']/i)?.[1]?.toLowerCase() || "utf-8";
  let xml: string;
  try {
    xml = new TextDecoder(declared).decode(raw);
  } catch {
    xml = raw.toString("utf8");
  }

  // Restrict to <title-info>; the body can repeat <author>/<genre> in citations.
  const titleInfo = xml.match(/<title-info\b[^>]*>([\s\S]*?)<\/title-info>/i)?.[1] ?? xml;

  const authors = [...titleInfo.matchAll(/<author\b[^>]*>([\s\S]*?)<\/author>/gi)]
    .map((m) => fb2PersonName(m[1]))
    .filter((v): v is string => Boolean(v));
  const keywords = (firstMatch(titleInfo, /<keywords[^>]*>([\s\S]*?)<\/keywords>/i) ?? "")
    .split(",").map((k) => k.trim()).filter(Boolean);
  const dateRaw = firstMatch(titleInfo, /<date[^>]*>([\s\S]*?)<\/date>/i);
  const yearNum = dateRaw ? parseInt(dateRaw.match(/\d{4}/)?.[0] ?? "", 10) : NaN;
  // The annotation wraps its text in <p>/<empty-line> markup; drop those tags so
  // the stored description is plain text.
  const annotation = titleInfo.match(/<annotation[^>]*>([\s\S]*?)<\/annotation>/i)?.[1];

  return {
    title: firstMatch(titleInfo, /<book-title[^>]*>([\s\S]*?)<\/book-title>/i),
    authors,
    language: firstMatch(titleInfo, /<lang[^>]*>([\s\S]*?)<\/lang>/i),
    description: annotation ? decodeXml(annotation.replace(/<[^>]+>/g, " ")) : null,
    // FB2 genre codes (e.g. "sf_action") plus free-form keywords both become
    // subjects — feeding the primary category match and the item's tags, exactly
    // as EPUB <dc:subject> values do.
    subjects: [...allMatches(titleInfo, /<genre[^>]*>([\s\S]*?)<\/genre>/gi), ...keywords],
    year: Number.isFinite(yearNum) ? yearNum : null,
    isbn: null,
    coverBuffer: fb2Cover(xml, titleInfo)
  };
}

function extractFb2Metadata(filePath: string): EbookMetadata | null {
  try {
    return parseFb2Metadata(fs.readFileSync(filePath));
  } catch {
    return null;
  }
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

// The grouping key for a file: its directory + basename without extension. Files in
// the same folder sharing a stem (Title.epub + Title.pdf + Title.fb2) are ONE book
// in several formats. (Folder-as-book would wrongly merge loose uploads at the root.)
export function ebookGroupKey(relativePath: string): string {
  const dir = path.posix.dirname(relativePath);
  const stem = path.posix.basename(relativePath, path.posix.extname(relativePath));
  return dir === "." ? stem : `${dir}/${stem}`;
}

// Catalog one GROUP of files (the same book in one or more formats) — insert/update
// the book row, its scanned metadata (unless hand-edited), and one content document
// per format. Metadata + cover come from the EPUB when the group has one. Shared by
// the full-library walk and the single-file upload path. Returns the book id.
export async function ingestEbookGroup(
  libraryId: string,
  files: EbookFileEntry[],
  settings: ReturnType<typeof normalizeLibrarySettings>,
  fileMetaEnabled: boolean
): Promise<string> {
  const groupKey = ebookGroupKey(files[0].relativePath);
  const existing = db.prepare("SELECT id FROM library_items WHERE library_id = ? AND folder_path = ?")
    .get(libraryId, groupKey) as { id: string } | undefined;
  const metaRow = existing
    ? db.prepare("SELECT source FROM item_metadata WHERE item_id = ?").get(existing.id) as { source: string } | undefined
    : undefined;
  const manual = metaRow?.source === "manual";
  const bookId = existing?.id ?? nanoid(16);

  // Prefer the EPUB for metadata + cover (richest, via its OPF), then an FB2 (XML
  // metadata + embedded cover); any other lone format is titled from its filename.
  const metaFile = files.find((entry) => entry.extension === ".epub")
    ?? files.find((entry) => entry.extension === ".fb2")
    ?? files[0];
  const scanned = fileMetaEnabled
    ? metaFile.extension === ".epub" ? extractEpubMetadata(metaFile.absolutePath)
      : metaFile.extension === ".fb2" ? extractFb2Metadata(metaFile.absolutePath)
      : null
    : null;
  const meta = scanned ?? pdfMetadata(metaFile);
  const title = meta.title || path.basename(metaFile.fileName, metaFile.extension);
  const coverKey = (!manual && meta.coverBuffer) ? await generateEbookCover(libraryId, bookId, meta.coverBuffer) : null;

  db.transaction(() => {
    if (existing) {
      db.prepare("UPDATE library_items SET status = 'ready', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_at = NULL WHERE id = ?").run(bookId);
    } else {
      db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, ?, 'ebook', ?, 'ready')")
        .run(bookId, libraryId, groupKey);
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

    // Every file in the group is a content document. Mark all current content docs
    // missing, then re-add each present format — so a removed format drops out while
    // the rest stay available.
    db.prepare("UPDATE document_files SET status = 'missing', deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_id = ? AND role = 'content'").run(bookId);
    for (const file of files) {
      db.prepare(`
        INSERT INTO document_files (id, item_id, role, relative_path, format, mime_type, size, status, deleted_at)
        VALUES (?, ?, 'content', ?, ?, ?, ?, 'available', NULL)
        ON CONFLICT(item_id, relative_path) DO UPDATE SET
          role = 'content', format = excluded.format, mime_type = excluded.mime_type, size = excluded.size,
          status = 'available', deleted_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      `).run(nanoid(16), bookId, file.relativePath, file.extension.slice(1), ebookMimeTypes[file.extension] ?? "application/octet-stream", file.size);
    }
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
  try { fs.statSync(absolutePath); } catch { return null; }

  // Gather the whole group from disk: every file in the same folder sharing this
  // basename (any scanned extension) is a format of the same book, so an uploaded
  // PDF joins an existing EPUB rather than creating a duplicate book.
  const allowed = new Set(settings.scan_extensions.map((extension) => `.${extension}`));
  const stem = path.posix.basename(normalized, path.posix.extname(normalized));
  const dirAbs = path.dirname(absolutePath);
  const files: EbookFileEntry[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!allowed.has(extension)) continue;
    if (path.basename(entry.name, path.extname(entry.name)) !== stem) continue;
    const abs = path.join(dirAbs, entry.name);
    let size = 0;
    try { size = fs.statSync(abs).size; } catch { continue; }
    files.push({ absolutePath: abs, relativePath: normaliseRelativePath(path.relative(rootPath, abs)), fileName: entry.name, extension, size });
  }
  if (files.length === 0) return null;
  return ingestEbookGroup(libraryId, files, settings, fileMetaEnabled);
}

export interface RulePreviewRow {
  path: string;
  matched: boolean;
  author?: string;
  series?: string;
  position?: number;
  title?: string;
}

// Dry-run a scan rule's pattern over its selected folders, writing nothing. Each
// folder is the pattern anchor (so the pattern matches the book key relative to
// that folder), reusing the same walk + grouping as a real ebook scan so the
// preview can't drift from what an actual scan would produce.
export function previewEbookRulePattern(libraryId: string, folders: string[], pattern: string, limit = 50): RulePreviewRow[] {
  const library = db.prepare("SELECT source_path, settings_json FROM libraries WHERE id = ? AND type = 'ebook'")
    .get(libraryId) as { source_path: string; settings_json: string } | undefined;
  if (!library) return [];

  const settings = normalizeLibrarySettings("ebook", library.settings_json);
  const rootPath = validateLibrarySource(library.source_path);
  const extensions = new Set(settings.scan_extensions.map((extension) => `.${extension}`));

  const rows: RulePreviewRow[] = [];
  for (const folder of folders) {
    const anchor = folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const anchorAbs = anchor ? path.join(rootPath, anchor) : rootPath;
    const keys = new Set<string>();
    for (const file of walkEbookFiles(anchorAbs, extensions)) keys.add(ebookGroupKey(file.relativePath));
    for (const key of [...keys].sort()) {
      const m = matchPattern(pattern, key);
      rows.push({ path: anchor ? `${anchor}/${key}` : key, matched: m.matched, author: m.author, series: m.series, position: m.position, title: m.title });
      if (rows.length >= limit) return rows;
    }
  }
  return rows;
}

async function scanEbookLibrary(libraryId: string, options: EbookScanOptions = {}) {
  const library = db.prepare("SELECT id, source_path, settings_json FROM libraries WHERE id = ? AND type = 'ebook'")
    .get(libraryId) as { id: string; source_path: string; settings_json: string } | undefined;
  if (!library) throw new Error("Ebook library not found.");

  const settings = normalizeLibrarySettings("ebook", library.settings_json);
  const sources = options.sources ? normalizeScanSources("ebook", options.sources) : settings.scan_sources;
  // file_metadata gates in-file extraction (EPUB OPF, FB2 XML); off = filename-derived only.
  const fileMetaEnabled = sourceEnabled(sources, "file_metadata");
  const rootPath = validateLibrarySource(library.source_path);
  const files = walkEbookFiles(rootPath, new Set(settings.scan_extensions.map((extension) => `.${extension}`)));

  // Group files by folder + basename so the same book in several formats is one item.
  const groups = new Map<string, EbookFileEntry[]>();
  for (const file of files) {
    const key = ebookGroupKey(file.relativePath);
    const list = groups.get(key);
    if (list) list.push(file); else groups.set(key, [file]);
  }

  for (const groupFiles of groups.values()) {
    await ingestEbookGroup(libraryId, groupFiles, settings, fileMetaEnabled);
  }

  // Soft-delete books whose every format vanished (their group key is gone).
  const known = db.prepare("SELECT id, folder_path FROM library_items WHERE library_id = ? AND deleted_at IS NULL")
    .all(libraryId) as { id: string; folder_path: string }[];
  for (const book of known) {
    if (!groups.has(book.folder_path)) {
      db.prepare("UPDATE library_items SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(book.id);
      db.prepare("UPDATE document_files SET status = 'missing', deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_id = ?").run(book.id);
    }
  }

  db.prepare("UPDATE libraries SET scan_status = 'idle', last_scanned_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .run(libraryId);
  return { books: groups.size };
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
