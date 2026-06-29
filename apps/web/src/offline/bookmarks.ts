import { api } from "../api";
import { openOfflineDb, type QueuedBookmark } from "./downloads";
import type { EbookBookmark } from "../features/audiobooks/types";

// Offline capture for reader bookmarks. Same shape as offline/quotes.ts: persist
// the bookmark so it survives no-connection reading, POST it, and retry on
// reconnect via flushBookmarkQueue(). A successful POST deletes the local row
// (bookmarks are append-only — no latest-wins reconciliation like progress).

interface BookmarkInput {
  bookId: string;
  documentId: string;
  cfi: string;
  percentComplete: number | null;
  label: string | null;
  note: string | null;
}

function postBookmark(input: BookmarkInput) {
  return api<{ bookmark: EbookBookmark }>(`/api/library/books/${input.bookId}/ebook-bookmarks`, {
    method: "POST",
    body: JSON.stringify({
      documentId: input.documentId,
      cfi: input.cfi,
      percentComplete: input.percentComplete,
      label: input.label,
      note: input.note
    })
  });
}

function newLocalId(): string {
  try {
    return `local-${crypto.randomUUID()}`;
  } catch {
    return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export function isLocalBookmarkId(id: string): boolean {
  return id.startsWith("local-");
}

function syntheticBookmark(row: QueuedBookmark): EbookBookmark {
  return {
    id: row.localId,
    documentId: row.documentId,
    cfi: row.cfi,
    percentComplete: row.percentComplete,
    label: row.label,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.createdAt
  };
}

/**
 * Save a bookmark: POST it when online, otherwise persist it locally and return a
 * synthetic bookmark (keyed by a local id) so it appears in the panel immediately.
 */
export async function saveBookmark(input: BookmarkInput): Promise<EbookBookmark> {
  try {
    const { bookmark } = await postBookmark(input);
    return bookmark;
  } catch {
    const row: QueuedBookmark = {
      localId: newLocalId(),
      bookId: input.bookId,
      documentId: input.documentId,
      cfi: input.cfi,
      percentComplete: input.percentComplete,
      label: input.label,
      note: input.note,
      createdAt: new Date().toISOString(),
      synced: false
    };
    const handle = openOfflineDb();
    if (handle) {
      try { await (await handle).put("bookmarksQueue", row); } catch { /* private mode / quota */ }
    }
    return syntheticBookmark(row);
  }
}

/** Pending (unsynced) bookmarks for a document. */
export async function getLocalBookmarks(documentId: string): Promise<EbookBookmark[]> {
  const handle = openOfflineDb();
  if (!handle) return [];
  try {
    const rows = await (await handle).getAllFromIndex("bookmarksQueue", "documentId", documentId);
    return rows.map(syntheticBookmark);
  } catch {
    return [];
  }
}

export async function deleteLocalBookmark(localId: string): Promise<void> {
  const handle = openOfflineDb();
  if (!handle) return;
  try { await (await handle).delete("bookmarksQueue", localId); } catch { /* ignore */ }
}

export async function updateLocalBookmarkNote(localId: string, note: string): Promise<void> {
  const handle = openOfflineDb();
  if (!handle) return;
  try {
    const db = await handle;
    const row = await db.get("bookmarksQueue", localId);
    if (row) await db.put("bookmarksQueue", { ...row, note: note || null });
  } catch { /* ignore */ }
}

/** Push every pending bookmark to the server, deleting each on success. Returns count flushed. */
export async function flushBookmarkQueue(): Promise<number> {
  const handle = openOfflineDb();
  if (!handle) return 0;
  let flushed = 0;
  try {
    const db = await handle;
    const rows = await db.getAll("bookmarksQueue");
    for (const row of rows) {
      try {
        await postBookmark(row);
        await db.delete("bookmarksQueue", row.localId);
        flushed += 1;
      } catch {
        // Still offline / failing — keep it for the next attempt.
      }
    }
  } catch { /* ignore */ }
  return flushed;
}
