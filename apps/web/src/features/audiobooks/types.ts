// Per-object roles. `deny` is an explicit block, not a tier. See docs/permissions.md.
export type LibraryRole = "viewer" | "member" | "contributor" | "manager" | "deny";
// Roles the public (Everyone) can hold on a library — never manager/deny.
export type PublicRole = "viewer" | "member" | "contributor";
export type LibraryMode = "managed" | "external";

// Scan metadata sources — ordered by priority (index 0 wins per field). Mirrors the
// server registry exposed via GET /api/library/settings.
export type MetadataSourceId = "file_metadata" | "metadata_files" | "folder_structure" | "online_metadata";

export interface ScanSource {
  id: MetadataSourceId;
  enabled: boolean;
}

export interface MetadataSourceInfo {
  id: MetadataSourceId;
  label: string;
  description: string;
  appliesTo: string[];
  defaultEnabled: boolean;
  recommended?: boolean;
  affectsGrouping?: boolean;
}

export interface LibraryTypeDefaults {
  extensions: string[];
  // Default upload-only companion files (covers, sidecars, documents).
  companions: string[];
  sources: ScanSource[];
}

export type TagEncoding = "windows-1251" | "windows-1250" | "windows-1252" | "koi8-r";

// How playback progress is tracked: linear = one resume point for the whole book;
// episodic = per-track played/position state (radio shows, podcasts).
export type ProgressMode = "linear" | "episodic";

// Scan/upload settings exposed to admins on the manage view.
export interface AdminLibrarySettings {
  defaultLanguage: string | null;
  scanExtensions: string[];
  // Upload-only companion files (covers, sidecars, documents) — never scanned
  // as primary content.
  companionExtensions: string[];
  scanSources: ScanSource[];
  maxUploadMB: number | null;
  tagEncoding: TagEncoding | null;
  progressMode: ProgressMode;
}

export interface AudiobookLibrary {
  id: string;
  name: string;
  type: "audiobook";
  sourcePath?: string;
  settings?: AdminLibrarySettings;
  myRole: LibraryRole | null;
  canWrite: boolean;
  canDownload: boolean;
  canUpload: boolean;
  canDelete: boolean;
  canCurate: boolean;
  canManageMembers: boolean;
  canManageLibrary: boolean;
  // Upload constraints mirrored from the server policy, for the dropzone.
  uploadExtensions: string[];
  maxUploadMB: number | null;
  scanStatus: "idle" | "scanning" | "error";
  lastScannedAt: string | null;
  ownerId: string | null;
  ownerType: "user" | "group" | null;
  visibility: "private" | "public";
  publicRole: PublicRole;
  mode: LibraryMode;
  createdAt: string;
  updatedAt: string;
  bookCount: number;
  fileCount: number;
  totalSizeBytes: number | null;
}

// Per-book capability flags returned alongside a book detail, derived from the
// caller's role on the book's library. Used to gate edit/download/share buttons.
export interface BookCapabilities {
  canEdit: boolean;
  canDownload: boolean;
  canCurate: boolean;
  canShare: boolean;
  canDelete: boolean;
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

// Roles grantable to a user/group in the members UI, plus the explicit Deny block.
export const LIBRARY_ROLE_OPTIONS: { value: LibraryRole; label: string; summary: string }[] = [
  { value: "viewer", label: "Viewer", summary: "View / read in-app" },
  { value: "member", label: "Member", summary: "View + download" },
  { value: "contributor", label: "Contributor", summary: "+ add / edit content" },
  { value: "manager", label: "Manager", summary: "Full control: members & settings" },
  { value: "deny", label: "Deny (block)", summary: "No access — overrides every grant" }
];

// Public-access choices for a library's Everyone baseline (no manager/deny).
export const PUBLIC_ROLE_OPTIONS: { value: PublicRole; label: string }[] = [
  { value: "viewer", label: "View only (no downloads)" },
  { value: "member", label: "View + download" },
  { value: "contributor", label: "Everyone can add / edit content" }
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

// An embedded chapter marker inside a single audio file (m4b `chap` track or MP3
// ID3v2 CHAP/CTOC). Offsets are relative to the start of the file.
export interface AudiobookChapter {
  id: string;
  title: string;
  startSeconds: number;
  endSeconds: number | null;
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
  // Present only when the file carries embedded chapters; otherwise the whole
  // file is treated as one chapter.
  chapters?: AudiobookChapter[];
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
  progressMode: ProgressMode;
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

// Per-track (per-episode) progress for episodic libraries.
export interface TrackProgress {
  fileId: string;
  positionSeconds: number;
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
  source: "itunes" | "openlibrary" | "fantlab" | "librivox";
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
