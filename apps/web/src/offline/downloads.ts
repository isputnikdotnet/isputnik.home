import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { AudiobookBookDetail } from "../features/audiobooks/types";

// Offline storage is namespaced per user so a shared family device never exposes
// one account's downloads to another login. The current user's id is stashed in
// localStorage at sign-in (see App.tsx) because /api/auth/me is unreachable offline.
const UID_KEY = "isputnik-uid";

export function setOfflineUserId(id: string) {
  try { localStorage.setItem(UID_KEY, id); } catch { /* private mode */ }
}

export function getOfflineUserId(): string | null {
  try { return localStorage.getItem(UID_KEY); } catch { return null; }
}

export type DownloadState = "downloading" | "complete" | "failed";

export interface DownloadFileMeta {
  id: string;
  relativePath: string;
  chapterTitle: string | null;
  durationSeconds: number | null;
  size: number;
  mimeType: string | null;
}

export interface DownloadRecord {
  bookId: string;
  title: string;
  authors: string[];
  coverUrl: string | null;
  files: DownloadFileMeta[];
  totalBytes: number;
  downloadedBytes: number;
  state: DownloadState;
  createdAt: string;
}

interface StoredFile {
  fileId: string;
  bookId: string;
  blob: Blob;
}

// Queue of playback positions written while offline (or when a PATCH failed),
// flushed to the server on reconnect. Used by Phase 2b; the store is created now
// to avoid a later schema migration.
export interface QueuedProgress {
  bookId: string;
  fileId: string;
  positionSeconds: number;
  updatedAt: number;
}

interface OfflineDB extends DBSchema {
  downloads: { key: string; value: DownloadRecord };
  files: { key: string; value: StoredFile; indexes: { bookId: string } };
  progressQueue: { key: string; value: QueuedProgress };
}

function dbName(userId: string) {
  return `isputnik-offline:${userId}`;
}

let cached: { userId: string; db: Promise<IDBPDatabase<OfflineDB>> } | null = null;

function db(): Promise<IDBPDatabase<OfflineDB>> | null {
  const userId = getOfflineUserId();
  if (!userId) return null;
  if (cached?.userId !== userId) {
    cached = {
      userId,
      db: openDB<OfflineDB>(dbName(userId), 1, {
        upgrade(database) {
          if (!database.objectStoreNames.contains("downloads")) {
            database.createObjectStore("downloads", { keyPath: "bookId" });
          }
          if (!database.objectStoreNames.contains("files")) {
            const store = database.createObjectStore("files", { keyPath: "fileId" });
            store.createIndex("bookId", "bookId");
          }
          if (!database.objectStoreNames.contains("progressQueue")) {
            database.createObjectStore("progressQueue", { keyPath: "bookId" });
          }
        }
      })
    };
  }
  return cached.db;
}

export async function getDownload(bookId: string): Promise<DownloadRecord | null> {
  const handle = db();
  if (!handle) return null;
  try {
    return (await (await handle).get("downloads", bookId)) ?? null;
  } catch {
    return null;
  }
}

export async function listDownloads(): Promise<DownloadRecord[]> {
  const handle = db();
  if (!handle) return [];
  try {
    const all = await (await handle).getAll("downloads");
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

export async function deleteDownload(bookId: string): Promise<void> {
  const handle = db();
  if (!handle) return;
  const database = await handle;
  const tx = database.transaction(["downloads", "files", "progressQueue"], "readwrite");
  const fileKeys = await tx.objectStore("files").index("bookId").getAllKeys(bookId);
  await Promise.all(fileKeys.map((key) => tx.objectStore("files").delete(key)));
  await tx.objectStore("downloads").delete(bookId);
  await tx.objectStore("progressQueue").delete(bookId);
  await tx.done;
}

/**
 * Download every available chapter of a book into local storage, reporting
 * progress (0–1). Streams each response so progress reflects bytes received.
 * Throws on network/quota failure, leaving the record marked "failed".
 */
export async function downloadBook(
  book: AudiobookBookDetail,
  onProgress?: (fraction: number) => void
): Promise<DownloadRecord> {
  const handle = db();
  if (!handle) throw new Error("Sign in to download books for offline use.");
  const database = await handle;

  const files = book.files.filter((f) => f.status === "available");
  if (files.length === 0) throw new Error("This book has no downloadable audio.");

  const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
  const record: DownloadRecord = {
    bookId: book.id,
    title: book.title,
    authors: book.authors,
    coverUrl: book.coverLargeUrl ?? book.coverUrl,
    files: files.map((f) => ({
      id: f.id,
      relativePath: f.relativePath,
      chapterTitle: f.chapterTitle,
      durationSeconds: f.durationSeconds,
      size: f.size,
      mimeType: f.mimeType
    })),
    totalBytes,
    downloadedBytes: 0,
    state: "downloading",
    createdAt: new Date().toISOString()
  };
  await database.put("downloads", record);

  let downloaded = 0;
  try {
    for (const file of files) {
      const res = await fetch(`/api/library/books/${book.id}/stream/${file.id}`, { credentials: "include" });
      if (!res.ok || !res.body) throw new Error(`Couldn't download a chapter (status ${res.status}).`);

      const reader = res.body.getReader();
      const chunks: BlobPart[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        downloaded += value.byteLength;
        onProgress?.(totalBytes > 0 ? Math.min(downloaded / totalBytes, 0.999) : 0);
      }

      const blob = new Blob(chunks, { type: file.mimeType ?? "application/octet-stream" });
      await database.put("files", { fileId: file.id, bookId: book.id, blob });
    }

    record.state = "complete";
    record.downloadedBytes = totalBytes;
    await database.put("downloads", record);
    onProgress?.(1);
    return record;
  } catch (err) {
    record.state = "failed";
    record.downloadedBytes = downloaded;
    await database.put("downloads", record).catch(() => {});
    throw err instanceof Error ? err : new Error("Download failed.");
  }
}

/**
 * If a chapter is downloaded, return an object URL for local playback (caller
 * must revoke it). Returns null when the file isn't stored locally.
 */
export async function getDownloadedFileUrl(fileId: string): Promise<string | null> {
  const handle = db();
  if (!handle) return null;
  try {
    const stored = await (await handle).get("files", fileId);
    return stored ? URL.createObjectURL(stored.blob) : null;
  } catch {
    return null;
  }
}

export interface StorageEstimate {
  usage: number;
  quota: number;
}

export async function estimateStorage(): Promise<StorageEstimate | null> {
  if (!navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}
