import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { PublicUser } from "../api";
import type { AudiobookBookDetail } from "../features/audiobooks/types";

// Offline storage is namespaced per user so a shared family device never exposes
// one account's downloads to another login. The current user's id is stashed in
// localStorage at sign-in (see App.tsx) because /api/auth/me is unreachable offline.
const UID_KEY = "isputnik-uid";
const USER_KEY = "isputnik-user";

export function setOfflineUserId(id: string) {
  try { localStorage.setItem(UID_KEY, id); } catch { /* private mode */ }
}

export function getOfflineUserId(): string | null {
  try { return localStorage.getItem(UID_KEY); } catch { return null; }
}

// Cache the signed-in user so the app can authenticate "offline" against the last
// known identity (the server is unreachable with no network).
export function cacheCurrentUser(user: PublicUser) {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    localStorage.setItem(UID_KEY, user.id);
  } catch { /* private mode */ }
}

export function getCachedUser(): PublicUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as PublicUser) : null;
  } catch {
    return null;
  }
}

export function clearCachedUser() {
  try { localStorage.removeItem(USER_KEY); } catch { /* ignore */ }
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
  bookDetail?: AudiobookBookDetail;
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

// Latest local playback position per book. `synced: false` means the server
// hasn't received this write yet (offline, or a failed PATCH), so it's strictly
// newer than the server's value and wins on resume. Flushed on reconnect.
export interface QueuedProgress {
  bookId: string;
  fileId: string;
  positionSeconds: number;
  updatedAt: number;
  synced: boolean;
}

export interface EbookDownloadRecord {
  bookId: string;
  documentId: string;
  title: string;
  authors: string[];
  coverUrl: string | null;
  totalBytes: number;
  downloadedBytes: number;
  state: DownloadState;
  createdAt: string;
}

interface StoredEbookFile {
  key: string; // `${bookId}:${documentId}`
  blob: Blob;
}

interface OfflineDB extends DBSchema {
  downloads: { key: string; value: DownloadRecord };
  files: { key: string; value: StoredFile; indexes: { bookId: string } };
  progressQueue: { key: string; value: QueuedProgress };
  ebookDownloads: { key: string; value: EbookDownloadRecord };
  ebookFiles: { key: string; value: StoredEbookFile };
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
      db: openDB<OfflineDB>(dbName(userId), 2, {
        upgrade(database, oldVersion) {
          if (oldVersion < 1) {
            database.createObjectStore("downloads", { keyPath: "bookId" });
            const store = database.createObjectStore("files", { keyPath: "fileId" });
            store.createIndex("bookId", "bookId");
            database.createObjectStore("progressQueue", { keyPath: "bookId" });
          }
          if (oldVersion < 2) {
            database.createObjectStore("ebookDownloads", { keyPath: "bookId" });
            database.createObjectStore("ebookFiles", { keyPath: "key" });
          }
        }
      })
    };
  }
  return cached.db;
}

// Shared opener for sibling offline modules (e.g. progress sync). Returns null
// when no user id is known (signed out / guest share view).
export function openOfflineDb(): Promise<IDBPDatabase<OfflineDB>> | null {
  return db();
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

function detailFromDownloadRecord(record: DownloadRecord): AudiobookBookDetail {
  if (record.bookDetail) return record.bookDetail;

  const durationSeconds = record.files.every((file) => file.durationSeconds != null)
    ? record.files.reduce((sum, file) => sum + (file.durationSeconds ?? 0), 0)
    : null;

  return {
    id: record.bookId,
    libraryId: "offline",
    libraryName: "Downloaded",
    progressMode: "linear",
    folderPath: "",
    status: "ready",
    title: record.title,
    series: null,
    seriesPosition: null,
    authors: record.authors,
    narrators: [],
    category: null,
    tags: [],
    language: null,
    fileCount: record.files.length,
    totalSize: record.totalBytes,
    durationSeconds,
    coverUrl: record.coverUrl,
    coverLargeUrl: record.coverUrl,
    publisher: null,
    asin: null,
    saved: false,
    discoveredAt: record.createdAt,
    updatedAt: record.createdAt,
    seriesId: null,
    description: null,
    yearPublished: null,
    isbn: null,
    openLibraryId: null,
    metadataSource: "scan",
    files: record.files.map((file, index) => ({
      id: file.id,
      relativePath: file.relativePath,
      mimeType: file.mimeType,
      trackNumber: index + 1,
      chapterTitle: file.chapterTitle,
      durationSeconds: file.durationSeconds,
      size: file.size,
      modifiedAt: null,
      status: "available"
    })),
    documents: []
  };
}

export async function getDownloadedBookDetail(bookId: string): Promise<AudiobookBookDetail | null> {
  const record = await getDownload(bookId);
  if (!record || record.state !== "complete") return null;
  return detailFromDownloadRecord(record);
}

async function responseBlobWithProgress(
  response: Response,
  mimeType: string,
  onBytes: (bytes: number) => void
): Promise<Blob> {
  if (!response.body) throw new Error("This browser could not stream the chapter.");

  if ("TransformStream" in window) {
    const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        onBytes(chunk.byteLength);
        controller.enqueue(chunk);
      }
    }));
    return new Response(stream, { headers: { "Content-Type": mimeType } }).blob();
  }

  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    onBytes(value.byteLength);
  }
  return new Blob(chunks, { type: mimeType });
}

// Best-effort: fetch a cover URL so the service worker caches it (covers use a
// NetworkFirst runtime cache), making the artwork available offline later. The
// on-screen thumbnail is usually cached from browsing, but the large cover used
// on the player / detail page often isn't until it's first viewed online.
function warmCover(url: string | null | undefined): void {
  if (!url) return;
  void fetch(url, { credentials: "include" }).catch(() => {});
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

  // Try to make storage persistent so the OS won't evict downloads under pressure.
  void requestPersistentStorage();

  const files = book.files.filter((f) => f.status === "available");
  if (files.length === 0) throw new Error("This book has no downloadable audio.");

  const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
  const record: DownloadRecord = {
    bookId: book.id,
    title: book.title,
    authors: book.authors,
    coverUrl: book.coverLargeUrl ?? book.coverUrl,
    bookDetail: book,
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
  warmCover(book.coverLargeUrl);
  warmCover(book.coverUrl);

  let downloaded = 0;
  try {
    for (const file of files) {
      const res = await fetch(`/api/library/books/${book.id}/stream/${file.id}`, { credentials: "include" });
      if (!res.ok || !res.body) throw new Error(`Couldn't download a chapter (status ${res.status}).`);

      const mimeType = file.mimeType ?? "application/octet-stream";
      const blob = await responseBlobWithProgress(res, mimeType, (bytes) => {
        downloaded += bytes;
        onProgress?.(totalBytes > 0 ? Math.min(downloaded / totalBytes, 0.999) : 0);
      });
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
  persisted: boolean;
}

export async function estimateStorage(): Promise<StorageEstimate | null> {
  if (!navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  const persisted = navigator.storage.persisted ? await navigator.storage.persisted().catch(() => false) : false;
  return { usage, quota, persisted };
}

/**
 * Ask the browser to keep our storage from being evicted under pressure. Best
 * effort: some browsers grant silently, others ignore it. Safe to call repeatedly.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

// ── Ebook offline downloads ───────────────────────────────────────────────────

export async function getEbookDownload(bookId: string): Promise<EbookDownloadRecord | null> {
  const handle = db();
  if (!handle) return null;
  try {
    return (await (await handle).get("ebookDownloads", bookId)) ?? null;
  } catch {
    return null;
  }
}

export async function listEbookDownloads(): Promise<EbookDownloadRecord[]> {
  const handle = db();
  if (!handle) return [];
  try {
    const all = await (await handle).getAll("ebookDownloads");
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

export async function deleteEbookDownload(bookId: string): Promise<void> {
  const handle = db();
  if (!handle) return;
  const database = await handle;
  const record = await database.get("ebookDownloads", bookId);
  const tx = database.transaction(["ebookDownloads", "ebookFiles"], "readwrite");
  if (record) {
    await tx.objectStore("ebookFiles").delete(`${bookId}:${record.documentId}`);
  }
  await tx.objectStore("ebookDownloads").delete(bookId);
  await tx.done;
}

/**
 * Download an EPUB document into local IndexedDB storage. The url must be the
 * server-side document URL (credentials are included automatically).
 */
export async function downloadEbook(
  bookId: string,
  documentId: string,
  url: string,
  meta: { title: string; authors: string[]; coverUrl: string | null; totalBytes: number },
  onProgress?: (fraction: number) => void
): Promise<EbookDownloadRecord> {
  const handle = db();
  if (!handle) throw new Error("Sign in to download books for offline use.");
  const database = await handle;

  void requestPersistentStorage();

  const record: EbookDownloadRecord = {
    bookId,
    documentId,
    title: meta.title,
    authors: meta.authors,
    coverUrl: meta.coverUrl,
    totalBytes: meta.totalBytes,
    downloadedBytes: 0,
    state: "downloading",
    createdAt: new Date().toISOString()
  };
  await database.put("ebookDownloads", record);
  warmCover(meta.coverUrl);

  let downloaded = 0;
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok || !res.body) throw new Error(`Couldn't download ebook (status ${res.status}).`);

    const blob = await responseBlobWithProgress(res, "application/epub+zip", (bytes) => {
      downloaded += bytes;
      onProgress?.(meta.totalBytes > 0 ? Math.min(downloaded / meta.totalBytes, 0.999) : 0);
    });

    await database.put("ebookFiles", { key: `${bookId}:${documentId}`, blob });

    record.state = "complete";
    record.downloadedBytes = meta.totalBytes;
    await database.put("ebookDownloads", record);
    onProgress?.(1);
    return record;
  } catch (err) {
    record.state = "failed";
    record.downloadedBytes = downloaded;
    await database.put("ebookDownloads", record).catch(() => {});
    throw err instanceof Error ? err : new Error("Download failed.");
  }
}

/**
 * Retrieve a downloaded EPUB as a Blob. Returns null when not stored locally.
 * Caller is responsible for revoking any object URL created from the blob.
 */
export async function getDownloadedEpubBlob(bookId: string, documentId: string): Promise<Blob | null> {
  const handle = db();
  if (!handle) return null;
  try {
    const stored = await (await handle).get("ebookFiles", `${bookId}:${documentId}`);
    return stored?.blob ?? null;
  } catch {
    return null;
  }
}
