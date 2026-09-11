// The rotation-aware half of the Photo Inbox check (docs/photo-inbox-proposal.md,
// decision 8). Scans come in sideways, and a dHash turned 90° shares no bits with
// its upright twin. The collection keeps one hash per photo; the Inbox's photos —
// a delivery, not a library — are hashed the other three ways as well, from the
// cached preview, and the extra hashes ride into the near-identical grouping as
// variants. Nothing is stored: three small sharp ops per incoming photo, once per
// scan, is cheaper than a schema for a case only scans produce.
import { db } from "../../../../db.js";
import { thumbnailAbsolutePath } from "../../shared/thumbnail.js";
import { computeDhash } from "../media.js";
import type { GalleryDetailRow, LibraryItemRow } from "../../../../db/rows.js";

export const INBOX_ROTATIONS = [90, 180, 270] as const;

/** Item id → the fingerprints of the photo turned 90/180/270°. Photos without a
 *  preview or a fingerprint of their own are left out — the scan has nothing to
 *  turn, and no upright hash to match against either. */
export async function inboxNearVariants(inboxLibraryId: string): Promise<Map<string, string[]>> {
  const rows = db.prepare(`
    SELECT li.id, gd.preview_storage_key AS preview
    FROM library_items li
    JOIN gallery_details gd ON gd.item_id = li.id
    WHERE li.library_id = ? AND li.deleted_at IS NULL AND li.status = 'ready'
      AND gd.kind = 'photo' AND gd.phash IS NOT NULL AND gd.preview_storage_key IS NOT NULL
  `).all(inboxLibraryId) as (Pick<LibraryItemRow, "id"> & { preview: NonNullable<GalleryDetailRow["preview_storage_key"]> })[];

  const variants = new Map<string, string[]>();
  for (const row of rows) {
    let source: string;
    try { source = thumbnailAbsolutePath(row.preview); } catch { continue; }
    const hashes: string[] = [];
    for (const rotation of INBOX_ROTATIONS) {
      const hash = await computeDhash(source, rotation);
      if (hash) hashes.push(hash);
    }
    if (hashes.length > 0) variants.set(row.id, hashes);
  }
  return variants;
}
