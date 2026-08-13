// Manual metadata edits for a gallery asset (title/caption, description, date
// taken, tags, location). Marks item_metadata.source = 'manual' and, when a date
// or location is given, the matching gallery_details *_source = 'manual', so a
// rescan preserves the edits.
import { db } from "../../../db.js";
import { setEntityTags } from "../audiobook/categorize.js";
import { applyItemAlphaIndex } from "../shared/alphabet-index.js";

export interface GalleryAssetEdit {
  title: string;
  description: string | null;
  takenAt: string | null; // ISO; null = leave the existing date untouched
  tags: string[];
  // undefined = leave the existing location untouched; null = remove it;
  // a point = set it. Any change marks the location user-owned (gps_source).
  gps?: { lat: number; lng: number } | null;
}

// The subset the multi-select bar edits: when a camera had no GPS or the wrong
// clock, one date/place is stamped onto the whole selection. Undefined = leave
// that field alone; a value marks it manual so a rescan keeps it.
export interface GalleryPlaceTimeEdit {
  takenAt?: string; // ISO — the same instant on every item
  // ± minutes added to each item's *own* date, so their spacing is preserved
  // (a camera left on the wrong timezone). Mutually exclusive with takenAt.
  shiftMinutes?: number;
  gps?: { lat: number; lng: number };
}

function sortName(value: string): string {
  return value.trim().toLowerCase();
}

export function updateGalleryAsset(itemId: string, data: GalleryAssetEdit): boolean {
  const exists = db.prepare("SELECT item_id FROM gallery_details WHERE item_id = ?").get(itemId);
  if (!exists) return false;

  db.transaction(() => {
    db.prepare(`
      INSERT INTO item_metadata (item_id, source, title, sort_title, description)
      VALUES (?, 'manual', ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        source = 'manual',
        title = excluded.title,
        sort_title = excluded.sort_title,
        description = excluded.description,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(itemId, data.title, sortName(data.title), data.description);
    applyItemAlphaIndex(itemId);

    if (data.takenAt) {
      db.prepare(
        "UPDATE gallery_details SET taken_at = ?, taken_at_source = 'manual', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_id = ?"
      ).run(data.takenAt, itemId);
    }

    if (data.gps !== undefined) {
      db.prepare(
        "UPDATE gallery_details SET gps_lat = ?, gps_lng = ?, gps_source = 'manual', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_id = ?"
      ).run(data.gps?.lat ?? null, data.gps?.lng ?? null, itemId);
    }

    setEntityTags("library_item", itemId, data.tags);
  })();

  return true;
}

// Stamp one date and/or one location onto many assets at once, or shift each
// asset's own date by an offset (the wrong-timezone fix, which has to keep the
// relative order the camera recorded). Ids without a gallery_details row (never
// scanned, wrong media type) are skipped, and a shift can't touch an asset with
// no date at all — both are reported so the caller can say so. Permission is the
// caller's job.
export function setGalleryPlaceAndTime(
  itemIds: string[],
  data: GalleryPlaceTimeEdit
): { updated: number; noDate: number } {
  const empty = { updated: 0, noDate: 0 };
  if (itemIds.length === 0) return empty;
  if (data.takenAt === undefined && data.shiftMinutes === undefined && data.gps === undefined) return empty;

  const read = db.prepare("SELECT taken_at FROM gallery_details WHERE item_id = ?");
  const setDate = db.prepare(
    "UPDATE gallery_details SET taken_at = ?, taken_at_source = 'manual', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_id = ?"
  );
  const setGps = db.prepare(
    "UPDATE gallery_details SET gps_lat = ?, gps_lng = ?, gps_source = 'manual', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_id = ?"
  );

  return db.transaction(() => {
    let updated = 0;
    let noDate = 0;
    for (const itemId of itemIds) {
      const row = read.get(itemId) as { taken_at: string | null } | undefined;
      if (!row) continue;

      let touched = false;
      if (data.takenAt !== undefined) {
        setDate.run(data.takenAt, itemId);
        touched = true;
      } else if (data.shiftMinutes !== undefined) {
        // Shifted in JS rather than SQLite's date functions so an unparseable
        // stored value is skipped instead of silently becoming NULL.
        const from = row.taken_at ? new Date(row.taken_at) : null;
        if (!from || Number.isNaN(from.getTime())) {
          noDate += 1;
        } else {
          setDate.run(new Date(from.getTime() + data.shiftMinutes * 60_000).toISOString(), itemId);
          touched = true;
        }
      }

      if (data.gps !== undefined) {
        setGps.run(data.gps.lat, data.gps.lng, itemId);
        touched = true;
      }
      if (touched) updated += 1;
    }
    return { updated, noDate };
  })();
}
