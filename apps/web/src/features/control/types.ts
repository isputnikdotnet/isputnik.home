import type { PublicUser } from "../../api";

export interface ManagedUser extends PublicUser {
  activeSessions: number;
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

export interface SystemStatus {
  health: string;
  databaseBytes: number;
  users: number;
  activeSessions: number;
  activeInvites: number;
  logEntries: number;
  audiobookLibraries: number;
  audiobookBooks: number;
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
  completedAt: string | null;
  failedAt: string | null;
  error: string | null;
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
  role: "member" | "manager";
  joinedAt: string;
}
