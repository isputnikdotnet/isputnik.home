import type { PublicUser } from "../../api";

export interface ManagedUser extends PublicUser {
  activeSessions: number;
  locked: boolean;
}

export interface ManagedInvite {
  id: string;
  url: string | null;
  role: "admin" | "member";
  status: "active" | "expired" | "used";
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  createdByName: string;
  usedByName: string | null;
}

export interface ManagedSession {
  id: string;
  userId: string;
  displayName: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  lastSeen: string;
  deviceName: string | null;
  ipAddress: string | null;
  current: boolean;
}

export interface LogEvent {
  id: string;
  event: string;
  detail: string;
  ipAddress: string | null;
  createdAt: string;
  actorName: string | null;
}

export interface LibraryStatusStats {
  id: string;
  name: string;
  bookCount: number;
  totalSizeBytes: number;
  totalDurationSeconds: number;
}

export interface PersonStatusStats {
  name: string;
  bookCount: number;
  totalDurationSeconds: number;
}

export interface BookDurationStats {
  id: string;
  title: string;
  libraryName: string;
  authors: string[];
  totalSizeBytes: number;
  totalDurationSeconds: number;
}

export interface EbookLibraryStatusStats {
  id: string;
  name: string;
  bookCount: number;
  totalSizeBytes: number;
}

export interface EbookPersonStatusStats {
  name: string;
  bookCount: number;
}

export interface FormatStats {
  format: string;
  count: number;
}

export interface EbookSizeStats {
  id: string;
  title: string;
  libraryName: string;
  authors: string[];
  formats: string[];
  totalSizeBytes: number;
}

export interface EbookStats {
  totalLibraries: number;
  totalBooks: number;
  totalSizeBytes: number;
  libraries: EbookLibraryStatusStats[];
  topAuthors: EbookPersonStatusStats[];
  formats: FormatStats[];
  largestBooks: EbookSizeStats[];
}

export interface GalleryLibraryStatusStats {
  id: string;
  name: string;
  itemCount: number;
  photoCount: number;
  videoCount: number;
  totalSizeBytes: number;
  totalDurationSeconds: number;
}

export interface GallerySizeStats {
  id: string;
  title: string;
  libraryName: string;
  kind: string;
  totalSizeBytes: number;
  durationSeconds: number;
}

export interface GalleryStats {
  totalLibraries: number;
  totalItems: number;
  totalPhotos: number;
  totalVideos: number;
  totalSizeBytes: number;
  totalDurationSeconds: number;
  libraries: GalleryLibraryStatusStats[];
  largestItems: GallerySizeStats[];
}

export interface SystemStatus {
  health: string;
  databaseBytes: number;
  users: number;
  activeSessions: number;
  activeInvites: number;
  logEntries: number;
  audiobookLibraries: number;
  audiobookBooks: number;
  libraryStats: {
    totalLibraries: number;
    totalBooks: number;
    totalSizeBytes: number;
    totalDurationSeconds: number;
    libraries: LibraryStatusStats[];
    topAuthors: PersonStatusStats[];
    topNarrators: PersonStatusStats[];
    longestBooks: BookDurationStats[];
  };
  ebookStats: EbookStats;
  galleryStats: GalleryStats;
  uptimeSeconds: number;
  generatedAt: string;
}

export interface LibrarySettings {
  thumbnailPath: string;
  thumbnailPathReady: boolean;
  thumbnailPathError: string;
  fromEnvironment: boolean;
}

export interface StorageRoot {
  id: string;
  name: string;
  path: string;
  createdAt?: string;
  updatedAt?: string;
  libraryCount: number;
}

export interface StorageBrowseEntry {
  name: string;
  relativePath: string;
}

export interface StorageBrowse {
  root: StorageRoot;
  currentPath: string;
  selectedPath: string;
  parentPath: string | null;
  entries: StorageBrowseEntry[];
}

export interface Job {
  id: string;
  type: string;
  status: "pending" | "running" | "completed" | "failed";
  attempts: number;
  libraryName: string | null;
  createdAt: string;
  // When the worker began running the job (null until claimed). Duration is measured
  // from here, not createdAt, so time spent queued isn't counted.
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  error: string | null;
  // Human-readable result line for finished tasks, built server-side per job type.
  summary: string | null;
  // Live progress, present only while running; unit names what's counted ("books", "photos").
  progress: {
    processed: number;
    total: number;
    unit: string;
    etaSeconds: number | null;
  } | null;
  // Position within a pre-queued batch group ("batch 2 of 5"); null for single jobs.
  batch: { index: number; total: number } | null;
  bookErrors: string[];
}

export interface DbInfo {
  path: string;
  directory: string;
  filename: string;
  sizeBytes: number;
  walSizeBytes: number;
  totalSizeBytes: number;
  lastModified: string | null;
}

export interface ManagedGroup {
  id: string;
  name: string;
  createdAt: string;
  memberCount: number;
  libraryCount: number;
}

export interface GroupMember {
  userId: string;
  displayName: string;
  email: string;
  joinedAt: string;
}
