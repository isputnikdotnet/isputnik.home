export type LibraryRole = "viewer" | "subscriber" | "contributor" | "curator" | "admin";

export interface AudiobookLibrary {
  id: string;
  name: string;
  type: "audiobook";
  sourcePath?: string;
  ignoreSidecar: boolean;
  myRole: LibraryRole | null;
  canWrite: boolean;
  canDownload: boolean;
  canUpload: boolean;
  canCurate: boolean;
  canManageMembers: boolean;
  canManageLibrary: boolean;
  scanStatus: "idle" | "scanning" | "error";
  lastScannedAt: string | null;
  ownerId: string | null;
  ownerType: "user" | "group" | null;
  visibility: "private" | "public";
  publicRole: "viewer" | "subscriber";
  createdAt: string;
  updatedAt: string;
  bookCount: number;
  fileCount: number;
}

// Per-book capability flags returned alongside a book detail, derived from the
// caller's role on the book's library. Used to gate edit/download/share buttons.
export interface BookCapabilities {
  canEdit: boolean;
  canDownload: boolean;
  canCurate: boolean;
  canShare: boolean;
}

export interface LibraryMember {
  subjectType: "user" | "group";
  subjectId: string;
  role: LibraryRole;
  name: string;
  email: string | null;
  missing: boolean;
  createdAt: string;
}

// Library roles, weakest → strongest, with the capabilities each unlocks. Used to
// render the role picker and explain each option in the members UI.
export const LIBRARY_ROLE_OPTIONS: { value: LibraryRole; label: string; summary: string }[] = [
  { value: "viewer", label: "Viewer", summary: "View / read in-app" },
  { value: "subscriber", label: "Subscriber", summary: "View + download" },
  { value: "contributor", label: "Contributor", summary: "View, download, upload, edit items" },
  { value: "curator", label: "Curator", summary: "All content + manage series/structure" },
  { value: "admin", label: "Library Admin", summary: "Full control incl. members & settings" }
];

export interface AudiobookBook {
  id: string;
  libraryId: string;
  folderPath: string;
  status: "pending" | "ready" | "error";
  title: string;
  series: string | null;
  seriesPosition: number | null;
  authors: string[];
  narrators: string[];
  category: BookCategory | null;
  tags: string[];
  language: string | null;
  fileCount: number;
  totalSize: number;
  durationSeconds: number | null;
  coverUrl: string | null;
  coverLargeUrl: string | null;
  publisher: string | null;
  asin: string | null;
  progress?: { percentComplete: number | null; completedAt: string | null };
  saved: boolean;
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

export interface BookDocument {
  id: string;
  fileName: string;
  format: string;
  mimeType: string | null;
  size: number;
  url: string;
}

export interface AudiobookBookDetail extends AudiobookBook {
  libraryName: string;
  seriesId: string | null;
  description: string | null;
  yearPublished: number | null;
  isbn: string | null;
  openLibraryId: string | null;
  metadataSource: "scan" | "manual";
  files: AudiobookFile[];
  documents: BookDocument[];
}

export interface PlaybackProgress {
  fileId: string | null;
  positionSeconds: number;
  percentComplete: number | null;
  completedAt: string | null;
}

export interface ReadingProgress {
  documentId: string;
  cfi: string;
  percentComplete: number | null;
  label: string | null;
  updatedAt: string;
  completedAt: string | null;
}

export interface Bookmark {
  id: string;
  fileId: string | null;
  positionSeconds: number;
  bookPositionSeconds: number | null;
  label: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BookSave {
  saved: boolean;
  note: string | null;
}

export interface SavedBookmark {
  id: string;
  bookId: string;
  bookTitle: string;
  bookAuthors: string[];
  coverUrl: string | null;
  fileId: string | null;
  positionSeconds: number;
  bookPositionSeconds: number | null;
  label: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SavedBook {
  id: string;
  libraryId: string;
  title: string;
  series: string | null;
  seriesPosition: number | null;
  authors: string[];
  durationSeconds: number | null;
  fileCount: number;
  coverUrl: string | null;
  note: string | null;
  savedAt: string;
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

export interface SeriesSummary {
  id: string;
  name: string;
  bookCount: number;
  coverUrl: string | null;
}

export interface SeriesDetail {
  id: string;
  name: string;
  description: string | null;
  coverUrl: string | null;
  libraryId: string;
  libraryName: string;
  books: {
    id: string;
    title: string;
    authors: string[];
    coverUrl: string | null;
    seriesPosition: number | null;
  }[];
}

export interface BookCategory {
  key: string;
  name: string;
  icon?: string | null;
  imageUrl?: string | null;
}

export interface CategorySummary {
  key: string;
  name: string;
  icon: string | null;
  imageUrl: string | null;
  bookCount: number;
}

export interface CategoryDetail {
  key: string;
  name: string;
  icon: string | null;
  imageUrl: string | null;
  books: {
    id: string;
    title: string;
    authors: string[];
    coverUrl: string | null;
  }[];
}

export interface TagSummary {
  name: string;
  count: number;
}

export interface CoverCandidate {
  name: string;
  relativePath: string;
  size: number;
  previewUrl: string;
}
