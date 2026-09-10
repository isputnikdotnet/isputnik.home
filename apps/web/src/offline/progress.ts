import { api } from "../api";
import { openOfflineDb, type QueuedProgress } from "./downloads";

function patchServer(bookId: string, fileId: string, positionSeconds: number, keepalive = false) {
  // Through api(), never a bare fetch: a mutation without the CSRF header is
  // refused by the server, which is how the position saved on leaving the page
  // was silently lost for a while.
  return api(`/api/library/books/${bookId}/progress`, {
    method: "PATCH",
    body: JSON.stringify({ fileId, positionSeconds: Math.floor(positionSeconds) }),
    keepalive
  });
}

/**
 * Record a playback position locally (always, so it survives offline) and try to
 * push it to the server. If the push fails the row stays `synced: false` and is
 * retried by flushProgressQueue() on reconnect.
 *
 * The server write is dispatched before the first await: the player calls this
 * as the page is being left, and a request that has already gone out (with
 * `keepalive`) survives the page being torn down, while work after an await may
 * never run.
 */
export async function persistProgress(
  bookId: string,
  fileId: string,
  positionSeconds: number,
  opts: { keepalive?: boolean } = {}
): Promise<void> {
  const handle = openOfflineDb();
  const stamp = Date.now();
  const row: QueuedProgress = { bookId, fileId, positionSeconds, updatedAt: stamp, synced: false };

  const push = patchServer(bookId, fileId, positionSeconds, opts.keepalive === true);
  // Awaited below; this keeps a failure from surfacing as unhandled meanwhile.
  push.catch(() => undefined);

  if (handle) {
    try { await (await handle).put("progressQueue", row); } catch { /* private mode / quota */ }
  }

  try {
    await push;
    // Only mark synced if no newer write landed in the meantime.
    if (handle) {
      try {
        const db = await handle;
        const current = await db.get("progressQueue", bookId);
        if (current && current.updatedAt === stamp) await db.put("progressQueue", { ...current, synced: true });
      } catch { /* ignore */ }
    }
  } catch {
    // Offline or server error — leave the row unsynced for the next flush.
    // Without local storage there's nothing we can do; the write is simply lost,
    // matching the previous best-effort behaviour.
  }
}

/** Push every unsynced position to the server. Returns how many synced. */
export async function flushProgressQueue(): Promise<number> {
  const handle = openOfflineDb();
  if (!handle) return 0;
  let flushed = 0;
  try {
    const db = await handle;
    const rows = await db.getAll("progressQueue");
    for (const row of rows) {
      if (row.synced) continue;
      try {
        await patchServer(row.bookId, row.fileId, row.positionSeconds);
        const current = await db.get("progressQueue", row.bookId);
        // Don't clobber a fresher unsynced write that arrived during the flush.
        if (current && current.updatedAt === row.updatedAt) {
          await db.put("progressQueue", { ...current, synced: true });
        }
        flushed += 1;
      } catch {
        // Still offline / failing — keep it for the next attempt.
      }
    }
  } catch { /* ignore */ }
  return flushed;
}

/**
 * Local position for a book, or null. An unsynced row is authoritative on resume
 * (it's newer than whatever the server has); a synced row is only a fallback for
 * when the server can't be reached.
 */
export async function getLocalProgress(bookId: string): Promise<QueuedProgress | null> {
  const handle = openOfflineDb();
  if (!handle) return null;
  try {
    return (await (await handle).get("progressQueue", bookId)) ?? null;
  } catch {
    return null;
  }
}
