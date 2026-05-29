export interface AudiobookLibrary {
  id: string;
  name: string;
  type: "audiobook";
  sourcePath?: string;
  scanStatus: "idle" | "scanning" | "error";
  lastScannedAt: string | null;
  createdAt: string;
  updatedAt: string;
  bookCount: number;
  fileCount: number;
}

export interface AudiobookBook {
  id: string;
  libraryId: string;
  folderPath: string;
  status: "pending" | "ready" | "error";
  title: string;
  authors: string[];
  narrators: string[];
  genres: string[];
  language: string | null;
  fileCount: number;
  totalSize: number;
  durationSeconds: number | null;
  coverUrl: string | null;
  coverLargeUrl: string | null;
  publisher: string | null;
  asin: string | null;
  discoveredAt: string;
  updatedAt: string;
}

export interface AudiobookFile {
  id: string;
  relativePath: string;
  mimeType: string | null;
  trackNumber: number | null;
  chapterTitle: string | null;
  durationSeconds: number | null;
  size: number;
  modifiedAt: string | null;
  status: "available" | "missing";
}

export interface AudiobookBookDetail extends AudiobookBook {
  libraryName: string;
  description: string | null;
  yearPublished: number | null;
  isbn: string | null;
  openLibraryId: string | null;
  metadataSource: "scan" | "manual";
  files: AudiobookFile[];
}

export interface PlaybackProgress {
  fileId: string | null;
  positionSeconds: number;
  percentComplete: number | null;
  completedAt: string | null;
}

export interface MetadataCandidate {
  title: string;
  subtitle?: string;
  authors: string[];
  narrators?: string[];
  publisher?: string;
  year?: number;
  description?: string;
  coverUrl?: string;
  isbn?: string;
  asin?: string;
  genres?: string[];
  language?: string;
  source: "itunes" | "openlibrary" | "fantlab";
}

export interface CoverCandidate {
  name: string;
  relativePath: string;
  size: number;
  previewUrl: string;
}
