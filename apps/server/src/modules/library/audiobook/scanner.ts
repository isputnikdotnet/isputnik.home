import fs from "node:fs";
import path from "node:path";
import { parseFile, type IAudioMetadata } from "music-metadata";
import { nanoid } from "nanoid";
import sharp from "sharp";
import { db } from "../../../db.js";
import { normaliseRelativePath, findStorageRootForPath } from "../shared/storage-roots.js";
import { getConfiguredThumbnailPath, thumbnailAbsolutePath, thumbnailStorageKey } from "../shared/thumbnail.js";

const legacyAudioExtensions = new Set([".m4b", ".m4a", ".mp3", ".flac", ".ogg", ".opus", ".aac"]);
export const audioExtensions = new Set([...legacyAudioExtensions, ".wav", ".wave"]);
const imageExtensions = [".jpg", ".jpeg", ".png", ".webp"];
const scanJobType = "SCAN_AUDIOBOOK_LIBRARY";

interface AudiobookSettings {
  default_language?: string;
  supported_extensions?: string[];
  cover_filenames?: string[];
  ignore_sidecar?: boolean;
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

  const extensions = new Set(settings.supported_extensions.map((extension) => {
    const normalised = extension.trim().toLowerCase();
    return normalised.startsWith(".") ? normalised : `.${normalised}`;
  }));

  const isLegacyDefault = extensions.size === legacyAudioExtensions.size
    && Array.from(extensions).every((extension) => legacyAudioExtensions.has(extension));
  if (isLegacyDefault) {
    for (const extension of audioExtensions) {
      extensions.add(extension);
    }
  }

  return extensions;
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

  const name = stringValue(value);
  return name ? { name } : {};
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

export async function walkAudiobookFiles(rootPath: string, settings: AudiobookSettings = {}) {
  const extensions = supportedAudioExtensions(settings);
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
      const bookFolderPath = discHint ? path.dirname(folderPath) : folderPath;
      const relativePath = normaliseRelativePath(path.relative(rootPath, absolutePath));

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
  const sidecar = (manualMetadata || settings.ignore_sidecar) ? null : readSidecarMetadata(folderAbsolutePath);

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

  // Parse all files in parallel: first file gets cover extraction, rest skip it
  const parsedMetadata = await Promise.all(
    filesWithFallbackOrder.map((file, index) =>
      safeParseAudio(file.absolutePath, index === 0 && !manualMetadata)
    )
  );

  const firstMetadata = parsedMetadata[0] ?? null;
  const common = firstMetadata?.common;
  const title = stringValue(common?.album)
    || stringValue(common?.title)
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
  const seriesName = stringValue(common?.grouping) || firstNativeString(firstMetadata, ["series", "SERIES"]) || null;
  const seriesPosition = numberFromTag(firstNativeString(firstMetadata, ["series-part", "series_part", "PART"]));
  const isbn = firstNativeString(firstMetadata, ["isbn", "ISBN"]);
  const asin = common?.asin ?? firstNativeString(firstMetadata, ["asin", "audible_asin", "AUDIBLE_ASIN"]);
  const publisher = primaryPublisher(firstMetadata);
  const coverStorageKey = manualMetadata ? null : await generateCover(bookId, folderAbsolutePath, settings, firstMetadata);
  const sidecarAuthors = sidecarArray(sidecar?.authors);
  const sidecarNarrators = sidecarArray(sidecar?.narrators);
  const sidecarGenres = sidecarArray(sidecar?.genres);

  const fileSortData = filesWithFallbackOrder.map((file, index) => {
    const metadata = parsedMetadata[index];
    const extension = path.extname(file.fileName).toLowerCase();
    const discNumber = metadata?.common.disk.no ?? file.discHint ?? 0;
    const taggedTrack = metadata?.common.track.no ?? null;
    return {
      file,
      metadata,
      extension,
      sortDisc: discNumber,
      sortTrack: taggedTrack ?? trackNumberFromFileName(file.fileName, index + 1)
    };
  });

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
      contentHash: null
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
  db.prepare("INSERT OR IGNORE INTO authors (id, library_id, name, sort_name) VALUES (?, ?, ?, ?)")
    .run(nanoid(16), libraryId, name, sortTitle(name));
  return db.prepare("SELECT id FROM authors WHERE library_id = ? AND name = ?")
    .get(libraryId, name) as { id: string };
}

function upsertGenre(libraryId: string, name: string) {
  db.prepare("INSERT OR IGNORE INTO genres (id, library_id, name) VALUES (?, ?, ?)")
    .run(nanoid(16), libraryId, name);
  return db.prepare("SELECT id FROM genres WHERE library_id = ? AND name = ?")
    .get(libraryId, name) as { id: string };
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

export async function scanAudiobookLibrary(libraryId: string, jobId: string | null = null) {
  const library = db.prepare("SELECT id, source_path, settings_json FROM libraries WHERE id = ? AND type = 'audiobook'")
    .get(libraryId) as { id: string; source_path: string; settings_json: string } | undefined;
  if (!library) {
    throw new Error("Audiobook library not found.");
  }

  const rootPath = validateLibrarySource(library.source_path);
  const settings = normaliseSettings(library.settings_json);
  db.prepare("UPDATE libraries SET scan_status = 'scanning', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(libraryId);

  const filesByFolder = await walkAudiobookFiles(rootPath, settings);
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
        const book = await prepareBookScan(libraryId, rootPath, settings, folderAbsolutePath, files);
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
        const result = await scanAudiobookLibrary(payload.libraryId, job.id);
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
