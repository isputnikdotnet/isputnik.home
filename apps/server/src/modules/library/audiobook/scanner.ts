import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseFile, type IAudioMetadata } from "music-metadata";
import { nanoid } from "nanoid";
import sharp from "sharp";
import { db } from "../../../db.js";
import { normaliseRelativePath, findStorageRootForPath } from "../shared/storage-roots.js";
import { getConfiguredThumbnailPath, thumbnailAbsolutePath, thumbnailStorageKey } from "../shared/thumbnail.js";

export const audioExtensions = new Set([".m4b", ".m4a", ".mp3", ".flac", ".ogg", ".opus", ".aac"]);
const imageExtensions = [".jpg", ".jpeg", ".png", ".webp"];
const scanJobType = "SCAN_AUDIOBOOK_LIBRARY";

interface AudiobookSettings {
  default_language?: string;
  supported_extensions?: string[];
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

export function sortTitle(value: string) {
  return value.replace(/^(the|a|an)\s+/i, "").trim();
}

export function mimeFromExtension(extension: string) {
  return {
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".m4b": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus"
  }[extension] ?? "application/octet-stream";
}

export function trackNumberFromFileName(fileName: string, fallback: number) {
  const match = fileName.match(/^(\d{1,4})(?:\D|$)/);
  return match ? Number(match[1]) : fallback;
}

function normaliseSettings(settingsJson: string): AudiobookSettings {
  try {
    return JSON.parse(settingsJson || "{}") as AudiobookSettings;
  } catch {
    return {};
  }
}

function supportedAudioExtensions(settings: AudiobookSettings) {
  if (!settings.supported_extensions?.length) {
    return audioExtensions;
  }

  return new Set(settings.supported_extensions.map((extension) => {
    const normalised = extension.trim().toLowerCase();
    return normalised.startsWith(".") ? normalised : `.${normalised}`;
  }));
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
      && existing.content_hash
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

function normaliseSidecar(raw: Record<string, unknown>): SidecarMetadata {
  const isAbs = typeof raw.authorName === "string" || typeof raw.narratorName === "string";
  if (!isAbs) {
    return raw as SidecarMetadata;
  }

  const result: SidecarMetadata = {};
  if (typeof raw.title === "string") result.title = raw.title;
  if (typeof raw.subtitle === "string") result.subtitle = raw.subtitle;
  if (typeof raw.description === "string") result.description = raw.description;
  if (typeof raw.language === "string") result.language = raw.language;
  if (typeof raw.isbn === "string") result.isbn = raw.isbn;
  if (typeof raw.asin === "string") result.asin = raw.asin;

  if (typeof raw.authorName === "string" && raw.authorName.trim()) {
    result.authors = splitTagValues([raw.authorName]);
  }
  if (typeof raw.narratorName === "string" && raw.narratorName.trim()) {
    result.narrators = splitTagValues([raw.narratorName]);
  }

  if (raw.publishedYear != null) {
    const y = Math.trunc(Number(raw.publishedYear));
    if (y > 0) result.year = y;
  } else if (typeof raw.publishedDate === "string") {
    const m = raw.publishedDate.match(/\d{4}/);
    if (m) result.year = Number(m[0]);
  }

  if (Array.isArray(raw.genres)) {
    result.genres = raw.genres.filter((g): g is string => typeof g === "string" && g.trim().length > 0);
  }

  if (typeof raw.series === "string" && raw.series.trim()) {
    result.series = raw.series;
  } else if (Array.isArray(raw.series) && raw.series.length > 0) {
    const first = raw.series[0] as Record<string, unknown>;
    if (first && typeof first.name === "string") {
      result.series = first.name;
      const pos = parseFloat(String(first.sequence ?? ""));
      if (!isNaN(pos)) result.seriesPosition = pos;
    }
  }

  if (result.seriesPosition === undefined && raw.sequence != null) {
    const pos = parseFloat(String(raw.sequence));
    if (!isNaN(pos)) result.seriesPosition = pos;
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
    return await parseFile(filePath, {
      duration: true,
      skipCovers: !includeCover,
      includeChapters: true
    });
  } catch {
    return null;
  }
}

async function hashFile(filePath: string) {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function findFolderCover(folderPath: string, settings: AudiobookSettings) {
  const coverNames = settings.cover_filenames?.length ? settings.cover_filenames : ["cover", "folder", "artwork"];
  const wanted = new Set(coverNames.flatMap((name) => {
    const base = name.trim().toLowerCase();
    const parsedExtension = path.extname(base);
    return parsedExtension ? [base] : imageExtensions.map((extension) => `${base}${extension}`);
  }));

  for (const entry of fs.readdirSync(folderPath, { withFileTypes: true })) {
    if (entry.isFile() && wanted.has(entry.name.toLowerCase())) {
      return path.join(folderPath, entry.name);
    }
  }

  return null;
}

export async function writeCoverImages(bookId: string, source: string | Buffer) {
  const coverStorageKey = thumbnailStorageKey(bookId, `${bookId}-cover.webp`);
  const largeStorageKey = thumbnailStorageKey(bookId, `${bookId}-cover-large.webp`);
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

async function generateCover(bookId: string, folderPath: string, settings: AudiobookSettings, firstMetadata: IAudioMetadata | null) {
  try {
    const folderCover = findFolderCover(folderPath, settings);
    if (folderCover) {
      return await writeCoverImages(bookId, folderCover);
    }

    const embeddedCover = firstMetadata?.common.picture?.[0]?.data;
    if (embeddedCover) {
      return await writeCoverImages(bookId, Buffer.from(embeddedCover));
    }
  } catch {
    return null;
  }

  return null;
}

export function validateLibrarySource(sourcePath: string) {
  const resolved = path.resolve(sourcePath);
  const thumbnailPath = getConfiguredThumbnailPath();

  if (!path.isAbsolute(resolved)) {
    throw new Error("Use an absolute server path for the audiobook source.");
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error("Audiobook source path must be an existing directory.");
  }

  const realSource = fs.realpathSync(resolved);
  const allowedRoot = findStorageRootForPath(realSource);
  if (!allowedRoot) {
    throw new Error("Choose a folder inside a configured Digital Library container.");
  }

  const realThumbnailRoot = fs.realpathSync(thumbnailPath);
  if (realSource === realThumbnailRoot || realSource.startsWith(`${realThumbnailRoot}${path.sep}`)) {
    throw new Error("Audiobook source path cannot be inside thumbnail storage.");
  }

  return realSource;
}

export function walkAudiobookFiles(rootPath: string, settings: AudiobookSettings = {}) {
  const extensions = supportedAudioExtensions(settings);
  const filesByBookFolder = new Map<string, AudioFileEntry[]>();

  const walk = (currentPath: string) => {
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isSymbolicLink()) {
        const real = fs.realpathSync(absolutePath);
        if (!real.startsWith(`${rootPath}${path.sep}`)) {
          continue;
        }
      }

      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      if (!extensions.has(extension)) {
        continue;
      }

      const folderPath = path.dirname(absolutePath);
      const discHint = discNumberFromFolderName(path.basename(folderPath));
      const bookFolderPath = discHint ? path.dirname(folderPath) : folderPath;
      const relativePath = normaliseRelativePath(path.relative(rootPath, absolutePath));
      const stat = fs.statSync(absolutePath);
      const files = filesByBookFolder.get(bookFolderPath) ?? [];
      files.push({ absolutePath, fileName: entry.name, relativePath, stat, discHint });
      filesByBookFolder.set(bookFolderPath, files);
    }
  };

  walk(rootPath);
  return filesByBookFolder;
}

function readBookFolderFiles(rootPath: string, folderAbsolutePath: string, settings: AudiobookSettings): AudioFileEntry[] {
  const extensions = supportedAudioExtensions(settings);
  const files: AudioFileEntry[] = [];

  const scanDir = (dir: string, discHint: number | null) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const hint = discNumberFromFolderName(entry.name);
        if (hint !== null) {
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

async function prepareBookScan(
  libraryId: string,
  rootPath: string,
  settings: AudiobookSettings,
  folderAbsolutePath: string,
  files: AudioFileEntry[]
): Promise<PreparedBookScan> {
  const folderPath = normaliseRelativePath(path.relative(rootPath, folderAbsolutePath)) || ".";
  const existingBook = db.prepare("SELECT id FROM books WHERE library_id = ? AND folder_path = ?")
    .get(libraryId, folderPath) as { id: string } | undefined;
  const bookId = existingBook?.id ?? nanoid(16);
  const metadataRow = db.prepare("SELECT source, cover_storage_key FROM book_metadata WHERE book_id = ?")
    .get(bookId) as { source: "scan" | "manual"; cover_storage_key: string | null } | undefined;
  const manualMetadata = metadataRow?.source === "manual";
  const titleHint = path.basename(folderAbsolutePath);
  const authorHint = path.basename(path.dirname(folderAbsolutePath));
  const sidecar = manualMetadata ? null : readSidecarMetadata(folderAbsolutePath);

  const filesWithFallbackOrder = files
    .sort((left, right) => {
      const discCompare = (left.discHint ?? 0) - (right.discHint ?? 0);
      return discCompare || left.relativePath.localeCompare(right.relativePath, undefined, { numeric: true });
    });

  if (existingBook && metadataRow && !sidecar) {
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
        files: preparedFilesFromExisting(filesWithFallbackOrder, existingFiles)
      };
    }
  }

  const parsedMetadata: Array<IAudioMetadata | null> = [];
  for (const [index, file] of filesWithFallbackOrder.entries()) {
    parsedMetadata.push(await safeParseAudio(file.absolutePath, index === 0 && !manualMetadata));
  }

  const firstMetadata = parsedMetadata[0] ?? null;
  const common = firstMetadata?.common;
  const title = common?.album?.trim()
    || common?.title?.trim()
    || firstNativeString(firstMetadata, ["album", "title"])
    || titleHint;
  const authors = splitNames([
    ...(common?.albumartists ?? []),
    common?.albumartist,
    ...(common?.artists ?? []),
    common?.artist
  ]);
  const narrators = splitNames(common?.composer ?? []);
  const genres = splitTagValues(common?.genre ?? []);
  const seriesName = common?.grouping?.trim() || firstNativeString(firstMetadata, ["series", "SERIES"]) || null;
  const seriesPosition = numberFromTag(firstNativeString(firstMetadata, ["series-part", "series_part", "PART"]));
  const isbn = firstNativeString(firstMetadata, ["isbn", "ISBN"]);
  const asin = common?.asin ?? firstNativeString(firstMetadata, ["asin", "audible_asin", "AUDIBLE_ASIN"]);
  const publisher = primaryPublisher(firstMetadata);
  const coverStorageKey = manualMetadata ? null : await generateCover(bookId, folderAbsolutePath, settings, firstMetadata);
  const sidecarAuthors = sidecarArray(sidecar?.authors);
  const sidecarNarrators = sidecarArray(sidecar?.narrators);
  const sidecarGenres = sidecarArray(sidecar?.genres);

  const fileSortData = await Promise.all(filesWithFallbackOrder.map(async (file, index) => {
    const metadata = parsedMetadata[index];
    const extension = path.extname(file.fileName).toLowerCase();
    const discNumber = metadata?.common.disk.no ?? file.discHint ?? 0;
    const taggedTrack = metadata?.common.track.no ?? null;
    return {
      file,
      metadata,
      extension,
      sortDisc: discNumber,
      sortTrack: taggedTrack ?? trackNumberFromFileName(file.fileName, index + 1),
      contentHash: await hashFile(file.absolutePath)
    };
  }));

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
      chapterTitle: item.metadata?.common.title?.trim() || path.basename(item.file.fileName, item.extension),
      durationSeconds: item.metadata?.format.duration ? Math.round(item.metadata.format.duration) : null,
      size: item.file.stat.size,
      modifiedAt: item.file.stat.mtime.toISOString(),
      contentHash: item.contentHash
    }));
  const totalDuration = preparedFiles.reduce((total, file) => total + (file.durationSeconds ?? 0), 0);

  return {
    bookId,
    folderAbsolutePath,
    folderPath,
    manualMetadata,
    title: sidecar?.title?.trim() || title,
    sortTitle: sortTitle(sidecar?.title?.trim() || title),
    description: sidecar?.description ?? firstComment(firstMetadata),
    yearPublished: sidecar?.yearPublished ?? sidecar?.year ?? yearFromMetadata(firstMetadata),
    language: sidecar?.language || common?.language || settings.default_language || "en",
    durationSeconds: totalDuration > 0 ? totalDuration : null,
    coverStorageKey,
    isbn: sidecar?.isbn ?? isbn,
    asin: sidecar?.asin ?? asin,
    publisher: sidecar?.publisher ?? publisher,
    authors: sidecarAuthors.length > 0 ? sidecarAuthors : (authors.length > 0 ? authors : [authorHint]),
    narrators: sidecarNarrators.length > 0 ? sidecarNarrators : narrators,
    genres: sidecarGenres.length > 0 ? sidecarGenres : genres,
    seriesName: sidecar?.seriesName ?? sidecar?.series ?? seriesName,
    seriesPosition: sidecar?.seriesPosition ?? seriesPosition,
    skipMetadataUpdate: false,
    files: preparedFiles
  };
}

function upsertAuthor(libraryId: string, name: string) {
  db.prepare(`
    INSERT INTO authors (id, library_id, name, sort_name)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(library_id, name) DO NOTHING
  `).run(nanoid(16), libraryId, name, sortTitle(name));
  return db.prepare("SELECT id FROM authors WHERE library_id = ? AND name = ?")
    .get(libraryId, name) as { id: string };
}

function upsertGenre(libraryId: string, name: string) {
  db.prepare(`
    INSERT INTO genres (id, library_id, name)
    VALUES (?, ?, ?)
    ON CONFLICT(library_id, name) DO NOTHING
  `).run(nanoid(16), libraryId, name);
  return db.prepare("SELECT id FROM genres WHERE library_id = ? AND name = ?")
    .get(libraryId, name) as { id: string };
}

function upsertSeries(libraryId: string, name: string) {
  db.prepare(`
    INSERT INTO series (id, library_id, name, sort_name)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(library_id, name) DO NOTHING
  `).run(nanoid(16), libraryId, name, sortTitle(name));
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
    db.prepare(`
      INSERT INTO book_metadata (
        id, book_id, source, title, sort_title, description, year_published, language,
        duration_seconds, cover_storage_key, isbn, asin, publisher
      )
      VALUES (?, ?, 'scan', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      book.publisher
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

    db.prepare("DELETE FROM book_genres WHERE book_id = ?").run(book.bookId);
    book.genres.forEach((genreName) => {
      const genre = upsertGenre(libraryId, genreName);
      db.prepare("INSERT INTO book_genres (book_id, genre_id) VALUES (?, ?)").run(book.bookId, genre.id);
    });
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
}

export async function scanAudiobookLibrary(libraryId: string) {
  const library = db.prepare("SELECT id, source_path, settings_json FROM libraries WHERE id = ? AND type = 'audiobook'")
    .get(libraryId) as { id: string; source_path: string; settings_json: string } | undefined;
  if (!library) {
    throw new Error("Audiobook library not found.");
  }

  const rootPath = validateLibrarySource(library.source_path);
  const settings = normaliseSettings(library.settings_json);
  db.prepare("UPDATE libraries SET scan_status = 'scanning', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(libraryId);
  const filesByFolder = walkAudiobookFiles(rootPath, settings);
  const foundFolders = new Set<string>();
  let discoveredBooks = 0;
  let discoveredFiles = 0;
  const preparedBooks: PreparedBookScan[] = [];

  try {
    for (const [folderAbsolutePath, files] of filesByFolder.entries()) {
      preparedBooks.push(await prepareBookScan(libraryId, rootPath, settings, folderAbsolutePath, files));
    }
  } catch (err) {
    db.prepare("UPDATE libraries SET scan_status = 'error', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(libraryId);
    throw err;
  }

  db.transaction(() => {
    for (const book of preparedBooks) {
      foundFolders.add(book.folderPath);
      writeBookScan(libraryId, book);
      discoveredBooks += 1;
      discoveredFiles += book.files.length;
    }

    const knownBooks = db.prepare("SELECT id, folder_path FROM books WHERE library_id = ? AND deleted_at IS NULL")
      .all(libraryId) as { id: string; folder_path: string }[];
    for (const book of knownBooks) {
      if (!foundFolders.has(book.folder_path)) {
        db.prepare("UPDATE books SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(book.id);
        db.prepare("UPDATE book_files SET status = 'missing', deleted_at = CURRENT_TIMESTAMP WHERE book_id = ?").run(book.id);
      }
    }

    db.prepare(`
      UPDATE libraries
      SET scan_status = 'idle', last_scanned_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(libraryId);
  })();

  return { discoveredBooks, discoveredFiles };
}

export async function rescanSingleBook(bookId: string) {
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
  const settings = normaliseSettings(row.settings_json);
  const folderAbsolutePath = path.join(rootPath, row.folder_path);

  if (!fs.existsSync(folderAbsolutePath)) {
    return null;
  }

  const files = readBookFolderFiles(rootPath, folderAbsolutePath, settings);
  if (files.length === 0) {
    return null;
  }

  const book = await prepareBookScan(row.library_id, rootPath, settings, folderAbsolutePath, files);
  db.transaction(() => writeBookScan(row.library_id, book))();
  return book.bookId;
}

export function enqueueAudiobookScan(libraryId: string) {
  const jobId = nanoid(16);
  db.prepare("UPDATE libraries SET scan_status = 'scanning', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(libraryId);
  db.prepare(`
    INSERT INTO jobs (id, type, payload, status)
    VALUES (?, ?, ?, 'pending')
  `).run(jobId, scanJobType, JSON.stringify({ libraryId }));
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

      const payload = JSON.parse(job.payload) as { libraryId: string };
      try {
        const result = await scanAudiobookLibrary(payload.libraryId);
        db.prepare(`
          UPDATE jobs
          SET status = 'completed', payload = ?, completed_at = CURRENT_TIMESTAMP, locked_at = NULL, locked_by = NULL
          WHERE id = ?
        `).run(JSON.stringify({ ...payload, result }), job.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Audiobook scan failed";
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
