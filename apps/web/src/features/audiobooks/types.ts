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
  language: string | null;
  fileCount: number;
  totalSize: number;
  durationSeconds: number | null;
  coverUrl: string | null;
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
  files: AudiobookFile[];
}
