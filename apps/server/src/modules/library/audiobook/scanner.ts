import fs from "node:fs";
import path from "node:path";
import { parseFile, type IAudioMetadata } from "music-metadata";
import { nanoid } from "nanoid";
import sharp from "sharp";
import { db } from "../../../db.js";
import { normaliseRelativePath } from "../shared/storage-roots.js";
import { thumbnailAbsolutePath, thumbnailStorageKey } from "../shared/thumbnail.js";
import { deleteSharesForResource } from "../shared/share-access.js";
import { deleteCollectionItemsForResource } from "../../collections/cleanup.js";
import { validateLibrarySource } from "../shared/library-source.js";
import {
  normalizeLibrarySettings,
  normalizeScanSources,
  sourceEnabled,
  type BaseLibrarySettings,
  type ScanSourceConfig
} from "../shared/library-settings.js";
import type { MetadataSourceId } from "../shared/metadata-sources.js";
import { matchCategoryId, setEntityTags } from "./categorize.js";

export { validateLibrarySource };

// Companion documents bundled with an audiobook (e.g. a PDF supplement or the
// ebook edition). Collected during scan but never treated as audio tracks.
const documentMimeTypes: Record<string, string> = {
  ".pdf": "application/pdf",
  ".epub": "application/epub+zip",
  ".mobi": "application/x-mobipocket-ebook",
  ".azw3": "application/vnd.amazon.ebook"
};
const documentExtensions = new Set(Object.keys(documentMimeTypes));
const imageExtensions = [".jpg", ".jpeg", ".png", ".webp"];
const scanJobType = "SCAN_AUDIOBOOK_LIBRARY";

export type TagEncoding = "windows-1251" | "windows-1250" | "windows-1252" | "koi8-r";

export interface ScanOptions {
  // One-shot override of the library's persisted scan_sources (rescan dialog).
  sources?: ScanSourceConfig[];
  tagEncoding?: TagEncoding;
}

// How files are grouped into books. folder_hierarchy: the folder containing the audio
// files is the book (disc subfolders collapse into the parent). top_level_folder: each
// immediate child folder of the library root is one book holding everything beneath it.
type GroupingMode = "folder_hierarchy" | "top_level_folder";

interface EffectiveScanConfig {
  settings: AudiobookSettings;
  // Enabled sources in priority order (index 0 wins per metadata field).
  sources: ScanSourceConfig[];
  groupingMode: GroupingMode;
  // True when rescan options force a fresh metadata read even for unchanged files.
  forceReread: boolean;
  tagEncoding?: TagEncoding;
}

function resolveScanConfig(settingsJson: string, options: ScanOptions): EffectiveScanConfig {
  const settings = normalizeLibrarySettings("audiobook", settingsJson) as unknown as AudiobookSettings;
  const sources = options.sources ? normalizeScanSources("audiobook", options.sources) : settings.scan_sources;
  return {
    settings,
    sources,
    groupingMode: sourceEnabled(sources, "folder_structure") ? "top_level_folder" : "folder_hierarchy",
    forceReread: options.sources != null || options.tagEncoding != null,
    tagEncoding: options.tagEncoding
  };
}

/**
 * Repairs "mojibake" — text whose bytes are really in a legacy encoding (e.g. Windows-1251)
 * but were decoded as Latin-1, producing garble like "Ðàíåå" instead of "Ранее". We reverse the
 * bad decode (re-encode to Latin-1 bytes) and decode again with the correct charset.
 *
 * Strings that already contain characters above U+00FF were decoded correctly (e.g. real UTF-8
 * Cyrillic) and are left untouched. Plain ASCII passes through unchanged either way.
 */
export function repairEncoding(value: string | null | undefined, encoding: TagEncoding | undefined): string | null {
  if (value == null) {
    return null;
  }
  if (!encoding) {
    return value;
  }
  if (/[^\u0000-\u00ff]/.test(value)) {
    return value;
  }
  try {
    const decoded = new TextDecoder(encoding).decode(Buffer.from(value, "latin1"));
    return decoded || value;
  } catch {
    return value;
  }
}

function repairList(values: string[], encoding: TagEncoding | undefined): string[] {
  if (!encoding) {
    return values;
  }
  return values.map((value) => repairEncoding(value, encoding) ?? value);
}

interface AudiobookSettings extends BaseLibrarySettings {
  cover_filenames?: string[];
}

interface AudioFileEntry {
  absolutePath: string;
  fileName: string;
  relativePath: string;
  stat: fs.Stats;
  discHint: number | null;
}

interface PreparedBookFile {
  relativePath: string;
  mimeType: string;
  trackNumber: number;
  chapterTitle: string;
  durationSeconds: number | null;
  size: number;
  modifiedAt: string;
  contentHash: string | null;
}

interface PreparedBookScan {
  bookId: string;
  folderAbsolutePath: string;
  folderPath: string;
  manualMetadata: boolean;
  title: string;
  sortTitle: string;
  description: string | null;
  yearPublished: number | null;
  language: string;
  durationSeconds: number | null;
  coverStorageKey: string | null;
  isbn: string | null;
  asin: string | null;
  publisher: string | null;
  authors: string[];
  narrators: string[];
  genres: string[];
  seriesName: string | null;
  seriesPosition: number | null;
  skipMetadataUpdate: boolean;
  files: PreparedBookFile[];
  documents: DocumentEntry[];
}

interface ExistingBookFileRow {
  relative_path: string;
  mime_type: string | null;
  track_number: number | null;
  chapter_title: string | null;
  duration_seconds: number | null;
  size: number | null;
  modified_at: string | null;
  content_hash: string | null;
}

interface SidecarMetadata {
  title?: string;
  subtitle?: string;
  authors?: string[];
  narrators?: string[];
  publisher?: string;
  year?: number;
  yearPublished?: number;
  description?: string;
  isbn?: string;
  asin?: string;
  genres?: string[];
  language?: string;
  series?: string;
  seriesName?: string;
  seriesPosition?: number;
}

export function sortTitle(value: unknown): string {
  return String(value ?? "").replace(/^(the|a|an)\s+/i, "").trim();
}

export function mimeFromExtension(extension: string) {
  return {
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".m4b": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".wav": "audio/wav",
    ".wave": "audio/wav"
  }[extension] ?? "application/octet-stream";
}

export function trackNumberFromFileName(fileName: string, fallback: number) {
  const match = fileName.match(/^(\d{1,4})(?:\D|$)/);
  return match ? Number(match[1]) : fallback;
}

// Dotted extension set for path.extname comparisons, from the dotless settings list.
function scanExtensionSet(settings: AudiobookSettings) {
  return new Set(settings.scan_extensions.map((extension) => `.${extension}`));
}

function discNumberFromFolderName(folderName: string) {
  const match = folderName.match(/^(?:cd|disc|disk)\s*(\d+)$/i);
  return match ? Number(match[1]) : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(stringValue).find((item): item is string => Boolean(item)) ?? null;
  }
  return null;
}

function firstNativeString(metadata: IAudioMetadata | null, tagNames: string[]) {
  if (!metadata) {
    return null;
  }

  const wanted = new Set(tagNames.map((tag) => tag.toLowerCase()));
  for (const tags of Object.values(metadata.native)) {
    for (const tag of tags) {
      if (wanted.has(tag.id.toLowerCase())) {
        const value = stringValue(tag.value);
        if (value) {
          return value;
        }
      }
    }
  }

  return null;
}

function splitNames(values: Array<string | null | undefined>) {
  const names = values
    .flatMap((value) => (value ?? "").split(/\s*(?:,|;|\s+&\s+)\s*/))
    .map((value) => value.trim())
    .filter(Boolean);
  return Array.from(new Set(names));
}

function splitTagValues(values: Array<string | string[] | null | undefined>) {
  return Array.from(new Set(values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .flatMap((value) => (value ?? "").split(/\s*(?:,|;)\s*/))
    .map((value) => value.trim())
    .filter(Boolean)));
}

function firstComment(metadata: IAudioMetadata | null) {
  if (!metadata) {
    return null;
  }

  return metadata.common.longDescription
    ?? metadata.common.description?.find(Boolean)
    ?? metadata.common.comment?.map((comment) => comment.text?.trim()).find(Boolean)
    ?? null;
}

function scanFileFingerprint(file: AudioFileEntry) {
  return {
    size: file.stat.size,
    modifiedAt: file.stat.mtime.toISOString()
  };
}

function existingFilesAreCurrent(files: AudioFileEntry[], existingFiles: ExistingBookFileRow[]) {
  if (files.length !== existingFiles.length) {
    return false;
  }

  const existingByPath = new Map(existingFiles.map((file) => [file.relative_path, file]));
  return files.every((file) => {
    const existing = existingByPath.get(file.relativePath);
    const fingerprint = scanFileFingerprint(file);
    return Boolean(
      existing
      && existing.size === fingerprint.size
      && existing.modified_at === fingerprint.modifiedAt
    );
  });
}

function preparedFilesFromExisting(files: AudioFileEntry[], existingFiles: ExistingBookFileRow[]) {
  const existingByPath = new Map(existingFiles.map((file) => [file.relative_path, file]));
  return files
    .map((file, index) => {
      const existing = existingByPath.get(file.relativePath);
      const extension = path.extname(file.fileName).toLowerCase();
      const fingerprint = scanFileFingerprint(file);
      return {
        relativePath: file.relativePath,
        mimeType: existing?.mime_type ?? mimeFromExtension(extension),
        trackNumber: existing?.track_number ?? trackNumberFromFileName(file.fileName, index + 1),
        chapterTitle: existing?.chapter_title ?? path.basename(file.fileName, extension),
        durationSeconds: existing?.duration_seconds ?? null,
        size: fingerprint.size,
        modifiedAt: fingerprint.modifiedAt,
        contentHash: existing?.content_hash ?? null
      };
    })
    .sort((left, right) => left.trackNumber - right.trackNumber || left.relativePath.localeCompare(right.relativePath, undefined, { numeric: true }));
}

type SidecarStringField = "title" | "subtitle" | "description" | "publisher" | "isbn" | "asin" | "language";

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const match = value.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : undefined;
}

function yearValue(value: unknown): number | undefined {
  const year = numberValue(value);
  return year && year > 0 ? Math.trunc(year) : undefined;
}

function applyStringField(target: SidecarMetadata, key: SidecarStringField, value: unknown) {
  const text = stringValue(value);
  if (text) {
    target[key] = text;
  }
}

function seriesValue(value: unknown): { name?: string; position?: number } {
  if (Array.isArray(value)) {
    for (const item of value) {
      const series = seriesValue(item);
      if (series.name) {
        return series;
      }
    }
    return {};
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const name = stringValue(record.name)
      ?? stringValue(record.title)
      ?? stringValue(record.seriesName)
      ?? stringValue(record.series);
    const position = numberValue(record.sequence)
      ?? numberValue(record.position)
      ?? numberValue(record.seriesPosition);
    return {
      ...(name ? { name } : {}),
      ...(position !== undefined ? { position } : {})
    };
  }

  const raw = stringValue(value);
  if (!raw) return {};
  const match = raw.match(/^(.+?)\s*#\s*(\d+(?:\.\d+)?)\s*$/);
  if (match) {
    return { name: match[1].trim(), position: parseFloat(match[2]) };
  }
  return { name: raw };
}

function normaliseSidecar(raw: Record<string, unknown>): SidecarMetadata {
  const isAbs = typeof raw.authorName === "string" || typeof raw.narratorName === "string";
  if (!isAbs) {
    const result: SidecarMetadata = {};
    applyStringField(result, "title", raw.title);
    applyStringField(result, "subtitle", raw.subtitle);
    applyStringField(result, "description", raw.description);
    applyStringField(result, "publisher", raw.publisher);
    applyStringField(result, "isbn", raw.isbn);
    applyStringField(result, "asin", raw.asin);
    applyStringField(result, "language", raw.language);

    const authors = sidecarArray(raw.authors);
    if (authors.length > 0) result.authors = authors;
    const narrators = sidecarArray(raw.narrators);
    if (narrators.length > 0) result.narrators = narrators;
    const genres = sidecarArray(raw.genres);
    if (genres.length > 0) result.genres = genres;

    const year = yearValue(raw.year);
    if (year !== undefined) result.year = year;
    const yearPublished = yearValue(raw.yearPublished);
    if (yearPublished !== undefined) result.yearPublished = yearPublished;

    const series = seriesValue(raw.series);
    if (series.name) result.series = series.name;
    const seriesName = seriesValue(raw.seriesName);
    if (seriesName.name) result.seriesName = seriesName.name;
    const seriesPosition = numberValue(raw.seriesPosition)
      ?? seriesName.position
      ?? series.position
      ?? numberValue(raw.sequence);
    if (seriesPosition !== undefined) result.seriesPosition = seriesPosition;

    return result;
  }

  const result: SidecarMetadata = {};
  applyStringField(result, "title", raw.title);
  applyStringField(result, "subtitle", raw.subtitle);
  applyStringField(result, "description", raw.description);
  applyStringField(result, "language", raw.language);
  applyStringField(result, "isbn", raw.isbn);
  applyStringField(result, "asin", raw.asin);

  if (typeof raw.authorName === "string" && raw.authorName.trim()) {
    result.authors = splitTagValues([raw.authorName]);
  }
  if (typeof raw.narratorName === "string" && raw.narratorName.trim()) {
    result.narrators = splitTagValues([raw.narratorName]);
  }

  if (raw.publishedYear != null) {
    const y = yearValue(raw.publishedYear);
    if (y !== undefined) result.year = y;
  } else if (typeof raw.publishedDate === "string") {
    const m = raw.publishedDate.match(/\d{4}/);
    if (m) result.year = Number(m[0]);
  }

  const genres = sidecarArray(raw.genres);
  if (genres.length > 0) result.genres = genres;

  const series = seriesValue(raw.series);
  if (series.name) result.series = series.name;
  if (series.position !== undefined) {
    result.seriesPosition = series.position;
  }

  if (result.seriesPosition === undefined && raw.sequence != null) {
    const pos = numberValue(raw.sequence);
    if (pos !== undefined) result.seriesPosition = pos;
  }

  return result;
}

function readSidecarMetadata(folderPath: string) {
  const filePath = path.join(folderPath, "metadata.json");
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return null;
  }

  try {
    return normaliseSidecar(JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>);
  } catch {
    return null;
  }
}

function sidecarArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }
  if (typeof value === "string" && value.trim()) {
    return splitTagValues([value]);
  }
  return [];
}

function yearFromMetadata(metadata: IAudioMetadata | null) {
  if (!metadata) {
    return null;
  }

  const directYear = metadata.common.year ?? metadata.common.originalyear;
  if (directYear) {
    return directYear;
  }

  const date = metadata.common.date ?? metadata.common.originaldate ?? metadata.common.releasedate;
  const match = date?.match(/\d{4}/);
  return match ? Number(match[0]) : null;
}

function numberFromTag(value: string | null) {
  if (!value) {
    return null;
  }

  const match = value.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function primaryPublisher(metadata: IAudioMetadata | null) {
  return metadata?.common.publisher?.find(Boolean)
    ?? metadata?.common.label?.find(Boolean)
    ?? firstNativeString(metadata, ["tpub", "publisher"])
    ?? null;
}

async function safeParseAudio(filePath: string, includeCover: boolean) {
  try {
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000));
    const parse = parseFile(filePath, {
      duration: true,
      skipCovers: !includeCover
    });
    return await Promise.race([parse, timeout]);
  } catch {
    return null;
  }
}


function findFolderCover(folderPath: string, settings: AudiobookSettings) {
  const coverNames = settings.cover_filenames?.length ? settings.cover_filenames : ["cover", "folder", "artwork"];
  const wanted = new Set(coverNames.flatMap((name) => {
    const base = name.trim().toLowerCase();
    const parsedExtension = path.extname(base);
    return parsedExtension ? [base] : imageExtensions.map((extension) => `${base}${extension}`);
  }));

  let fallback: { filePath: string; size: number } | null = null;

  for (const entry of fs.readdirSync(folderPath, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!imageExtensions.includes(ext)) continue;
    const filePath = path.join(folderPath, entry.name);
    if (wanted.has(entry.name.toLowerCase())) {
      return filePath;
    }
    const size = fs.statSync(filePath).size;
    if (!fallback || size > fallback.size) {
      fallback = { filePath, size };
    }
  }

  return fallback?.filePath ?? null;
}

export async function writeCoverImages(libraryId: string, bookId: string, source: string | Buffer) {
  const coverStorageKey = thumbnailStorageKey(libraryId, bookId, `${bookId}-cover.webp`);
  const largeStorageKey = thumbnailStorageKey(libraryId, bookId, `${bookId}-cover-large.webp`);
  const coverPath = thumbnailAbsolutePath(coverStorageKey);
  const largePath = thumbnailAbsolutePath(largeStorageKey);

  fs.mkdirSync(path.dirname(coverPath), { recursive: true });
  fs.mkdirSync(path.dirname(largePath), { recursive: true });

  await Promise.all([
    sharp(source).resize(300, 300, { fit: "cover" }).webp({ quality: 82 }).toFile(coverPath),
    sharp(source).resize(600, 600, { fit: "cover" }).webp({ quality: 86 }).toFile(largePath)
  ]);

  return coverStorageKey;
}

async function generateCover(libraryId: string, bookId: string, folderPath: string, settings: AudiobookSettings, firstMetadata: IAudioMetadata | null) {
  try {
    const folderCover = findFolderCover(folderPath, settings);
    if (folderCover) {
      return await writeCoverImages(libraryId, bookId, folderCover);
    }

    const embeddedCover = firstMetadata?.common.picture?.[0]?.data;
    if (embeddedCover) {
      return await writeCoverImages(libraryId, bookId, Buffer.from(embeddedCover));
    }
  } catch {
    return null;
  }

  return null;
}

export async function walkAudiobookFiles(rootPath: string, settings: AudiobookSettings, groupingMode: GroupingMode = "folder_hierarchy") {
  const extensions = scanExtensionSet(settings);
  const filesByBookFolder = new Map<string, AudioFileEntry[]>();

  const walk = async (currentPath: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(entries.map(async (entry) => {
      const absolutePath = path.join(currentPath, entry.name);

      if (entry.isSymbolicLink()) {
        try {
          const real = await fs.promises.realpath(absolutePath);
          if (!real.startsWith(`${rootPath}${path.sep}`)) return;
        } catch {
          return;
        }
      }

      if (entry.isDirectory()) {
        await walk(absolutePath);
        return;
      }

      if (!entry.isFile()) return;

      const extension = path.extname(entry.name).toLowerCase();
      if (!extensions.has(extension)) return;

      const folderPath = path.dirname(absolutePath);
      const discHint = discNumberFromFolderName(path.basename(folderPath));
      const relativePath = normaliseRelativePath(path.relative(rootPath, absolutePath));
      let bookFolderPath: string;
      if (groupingMode === "top_level_folder") {
        // The first path segment under the root is the book; files directly in the
        // root group under the root itself.
        const topSegment = relativePath.split("/")[0];
        bookFolderPath = relativePath.includes("/") ? path.join(rootPath, topSegment) : rootPath;
      } else {
        bookFolderPath = discHint ? path.dirname(folderPath) : folderPath;
      }

      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(absolutePath);
      } catch {
        return;
      }

      const existing = filesByBookFolder.get(bookFolderPath) ?? [];
      existing.push({ absolutePath, fileName: entry.name, relativePath, stat, discHint });
      filesByBookFolder.set(bookFolderPath, existing);
    }));
  };

  await walk(rootPath);
  return filesByBookFolder;
}

function readBookFolderFiles(rootPath: string, folderAbsolutePath: string, settings: AudiobookSettings, groupingMode: GroupingMode = "folder_hierarchy"): AudioFileEntry[] {
  const extensions = scanExtensionSet(settings);
  const files: AudioFileEntry[] = [];

  const scanDir = (dir: string, discHint: number | null) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const hint = discNumberFromFolderName(entry.name);
        // top_level_folder: every nested folder belongs to this book, not just
        // disc-named ones (disc names still provide track-ordering hints).
        if (hint !== null || groupingMode === "top_level_folder") {
          scanDir(absolutePath, hint);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (!extensions.has(extension)) continue;
      const relativePath = normaliseRelativePath(path.relative(rootPath, absolutePath));
      files.push({ absolutePath, fileName: entry.name, relativePath, stat: fs.statSync(absolutePath), discHint });
    }
  };

  scanDir(folderAbsolutePath, null);
  return files;
}

interface DocumentEntry {
  relativePath: string;
  format: string;
  mimeType: string;
  size: number;
}

// Collect companion documents (PDF/EPUB/…) anywhere inside a book's folder.
function readBookFolderDocuments(rootPath: string, folderAbsolutePath: string): DocumentEntry[] {
  const documents: DocumentEntry[] = [];

  const scanDir = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (!documentExtensions.has(extension)) continue;
      let size = 0;
      try {
        size = fs.statSync(absolutePath).size;
      } catch {
        continue;
      }
      documents.push({
        relativePath: normaliseRelativePath(path.relative(rootPath, absolutePath)),
        format: extension.slice(1),
        mimeType: documentMimeTypes[extension],
        size
      });
    }
  };

  scanDir(folderAbsolutePath);
  return documents;
}

// Sidecar values take precedence over audio tags, so the encoding fix must also
// repair mojibake stored inside a metadata.json (e.g. "title": "wap-version ÌÄÑ").
function repairSidecar(sidecar: SidecarMetadata | null, encoding: TagEncoding | undefined): SidecarMetadata | null {
  if (!sidecar || !encoding) {
    return sidecar;
  }
  const fix = (value: string | undefined) => (value == null ? value : repairEncoding(value, encoding) ?? value);
  return {
    ...sidecar,
    title: fix(sidecar.title),
    subtitle: fix(sidecar.subtitle),
    description: fix(sidecar.description),
    publisher: fix(sidecar.publisher),
    language: fix(sidecar.language),
    series: fix(sidecar.series),
    seriesName: fix(sidecar.seriesName),
    authors: sidecar.authors ? repairList(sidecar.authors, encoding) : sidecar.authors,
    narrators: sidecar.narrators ? repairList(sidecar.narrators, encoding) : sidecar.narrators,
    genres: sidecar.genres ? repairList(sidecar.genres, encoding) : sidecar.genres
  };
}

// Per-source metadata candidate. Merged first-wins in scan_sources priority order;
// null/empty fields fall through to the next source.
interface SourceCandidate {
  title?: string | null;
  description?: string | null;
  year?: number | null;
  language?: string | null;
  isbn?: string | null;
  asin?: string | null;
  publisher?: string | null;
  authors?: string[];
  narrators?: string[];
  genres?: string[];
  seriesName?: string | null;
  seriesPosition?: number | null;
}

function mergeCandidate(target: SourceCandidate, candidate: SourceCandidate) {
  target.title = target.title ?? candidate.title ?? null;
  target.description = target.description ?? candidate.description ?? null;
  target.year = target.year ?? candidate.year ?? null;
  target.language = target.language || candidate.language || null;
  target.isbn = target.isbn ?? candidate.isbn ?? null;
  target.asin = target.asin ?? candidate.asin ?? null;
  target.publisher = target.publisher ?? candidate.publisher ?? null;
  target.seriesName = target.seriesName ?? candidate.seriesName ?? null;
  target.seriesPosition = target.seriesPosition ?? candidate.seriesPosition ?? null;
  if (!target.authors?.length && candidate.authors?.length) target.authors = candidate.authors;
  if (!target.narrators?.length && candidate.narrators?.length) target.narrators = candidate.narrators;
  if (!target.genres?.length && candidate.genres?.length) target.genres = candidate.genres;
}

async function prepareBookScan(
  libraryId: string,
  rootPath: string,
  config: EffectiveScanConfig,
  folderAbsolutePath: string,
  files: AudioFileEntry[]
): Promise<PreparedBookScan> {
  const { settings, sources, tagEncoding: enc, forceReread } = config;
  const folderPath = normaliseRelativePath(path.relative(rootPath, folderAbsolutePath)) || ".";
  const existingBook = db.prepare("SELECT id FROM books WHERE library_id = ? AND folder_path = ?")
    .get(libraryId, folderPath) as { id: string } | undefined;
  const bookId = existingBook?.id ?? nanoid(16);
  const metadataRow = db.prepare("SELECT source, cover_storage_key FROM book_metadata WHERE book_id = ?")
    .get(bookId) as { source: "scan" | "manual"; cover_storage_key: string | null } | undefined;
  const manualMetadata = metadataRow?.source === "manual";
  const titleHint = path.basename(folderAbsolutePath);
  // In top-level grouping the parent of every book folder is the library root, which
  // is not an author name; same when the book is the root itself.
  const authorHint = config.groupingMode === "top_level_folder" || folderPath === "."
    ? null
    : path.basename(path.dirname(folderAbsolutePath));
  const fileMetaEnabled = sourceEnabled(sources, "file_metadata");
  const sidecar = sourceEnabled(sources, "metadata_files") && !manualMetadata
    ? repairSidecar(readSidecarMetadata(folderAbsolutePath), enc)
    : null;

  const filesWithFallbackOrder = files
    .sort((left, right) => {
      const discCompare = (left.discHint ?? 0) - (right.discHint ?? 0);
      return discCompare || left.relativePath.localeCompare(right.relativePath, undefined, { numeric: true });
    });

  if (existingBook && metadataRow && !sidecar && !forceReread) {
    const existingFiles = db.prepare(`
      SELECT relative_path, mime_type, track_number, chapter_title, duration_seconds, size, modified_at, content_hash
      FROM book_files
      WHERE book_id = ?
        AND deleted_at IS NULL
    `).all(bookId) as ExistingBookFileRow[];
    if (existingFilesAreCurrent(filesWithFallbackOrder, existingFiles)) {
      return {
        bookId,
        folderAbsolutePath,
        folderPath,
        manualMetadata,
        title: titleHint,
        sortTitle: sortTitle(titleHint),
        description: null,
        yearPublished: null,
        language: settings.default_language || "en",
        durationSeconds: null,
        coverStorageKey: null,
        isbn: null,
        asin: null,
        publisher: null,
        authors: [],
        narrators: [],
        genres: [],
        seriesName: null,
        seriesPosition: null,
        skipMetadataUpdate: true,
        files: preparedFilesFromExisting(filesWithFallbackOrder, existingFiles),
        documents: readBookFolderDocuments(rootPath, folderAbsolutePath)
      };
    }
  }

  // Parse all files in parallel even when file metadata is disabled — durations and
  // format info still come from here. Only descriptive tag fields are gated below.
  // First file gets cover extraction, rest skip it.
  const parsedMetadata = await Promise.all(
    filesWithFallbackOrder.map((file, index) =>
      safeParseAudio(file.absolutePath, index === 0 && !manualMetadata && fileMetaEnabled)
    )
  );

  const firstMetadata = parsedMetadata[0] ?? null;
  const common = firstMetadata?.common;

  // One metadata candidate per enabled source; merged below in priority order.
  const candidates = new Map<MetadataSourceId, SourceCandidate>();

  if (sidecar) {
    candidates.set("metadata_files", {
      title: sidecar.title?.trim() || null,
      description: sidecar.description ?? null,
      year: sidecar.yearPublished ?? sidecar.year ?? null,
      language: sidecar.language ?? null,
      isbn: sidecar.isbn ?? null,
      asin: sidecar.asin ?? null,
      publisher: sidecar.publisher ?? null,
      authors: sidecarArray(sidecar.authors),
      narrators: sidecarArray(sidecar.narrators),
      genres: sidecarArray(sidecar.genres),
      seriesName: sidecar.seriesName ?? sidecar.series ?? null,
      seriesPosition: sidecar.seriesPosition ?? null
    });
  }

  if (fileMetaEnabled) {
    const tagTitle = stringValue(common?.album)
      || stringValue(common?.title)
      || firstNativeString(firstMetadata, ["album", "title"]);
    candidates.set("file_metadata", {
      title: repairEncoding(tagTitle, enc),
      description: repairEncoding(firstComment(firstMetadata), enc),
      year: yearFromMetadata(firstMetadata),
      language: common?.language ?? null,
      isbn: firstNativeString(firstMetadata, ["isbn", "ISBN"]),
      asin: common?.asin ?? firstNativeString(firstMetadata, ["asin", "audible_asin", "AUDIBLE_ASIN"]),
      publisher: repairEncoding(primaryPublisher(firstMetadata), enc),
      authors: repairList(splitNames([
        ...(common?.albumartists ?? []),
        common?.albumartist,
        ...(common?.artists ?? []),
        common?.artist
      ]), enc),
      narrators: repairList(splitNames(common?.composer ?? []), enc),
      genres: repairList(splitTagValues(common?.genre ?? []), enc),
      seriesName: repairEncoding(stringValue(common?.grouping) || firstNativeString(firstMetadata, ["series", "SERIES"]), enc),
      seriesPosition: numberFromTag(firstNativeString(firstMetadata, ["series-part", "series_part", "PART"]))
    });
  }

  if (sourceEnabled(sources, "folder_structure")) {
    // Folder names supply the book title; per-track titles come from file names
    // (handled in the chapter-title pick below).
    candidates.set("folder_structure", { title: titleHint });
  }

  const merged: SourceCandidate = {};
  for (const source of sources) {
    if (!source.enabled) continue;
    const candidate = candidates.get(source.id);
    if (candidate) mergeCandidate(merged, candidate);
  }

  const coverStorageKey = manualMetadata
    ? null
    : await generateCover(libraryId, bookId, folderAbsolutePath, settings, fileMetaEnabled ? firstMetadata : null);

  const fileSortData = filesWithFallbackOrder.map((file, index) => {
    const metadata = parsedMetadata[index];
    const extension = path.extname(file.fileName).toLowerCase();
    const discNumber = (fileMetaEnabled ? metadata?.common.disk.no : null) ?? file.discHint ?? 0;
    const taggedTrack = fileMetaEnabled ? metadata?.common.track.no ?? null : null;
    return {
      file,
      metadata,
      extension,
      sortDisc: discNumber,
      sortTrack: taggedTrack ?? trackNumberFromFileName(file.fileName, index + 1)
    };
  });

  // Chapter titles obey the same source priority: tag title (file_metadata) vs file
  // name (folder_structure); file name is also the always-on fallback.
  const pickChapterTitle = (tagTitle: string | null, fileNameTitle: string) => {
    for (const source of sources) {
      if (!source.enabled) continue;
      if (source.id === "file_metadata" && tagTitle) return tagTitle;
      if (source.id === "folder_structure") return fileNameTitle;
    }
    return fileNameTitle;
  };

  const preparedFiles = fileSortData
    .sort((left, right) => (
      left.sortDisc - right.sortDisc
      || left.sortTrack - right.sortTrack
      || left.file.relativePath.localeCompare(right.file.relativePath, undefined, { numeric: true })
    ))
    .map((item, index) => ({
      relativePath: item.file.relativePath,
      mimeType: mimeFromExtension(item.extension),
      trackNumber: index + 1,
      chapterTitle: pickChapterTitle(
        fileMetaEnabled ? repairEncoding(item.metadata?.common.title?.trim() || null, enc) : null,
        path.basename(item.file.fileName, item.extension)
      ),
      durationSeconds: item.metadata?.format.duration ? Math.round(item.metadata.format.duration) : null,
      size: item.file.stat.size,
      modifiedAt: item.file.stat.mtime.toISOString(),
      contentHash: null
    }));
  const totalDuration = preparedFiles.reduce((total, file) => total + (file.durationSeconds ?? 0), 0);

  const title = merged.title || titleHint;
  const scannedAuthors = merged.authors?.length ? merged.authors : (authorHint ? [authorHint] : []);

  return {
    bookId,
    folderAbsolutePath,
    folderPath,
    manualMetadata,
    title,
    sortTitle: sortTitle(title),
    description: merged.description ?? null,
    yearPublished: merged.year ?? null,
    language: merged.language || settings.default_language || "en",
    durationSeconds: totalDuration > 0 ? totalDuration : null,
    coverStorageKey,
    isbn: merged.isbn ?? null,
    asin: merged.asin ?? null,
    publisher: merged.publisher ?? null,
    authors: scannedAuthors,
    narrators: merged.narrators ?? [],
    // Always split genres on comma/semicolon into separate tags. Sidecars can
    // deliver a single array element holding a combined string (e.g. "Diets,
    // Nutrition & Healthy Eating, Alternative & Complementary Medicine"), which
    // sidecarArray leaves intact; splitTagValues breaks it apart (keeping "&").
    genres: splitTagValues(merged.genres ?? []),
    seriesName: merged.seriesName ?? null,
    seriesPosition: merged.seriesPosition ?? null,
    skipMetadataUpdate: false,
    files: preparedFiles,
    documents: readBookFolderDocuments(rootPath, folderAbsolutePath)
  };
}

// Map a scanned name through the merge alias table so renamed/merged people stay
// merged across rescans (e.g. "A.G. Riddle" -> "A. G. Riddle").
function resolvePersonName(name: string): string {
  const row = db.prepare("SELECT canonical_name FROM person_aliases WHERE alias = ?")
    .get(name.trim()) as { canonical_name: string } | undefined;
  return row ? row.canonical_name : name;
}

function upsertAuthor(libraryId: string, name: string) {
  const resolved = resolvePersonName(name);
  db.prepare("INSERT OR IGNORE INTO authors (id, library_id, name, sort_name) VALUES (?, ?, ?, ?)")
    .run(nanoid(16), libraryId, resolved, sortTitle(resolved));
  return db.prepare("SELECT id FROM authors WHERE library_id = ? AND name = ?")
    .get(libraryId, resolved) as { id: string };
}


function upsertSeries(libraryId: string, name: string) {
  db.prepare("INSERT OR IGNORE INTO series (id, library_id, name, sort_name) VALUES (?, ?, ?, ?)")
    .run(nanoid(16), libraryId, name, sortTitle(name));
  return db.prepare("SELECT id FROM series WHERE library_id = ? AND name = ?")
    .get(libraryId, name) as { id: string };
}

function writeBookScan(libraryId: string, book: PreparedBookScan) {
  const existingBook = db.prepare("SELECT id FROM books WHERE id = ?").get(book.bookId);

  if (existingBook) {
    db.prepare(`
      UPDATE books
      SET status = 'ready', updated_at = CURRENT_TIMESTAMP, deleted_at = NULL
      WHERE id = ?
    `).run(book.bookId);
  } else {
    db.prepare(`
      INSERT INTO books (id, library_id, folder_path, status)
      VALUES (?, ?, ?, 'ready')
    `).run(book.bookId, libraryId, book.folderPath);
  }

  if (!book.skipMetadataUpdate) {
    const categoryId = matchCategoryId(book.genres);
    db.prepare(`
      INSERT INTO book_metadata (
        id, book_id, source, title, sort_title, description, year_published, language,
        duration_seconds, cover_storage_key, isbn, asin, publisher, category_id
      )
      VALUES (?, ?, 'scan', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(book_id) DO UPDATE SET
        title = CASE WHEN book_metadata.source = 'manual' THEN book_metadata.title ELSE excluded.title END,
        sort_title = CASE WHEN book_metadata.source = 'manual' THEN book_metadata.sort_title ELSE excluded.sort_title END,
        description = CASE WHEN book_metadata.source = 'manual' THEN book_metadata.description ELSE excluded.description END,
        year_published = CASE WHEN book_metadata.source = 'manual' THEN book_metadata.year_published ELSE excluded.year_published END,
        language = CASE WHEN book_metadata.source = 'manual' THEN book_metadata.language ELSE excluded.language END,
        duration_seconds = excluded.duration_seconds,
        cover_storage_key = CASE
          WHEN book_metadata.source = 'manual' THEN book_metadata.cover_storage_key
          ELSE COALESCE(excluded.cover_storage_key, book_metadata.cover_storage_key)
        END,
        isbn = CASE WHEN book_metadata.source = 'manual' THEN book_metadata.isbn ELSE excluded.isbn END,
        asin = CASE WHEN book_metadata.source = 'manual' THEN book_metadata.asin ELSE excluded.asin END,
        publisher = CASE WHEN book_metadata.source = 'manual' THEN book_metadata.publisher ELSE excluded.publisher END,
        category_id = CASE WHEN book_metadata.source = 'manual' THEN book_metadata.category_id ELSE excluded.category_id END,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      nanoid(16),
      book.bookId,
      book.title,
      book.sortTitle,
      book.description,
      book.yearPublished,
      book.language,
      book.durationSeconds,
      book.coverStorageKey,
      book.isbn,
      book.asin,
      book.publisher,
      categoryId
    );
  }

  if (!book.manualMetadata && !book.skipMetadataUpdate) {
    if (book.seriesName) {
      const series = upsertSeries(libraryId, book.seriesName);
      db.prepare("UPDATE books SET series_id = ?, series_position = ? WHERE id = ?")
        .run(series.id, book.seriesPosition, book.bookId);
    } else {
      db.prepare("UPDATE books SET series_id = NULL, series_position = NULL WHERE id = ?").run(book.bookId);
    }

    db.prepare("DELETE FROM book_authors WHERE book_id = ? AND role IN ('author', 'narrator')").run(book.bookId);
    book.authors.forEach((authorName, index) => {
      const author = upsertAuthor(libraryId, authorName);
      db.prepare(`
        INSERT INTO book_authors (book_id, author_id, role, sort_order)
        VALUES (?, ?, 'author', ?)
      `).run(book.bookId, author.id, index);
    });
    book.narrators.forEach((narratorName, index) => {
      const narrator = upsertAuthor(libraryId, narratorName);
      db.prepare(`
        INSERT INTO book_authors (book_id, author_id, role, sort_order)
        VALUES (?, ?, 'narrator', ?)
      `).run(book.bookId, narrator.id, index);
    });

    // Raw genres become global, freeform tags (the descriptive layer); the primary
    // category is derived from them above.
    setEntityTags("book", book.bookId, book.genres);
  }

  db.prepare("UPDATE book_files SET status = 'missing', deleted_at = CURRENT_TIMESTAMP WHERE book_id = ?").run(book.bookId);
  for (const file of book.files) {
    db.prepare(`
      INSERT INTO book_files (
        id, book_id, relative_path, mime_type, track_number, chapter_title, duration_seconds,
        size, modified_at, content_hash, status, deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', NULL)
      ON CONFLICT(book_id, relative_path) DO UPDATE SET
        mime_type = excluded.mime_type,
        track_number = excluded.track_number,
        chapter_title = excluded.chapter_title,
        duration_seconds = excluded.duration_seconds,
        size = excluded.size,
        modified_at = excluded.modified_at,
        content_hash = excluded.content_hash,
        status = 'available',
        deleted_at = NULL,
        updated_at = CURRENT_TIMESTAMP
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
  }

  // Companion documents — re-synced from disk on every scan, like book_files.
  db.prepare("UPDATE book_documents SET status = 'missing', deleted_at = CURRENT_TIMESTAMP WHERE book_id = ?").run(book.bookId);
  for (const doc of book.documents) {
    db.prepare(`
      INSERT INTO book_documents (id, book_id, relative_path, format, mime_type, size, status, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, 'available', NULL)
      ON CONFLICT(book_id, relative_path) DO UPDATE SET
        format = excluded.format,
        mime_type = excluded.mime_type,
        size = excluded.size,
        status = 'available',
        deleted_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    `).run(nanoid(16), book.bookId, doc.relativePath, doc.format, doc.mimeType, doc.size);
  }
}

export async function scanAudiobookLibrary(libraryId: string, jobId: string | null = null, options: ScanOptions = {}) {
  const library = db.prepare("SELECT id, source_path, settings_json FROM libraries WHERE id = ? AND type = 'audiobook'")
    .get(libraryId) as { id: string; source_path: string; settings_json: string } | undefined;
  if (!library) {
    throw new Error("Audiobook library not found.");
  }

  const rootPath = validateLibrarySource(library.source_path);
  const config = resolveScanConfig(library.settings_json, options);
  db.prepare("UPDATE libraries SET scan_status = 'scanning', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(libraryId);

  const filesByFolder = await walkAudiobookFiles(rootPath, config.settings, config.groupingMode);
  const entries = [...filesByFolder.entries()];
  const booksTotal = entries.length;
  const foundFolders = new Set<string>();
  let discoveredBooks = 0;
  let discoveredFiles = 0;
  let booksProcessed = 0;
  const bookErrors: string[] = [];
  let cancelled = false;
  let lastProgressUpdate = 0;

  const updateProgress = () => {
    if (!jobId) return;
    const now = Date.now();
    if (now - lastProgressUpdate < 3000 && booksProcessed % 5 !== 0) return;
    lastProgressUpdate = now;
    db.prepare("UPDATE jobs SET payload = ? WHERE id = ?").run(
      JSON.stringify({ libraryId, progress: { booksProcessed, booksTotal } }),
      jobId
    );
  };

  const CONCURRENCY = 4;
  let index = 0;

  const worker = async () => {
    while (!cancelled) {
      const i = index++;
      if (i >= entries.length) break;

      if (jobId) {
        const job = db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string } | undefined;
        if (job?.status === "failed") {
          cancelled = true;
          break;
        }
      }

      const [folderAbsolutePath, files] = entries[i];
      try {
        const book = await prepareBookScan(libraryId, rootPath, config, folderAbsolutePath, files);
        db.transaction(() => writeBookScan(libraryId, book))();
        foundFolders.add(book.folderPath);
        discoveredBooks += 1;
        discoveredFiles += book.files.length;
      } catch (err) {
        const folder = folderAbsolutePath.replace(rootPath, "").replace(/^[\\/]/, "") || folderAbsolutePath;
        const msg = err instanceof Error ? err.message : String(err);
        bookErrors.push(`${folder}: ${msg}`);
      }

      booksProcessed++;
      updateProgress();
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  };

  if (entries.length > 0) {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker));
  }

  if (cancelled) {
    db.prepare("UPDATE libraries SET scan_status = 'error', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(libraryId);
    throw new Error("Job cancelled");
  }

  if (bookErrors.length > 0 && discoveredBooks === 0) {
    db.prepare("UPDATE libraries SET scan_status = 'error', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(libraryId);
    throw new Error(`All books failed to scan:\n${bookErrors.join("\n")}`);
  }

  db.transaction(() => {
    const knownBooks = db.prepare("SELECT id, folder_path FROM books WHERE library_id = ? AND deleted_at IS NULL")
      .all(libraryId) as { id: string; folder_path: string }[];
    for (const book of knownBooks) {
      if (!foundFolders.has(book.folder_path)) {
        db.prepare("UPDATE books SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(book.id);
        db.prepare("UPDATE book_files SET status = 'missing', deleted_at = CURRENT_TIMESTAMP WHERE book_id = ?").run(book.id);
        // The book is gone for users — drop its shares so links stop working and
        // owners' share lists stay accurate.
        deleteSharesForResource("audiobook", book.id);
        deleteCollectionItemsForResource("audiobook", book.id);
      }
    }
    db.prepare(`
      UPDATE libraries
      SET scan_status = 'idle', last_scanned_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(libraryId);
  })();

  return { discoveredBooks, discoveredFiles, bookErrors };
}

export async function rescanSingleBook(bookId: string, options: ScanOptions = {}) {
  const row = db.prepare(`
    SELECT books.id, books.folder_path, libraries.id AS library_id, libraries.source_path, libraries.settings_json
    FROM books
    JOIN libraries ON libraries.id = books.library_id
    WHERE books.id = ? AND books.deleted_at IS NULL
  `).get(bookId) as { id: string; folder_path: string; library_id: string; source_path: string; settings_json: string } | undefined;

  if (!row) {
    return null;
  }

  const rootPath = validateLibrarySource(row.source_path);
  const config = resolveScanConfig(row.settings_json, options);
  const folderAbsolutePath = path.join(rootPath, row.folder_path);

  if (!fs.existsSync(folderAbsolutePath)) {
    return null;
  }

  const files = readBookFolderFiles(rootPath, folderAbsolutePath, config.settings, config.groupingMode);
  if (files.length === 0) {
    return null;
  }

  const book = await prepareBookScan(row.library_id, rootPath, config, folderAbsolutePath, files);
  db.transaction(() => writeBookScan(row.library_id, book))();
  return book.bookId;
}

export function enqueueAudiobookScan(libraryId: string, options: ScanOptions = {}) {
  const jobId = nanoid(16);
  db.prepare("UPDATE libraries SET scan_status = 'scanning', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(libraryId);
  db.prepare(`
    INSERT INTO jobs (id, type, payload, status)
    VALUES (?, ?, ?, 'pending')
  `).run(jobId, scanJobType, JSON.stringify({ libraryId, options }));
  return jobId;
}

let queueRunning = false;

export async function processAudiobookScanQueue() {
  if (queueRunning) {
    return;
  }

  queueRunning = true;
  try {
    db.prepare(`
      UPDATE jobs
      SET status = 'pending', locked_at = NULL, locked_by = NULL, error = NULL
      WHERE type = ?
        AND status = 'running'
        AND locked_at IS NOT NULL
        AND datetime(locked_at) < datetime('now', '-30 minutes')
        AND attempts < max_attempts
    `).run(scanJobType);

    while (true) {
      const job = db.prepare(`
        SELECT id, payload, attempts, max_attempts
        FROM jobs
        WHERE type = ?
          AND status = 'pending'
          AND datetime(run_at) <= datetime('now')
        ORDER BY datetime(run_at), datetime(created_at)
        LIMIT 1
      `).get(scanJobType) as { id: string; payload: string; attempts: number; max_attempts: number } | undefined;
      if (!job) {
        break;
      }

      const claimed = db.prepare(`
        UPDATE jobs
        SET status = 'running', attempts = attempts + 1, locked_at = CURRENT_TIMESTAMP, locked_by = ?
        WHERE id = ? AND status = 'pending'
      `).run(process.pid.toString(), job.id);
      if (claimed.changes === 0) {
        continue;
      }

      const payload = JSON.parse(job.payload) as { libraryId: string; options?: ScanOptions };
      try {
        const result = await scanAudiobookLibrary(payload.libraryId, job.id, payload.options ?? {});
        db.prepare(`
          UPDATE jobs
          SET status = 'completed', payload = ?, completed_at = CURRENT_TIMESTAMP, locked_at = NULL, locked_by = NULL
          WHERE id = ?
        `).run(JSON.stringify({ ...payload, result }), job.id);
      } catch (err) {
        const currentStatus = (db.prepare("SELECT status FROM jobs WHERE id = ?").get(job.id) as { status: string } | undefined)?.status;
        if (currentStatus === "failed") {
          db.prepare("UPDATE libraries SET scan_status = 'error', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND scan_status = 'scanning'")
            .run(payload.libraryId);
          continue;
        }
        const message = err instanceof Error
          ? `${err.message}${err.stack ? `\n\nStack:\n${err.stack}` : ""}`
          : "Audiobook scan failed";
        if (job.attempts + 1 < job.max_attempts) {
          const runAt = new Date(Date.now() + Math.min(job.attempts + 1, 5) * 60_000).toISOString();
          db.prepare(`
            UPDATE jobs
            SET status = 'pending', run_at = ?, locked_at = NULL, locked_by = NULL, error = ?
            WHERE id = ?
          `).run(runAt, message, job.id);
        } else {
          db.prepare("UPDATE libraries SET scan_status = 'error', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(payload.libraryId);
          db.prepare(`
            UPDATE jobs
            SET status = 'failed', failed_at = CURRENT_TIMESTAMP, locked_at = NULL, locked_by = NULL, error = ?
            WHERE id = ?
          `).run(message, job.id);
        }
      }
    }
  } finally {
    queueRunning = false;
  }
}

export function startAudiobookScanWorker() {
  const timer = setInterval(() => {
    void processAudiobookScanQueue();
  }, 2000);
  void processAudiobookScanQueue();
  return () => clearInterval(timer);
}
