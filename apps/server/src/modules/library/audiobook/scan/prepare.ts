import path from "node:path";
import { nanoid } from "nanoid";
import { db } from "../../../../db.js";
import { normaliseRelativePath } from "../../shared/storage-roots.js";
import { sourceEnabled } from "../../shared/library-settings.js";
import type { MetadataSourceId } from "../../shared/metadata-sources.js";
import { downloadImage } from "../../shared/remote-image.js";
import { getScanRule } from "../../shared/scan-rules.js";
import { lookupOnlineBookMetadata } from "../enrich.js";
import { isMp4ChapterContainer } from "../mp4-chapters.js";
import { parseFolderName, sortTitle } from "./folder-parse.js";
import {
  extractChapters,
  firstComment,
  firstNativeString,
  numberFromTag,
  peopleFromTags,
  primaryPublisher,
  repairEncoding,
  repairList,
  safeParseAudio,
  splitTagValues,
  stringValue,
  yearFromMetadata
} from "./tag-read.js";
import { readSidecarMetadata, repairSidecar, sidecarArray } from "./sidecar.js";
import { generateCover, writeCoverImages } from "./covers.js";
import { readBookFolderDocuments, type BookOwner } from "./walk.js";
import type { AudioFileEntry, EffectiveScanConfig, PreparedBookScan } from "./types.js";

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

function mimeFromExtension(extension: string) {
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

function trackNumberFromFileName(fileName: string, fallback: number) {
  const match = fileName.match(/^(\d{1,4})(?:\D|$)/);
  return match ? Number(match[1]) : fallback;
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

export async function prepareBookScan(
  libraryId: string,
  rootPath: string,
  config: EffectiveScanConfig,
  folderAbsolutePath: string,
  files: AudioFileEntry[],
  owner: BookOwner | null = null
): Promise<PreparedBookScan> {
  const { settings, sources, tagEncoding: enc } = config;
  const folderPath = normaliseRelativePath(path.relative(rootPath, folderAbsolutePath)) || ".";
  const existingBook = db.prepare("SELECT id, scan_rule_id, updated_at FROM library_items WHERE library_id = ? AND folder_path = ?")
    .get(libraryId, folderPath) as { id: string; scan_rule_id: string | null; updated_at: string } | undefined;
  const bookId = existingBook?.id ?? nanoid(16);
  const scanRuleId = owner?.ruleId ?? null;
  // A book that changed owner, or whose rule was edited since it was last written,
  // must be re-derived even when its files are untouched.
  const ownerChanged = Boolean(existingBook) && (
    existingBook!.scan_rule_id !== scanRuleId
    || (owner !== null && (getScanRule(owner.ruleId)?.updatedAt ?? "") > existingBook!.updated_at)
  );
  const forceReread = config.forceReread || ownerChanged;
  const metadataRow = db.prepare("SELECT source, cover_storage_key, description FROM item_metadata WHERE item_id = ?")
    .get(bookId) as { source: "scan" | "manual"; cover_storage_key: string | null; description: string | null } | undefined;
  const manualMetadata = metadataRow?.source === "manual";
  const onlineEnabled = sourceEnabled(sources, "online_metadata") && !manualMetadata;
  // A single-file book's "folder" is the audio file itself: every file it holds is the
  // book folder path. Its title hint is the file name (sans extension) and its parent is
  // the library root, so there is no author folder to read.
  const isFileBook = files.length === 1 && files[0].absolutePath === folderAbsolutePath;
  const titleHint = isFileBook
    ? path.basename(folderAbsolutePath, path.extname(folderAbsolutePath))
    : path.basename(folderAbsolutePath);
  // In top-level grouping the parent of every book folder is the library root, which
  // is not an author name; same when the book is the root itself or a single loose file.
  // Inside a scan rule the layout says what each folder means, so no guessing either.
  const authorHint = owner !== null || config.groupingMode === "top_level_folder" || folderPath === "." || isFileBook
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

  // Online lookup re-opens unchanged books that still have gaps it could fill;
  // everything else keeps the cheap fast path.
  let onlineGaps = false;
  if (onlineEnabled && existingBook && metadataRow) {
    const narratorCount = (db.prepare("SELECT COUNT(*) AS n FROM item_people WHERE item_id = ? AND role = 'narrator'")
      .get(bookId) as { n: number }).n;
    onlineGaps = !metadataRow.cover_storage_key || !metadataRow.description || narratorCount === 0;
  }

  // m4b/m4a books need one re-read to back-fill embedded chapters the first time
  // this runs; the unchanged-file fast path would otherwise never parse them. Once
  // rows exist the fast path resumes.
  const chapterCapable = filesWithFallbackOrder.some((file) => isMp4ChapterContainer(path.extname(file.fileName)));
  const chaptersMissing = chapterCapable && Boolean(existingBook)
    && (db.prepare(`
        SELECT COUNT(*) AS n
        FROM audio_chapters
        JOIN audio_files ON audio_files.id = audio_chapters.audio_file_id
        WHERE audio_files.item_id = ?
      `).get(bookId) as { n: number }).n === 0;

  if (existingBook && metadataRow && !sidecar && !forceReread && !onlineGaps && !chaptersMissing) {
    const existingFiles = db.prepare(`
      SELECT relative_path, mime_type, track_number, title AS chapter_title, duration_seconds, size, modified_at, content_hash
      FROM audio_files
      WHERE item_id = ?
        AND deleted_at IS NULL
    `).all(bookId) as ExistingBookFileRow[];
    if (existingFilesAreCurrent(filesWithFallbackOrder, existingFiles)) {
      return {
        bookId,
        folderAbsolutePath,
        folderPath,
        scanRuleId,
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
    const taggedPeople = peopleFromTags({
      albumartists: common?.albumartists, albumartist: common?.albumartist,
      artists: common?.artists, artist: common?.artist, composer: common?.composer
    });
    candidates.set("file_metadata", {
      title: repairEncoding(tagTitle, enc),
      description: repairEncoding(firstComment(firstMetadata), enc),
      year: yearFromMetadata(firstMetadata),
      language: common?.language ?? null,
      isbn: firstNativeString(firstMetadata, ["isbn", "ISBN"]),
      asin: common?.asin ?? firstNativeString(firstMetadata, ["asin", "audible_asin", "AUDIBLE_ASIN"]),
      publisher: repairEncoding(primaryPublisher(firstMetadata), enc),
      authors: repairList(taggedPeople.authors, enc),
      narrators: repairList(taggedPeople.narrators, enc),
      genres: repairList(splitTagValues(common?.genre ?? []), enc),
      seriesName: repairEncoding(stringValue(common?.grouping) || firstNativeString(firstMetadata, ["series", "SERIES"]), enc),
      seriesPosition: numberFromTag(firstNativeString(firstMetadata, ["series-part", "series_part", "PART"]))
    });
  }

  if (sourceEnabled(sources, "folder_structure")) {
    // The folder name supplies the book title, and — following the common
    // "Author - Title [Narrator]" convention — author and narrator when present.
    // Per-track titles still come from file names (the chapter-title pick below).
    const parsed = parseFolderName(titleHint);
    candidates.set("folder_structure", {
      title: parsed.title,
      authors: parsed.authors,
      narrators: parsed.narrators,
      year: parsed.year ?? null
    });
  }

  const merged: SourceCandidate = {};
  // What a scan rule's layout read from the path wins over every source: the rule
  // exists because those folder names are the truth. Fields it does not capture
  // fall through to the sources below, per field.
  if (owner?.fields.matched) {
    const f = owner.fields;
    mergeCandidate(merged, {
      title: f.title ?? null,
      authors: f.author ? [f.author] : undefined,
      narrators: f.narrator ? [f.narrator] : undefined,
      year: f.year ?? null,
      publisher: f.publisher ?? null,
      seriesName: f.series ?? null,
      seriesPosition: f.position ?? null
    });
  }
  for (const source of sources) {
    if (!source.enabled) continue;
    const candidate = candidates.get(source.id);
    if (candidate) mergeCandidate(merged, candidate);
  }

  let coverStorageKey = manualMetadata
    ? null
    : await generateCover(libraryId, bookId, folderAbsolutePath, settings, fileMetaEnabled ? firstMetadata : null);

  // Online lookup (optional source): fill what the local sources left empty.
  // Never overwrites a locally found value, never runs for manual metadata.
  if (onlineEnabled) {
    const hasCover = Boolean(coverStorageKey ?? metadataRow?.cover_storage_key);
    if (!merged.narrators?.length || !merged.description || !hasCover) {
      const lookupAuthors = merged.authors?.length ? merged.authors : (authorHint ? [authorHint] : []);
      const online = await lookupOnlineBookMetadata({
        title: merged.title || titleHint,
        authors: lookupAuthors,
        needCover: !hasCover
      }).catch(() => null);
      if (online) {
        if (!merged.narrators?.length && online.narrators?.length) merged.narrators = online.narrators;
        if (!merged.description && online.description) merged.description = online.description;
        // Author names only when nothing local hints at one — a folder-derived
        // name must stay authoritative so same-folder books share one person.
        if (!merged.authors?.length && !authorHint && online.authors.length) merged.authors = online.authors;
        if (merged.year == null && online.year != null) merged.year = online.year;
        if (!merged.language && online.language) merged.language = online.language;
        if (!merged.genres?.length && online.genres?.length) merged.genres = online.genres;
        if (!merged.publisher && online.publisher) merged.publisher = online.publisher;
        if (!hasCover && online.coverUrl) {
          try {
            coverStorageKey = await writeCoverImages(libraryId, bookId, await downloadImage(online.coverUrl));
          } catch {
            // cover stays empty; the text fields above still apply
          }
        }
      }
    }
  }

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

  // Disc, then the folder the file sits in, then track: a book gathered from
  // "Part 1" / "Part 2" subfolders that each restart at 001 plays part by part
  // instead of interleaving. Files in one folder are unaffected by the middle key.
  const dirOf = (relativePath: string) => path.posix.dirname(relativePath);
  const preparedFiles = fileSortData
    .sort((left, right) => (
      left.sortDisc - right.sortDisc
      || dirOf(left.file.relativePath).localeCompare(dirOf(right.file.relativePath), undefined, { numeric: true })
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
      contentHash: null,
      // Only MP4 containers carry embedded chapters worth reading; MP3 files are each
      // their own chapter, so leave their chapter rows untouched (undefined = skip).
      chapters: isMp4ChapterContainer(item.extension)
        ? extractChapters(item.file.absolutePath, enc)
        : undefined
    }));
  const totalDuration = preparedFiles.reduce((total, file) => total + (file.durationSeconds ?? 0), 0);

  const title = merged.title || titleHint;
  const scannedAuthors = merged.authors?.length ? merged.authors : (authorHint ? [authorHint] : []);

  return {
    bookId,
    folderAbsolutePath,
    folderPath,
    scanRuleId,
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
    // A single loose file has no companion-document folder to scan.
    documents: isFileBook ? [] : readBookFolderDocuments(rootPath, folderAbsolutePath)
  };
}
