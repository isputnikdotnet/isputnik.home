// The shapes a book scan passes between its steps: what the walk found on disk,
// what prepare decided, and what write stores.
import type fs from "node:fs";
import type { AudiobookLibrarySettings, ScanSourceConfig, TagEncoding } from "../../shared/library-settings.js";

// How files are grouped into books. folder_hierarchy: the folder containing the audio
// files is the book (disc subfolders collapse into the parent). top_level_folder: each
// immediate child folder of the library root is one book holding everything beneath it.
// file_per_book: each audio file directly in the library root is its own book (a flat
// folder of single-file audiobooks); files inside subfolders still group by folder.
export type GroupingMode = "folder_hierarchy" | "top_level_folder" | "file_per_book";

export interface EffectiveScanConfig {
  settings: AudiobookSettings;
  // Enabled sources in priority order (index 0 wins per metadata field).
  sources: ScanSourceConfig[];
  groupingMode: GroupingMode;
  // True when rescan options force a fresh metadata read even for unchanged files.
  forceReread: boolean;
  tagEncoding?: TagEncoding;
}

export type AudiobookSettings = AudiobookLibrarySettings;

export interface AudioFileEntry {
  absolutePath: string;
  fileName: string;
  relativePath: string;
  stat: fs.Stats;
  discHint: number | null;
}

// One embedded chapter marker inside a single audio file; offsets are relative to
// the start of that file.
export interface PreparedChapter {
  title: string;
  startSeconds: number;
  endSeconds: number | null;
}

export interface PreparedBookFile {
  relativePath: string;
  mimeType: string;
  trackNumber: number;
  chapterTitle: string;
  durationSeconds: number | null;
  size: number;
  modifiedAt: string;
  contentHash: string | null;
  // Embedded chapters within this file. undefined = not re-parsed this scan (fast
  // path) → leave existing rows untouched; [] = parsed and none were found.
  chapters?: PreparedChapter[];
}

export interface PreparedBookScan {
  bookId: string;
  folderAbsolutePath: string;
  folderPath: string;
  // The scan rule that produced this book, or null for the default scanner.
  scanRuleId: string | null;
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

export interface DocumentEntry {
  relativePath: string;
  format: string;
  mimeType: string;
  size: number;
}
