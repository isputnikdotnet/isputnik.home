import fs from "node:fs";
import { db } from "../../../db.js";
import { binRootFor } from "./trash-settings.js";
import { purgeTrashedItem, removeTrashFiles } from "./trash.js";
import type { TrashedItemRow } from "../../../db/rows.js";

// Auto-purge everything past the retention window. Items whose source volume is currently
// offline are skipped (so their files aren't orphaned) and retried on the next sweep —
// hence two counts: how many were due, and how many actually went.
export function purgeExpiredTrash(): { purged: number; eligible: number } {
  // Each row carries its own date, written when it was trashed. Changing the setting
  // now therefore governs only what is deleted from now on — it cannot reach back and
  // shorten a promise already made.
  const expired = db.prepare(
    "SELECT * FROM trashed_items WHERE expires_at IS NOT NULL AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
  ).all() as TrashedItemRow[];
  let purged = 0;
  for (const item of expired) {
    if (!fs.existsSync(binRootFor(item))) continue;
    try {
      removeTrashFiles(item);
      db.prepare("DELETE FROM trashed_items WHERE id = ?").run(item.id);
      purged += 1;
    } catch {
      // leave the row in place; the next sweep retries
    }
  }
  return { purged, eligible: expired.length };
}

// Empty the bin — every item, or just one library's. Returns the count purged.
export function emptyTrash(libraryId?: string): number {
  const rows = (libraryId
    ? db.prepare("SELECT id FROM trashed_items WHERE library_id = ?").all(libraryId)
    : db.prepare("SELECT id FROM trashed_items").all()) as Pick<TrashedItemRow, "id">[];
  let purged = 0;
  for (const row of rows) {
    if (purgeTrashedItem(row.id)) purged += 1;
  }
  return purged;
}

// Periodic sweeper, mirroring startAudiobookScanWorker: runs shortly after boot, then every
// six hours. Returns a stop function for the plugin's onClose hook.
export function startTrashPurgeWorker(): () => void {
  const timer = setInterval(() => {
    try { purgeExpiredTrash(); } catch { /* swallow; retried next tick */ }
  }, 6 * 60 * 60 * 1000);
  timer.unref?.();
  const kickoff = setTimeout(() => {
    try { purgeExpiredTrash(); } catch { /* ignore */ }
  }, 30 * 1000);
  kickoff.unref?.();
  return () => { clearInterval(timer); clearTimeout(kickoff); };
}
