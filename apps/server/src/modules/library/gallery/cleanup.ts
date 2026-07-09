// Gallery "missing photos" housekeeping. A scan reconcile soft-deletes an asset whose
// file has vanished from disk by setting library_items.deleted_at — a hidden TOMBSTONE
// (its metadata + cached thumbnail are kept so a returning file revives it intact). This
// module surfaces those tombstones and permanently purges the ones past a grace window.
//
// Why deleted_at unambiguously means "missing on disk" for gallery: the Recycle Bin does a
// HARD teardown (deleteBookRecord DELETEs the library_items row) and lives in trashed_items,
// so a gallery library_items row with deleted_at set is ONLY ever a reconcile tombstone.
import { db, logActivity } from "../../../db.js";
import { purgeCataloguedItem } from "../shared/trash.js";

const RETENTION_KEY = "gallery_missing_retention_days";
const DEFAULT_MISSING_RETENTION_DAYS = 30;

export interface MissingPhoto {
  id: string;
  libraryId: string;
  libraryName: string;
  path: string;
  title: string;
  coverUrl: string | null; // last-known thumbnail (kept until purge), for the admin list
  detectedAt: string; // when the scan first found it gone (= deleted_at)
  purgesAt: string | null; // when auto-purge is due, or null when retention is disabled
}

// Days a missing photo lingers before auto-purge. 0 = never (keep tombstones forever).
export function getMissingRetentionDays(): number {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(RETENTION_KEY) as { value: string } | undefined;
  if (!row) return DEFAULT_MISSING_RETENTION_DAYS;
  const parsed = Number.parseInt(row.value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MISSING_RETENTION_DAYS;
}

export function setMissingRetentionDays(days: number, userId: string | null): number {
  const clamped = Math.max(0, Math.min(3650, Math.floor(days))); // cap at ~10 years
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_by, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(RETENTION_KEY, String(clamped), userId);
  return clamped;
}

interface MissingRow {
  id: string;
  folder_path: string;
  deleted_at: string;
  library_id: string;
  library_name: string;
  title: string;
  cover: string | null;
}

const MISSING_SELECT = `
  SELECT li.id, li.folder_path, li.deleted_at, li.library_id,
         lib.name AS library_name,
         COALESCE(im.title, li.folder_path) AS title,
         im.cover_storage_key AS cover
  FROM library_items li
  JOIN libraries lib ON lib.id = li.library_id AND lib.type = 'gallery'
  LEFT JOIN item_metadata im ON im.item_id = li.id
  WHERE li.deleted_at IS NOT NULL
`;

function purgesAt(detectedAt: string, days: number): string | null {
  if (days <= 0) return null;
  const at = new Date(detectedAt).getTime();
  if (!Number.isFinite(at)) return null;
  return new Date(at + days * 24 * 60 * 60 * 1000).toISOString();
}

// Every gallery tombstone (missing-on-disk asset), newest first, with its last-known
// thumbnail and the date it's due to be auto-purged.
export function listMissingGalleryPhotos(): { items: MissingPhoto[]; retentionDays: number } {
  const days = getMissingRetentionDays();
  const rows = db.prepare(`${MISSING_SELECT} ORDER BY datetime(li.deleted_at) DESC, li.id`).all() as MissingRow[];
  const items = rows.map((row) => ({
    id: row.id,
    libraryId: row.library_id,
    libraryName: row.library_name,
    path: row.folder_path,
    title: row.title,
    coverUrl: row.cover ? `/api/library/covers/${row.cover}` : null,
    detectedAt: row.deleted_at,
    purgesAt: purgesAt(row.deleted_at, days)
  }));
  return { items, retentionDays: days };
}

// A short "a.jpg, b/c.jpg, … +N more" summary of paths for an activity-log detail line.
function samplePaths(paths: string[], keep = 8): string {
  const shown = paths.slice(0, keep).join(", ");
  const extra = paths.length - keep;
  return extra > 0 ? `${shown} … +${extra} more` : shown;
}

// Purge one tombstone immediately (admin action), regardless of the grace window. Returns
// false if the id isn't a current gallery tombstone.
export function purgeMissingGalleryPhoto(itemId: string, actorUserId: string | null): boolean {
  const row = db.prepare(`${MISSING_SELECT} AND li.id = ?`).get(itemId) as MissingRow | undefined;
  if (!row) return false;
  if (!purgeCataloguedItem(itemId)) return false;
  logActivity({
    event: "library.gallery.photos_purged",
    actorUserId,
    targetType: "library",
    targetId: row.library_id,
    detail: `Permanently removed missing photo "${row.folder_path}".`,
    ipAddress: null
  });
  return true;
}

// Purge every tombstone older than the grace window (the scheduled cleanup job). When
// `retentionDays` is omitted the configured value is used; 0 disables auto-purge entirely.
export function purgeMissingGalleryPhotos(retentionDays?: number, actorUserId: string | null = null): { purged: number; eligible: number } {
  const days = retentionDays ?? getMissingRetentionDays();
  if (days <= 0) return { purged: 0, eligible: 0 };
  const rows = db.prepare(`${MISSING_SELECT} AND datetime(li.deleted_at) <= datetime('now', ?)`)
    .all(`-${days} days`) as MissingRow[];

  const purgedPaths: string[] = [];
  for (const row of rows) {
    if (purgeCataloguedItem(row.id)) purgedPaths.push(row.folder_path);
  }
  if (purgedPaths.length > 0) {
    logActivity({
      event: "library.gallery.photos_purged",
      actorUserId,
      targetType: "library",
      targetId: null,
      detail: `Purged ${purgedPaths.length} missing photo${purgedPaths.length === 1 ? "" : "s"} past the ${days}-day window: ${samplePaths(purgedPaths)}.`,
      ipAddress: null
    });
  }
  return { purged: purgedPaths.length, eligible: rows.length };
}
