// Manual metadata edits for a gallery asset (title/caption, description, date
// taken, tags, location, place as text). Marks item_metadata.source = 'manual'
// and, when a date or location is given, the matching gallery_details *_source =
// 'manual', so a rescan preserves the edits.
import { db } from "../../../db.js";
import { addEntityTags, removeEntityTags, setEntityTags } from "../shared/tagging.js";
import { applyItemAlphaIndex } from "../shared/alphabet-index.js";
import { floorTakenAt, type TakenPrecision } from "./taken-precision.js";
import type { GalleryDetailRow } from "../../../db/rows.js";
import { requestPhotoPlaceSweep } from "./places.js";

export interface GalleryAssetEdit {
  title: string;
  description: string | null;
  takenAt: string | null; // ISO; null = leave the existing date untouched
  // How much of takenAt is known (docs/photo-review-plan.md). Omitted with a
  // takenAt = a full instant was given, so 'time' and exact; omitted without one
  // = leave the stored precision alone. `takenAt` is floored to the period.
  takenPrecision?: TakenPrecision;
  takenApprox?: boolean;
  // undefined = leave the place as written untouched; null = clear it.
  placeText?: string | null;
  tags: string[];
  // undefined = leave the existing location untouched; null = remove it;
  // a point = set it. Any change marks the location user-owned (gps_source).
  gps?: { lat: number; lng: number } | null;
  // Mark the photo as gone through in Review mode, by this user.
  reviewedBy?: string;
}

// The subset the multi-select bar edits: when a camera had no GPS or the wrong
// clock, one date/place is stamped onto the whole selection. Undefined = leave
// that field alone; a value marks it manual so a rescan keeps it.
export interface GalleryPlaceTimeEdit {
  takenAt?: string; // ISO — the same instant on every item
  takenPrecision?: TakenPrecision;
  takenApprox?: boolean;
  // ± minutes added to each item's *own* date, so their spacing is preserved
  // (a camera left on the wrong timezone). Mutually exclusive with takenAt.
  shiftMinutes?: number;
  gps?: { lat: number; lng: number };
  placeText?: string | null;
}

function sortName(value: string): string {
  return value.trim().toLowerCase();
}

const SET_DATE_SQL = `UPDATE gallery_details
  SET taken_at = ?, taken_precision = ?, taken_approx = ?, taken_at_source = 'manual',
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE item_id = ?`;

const SET_PLACE_TEXT_SQL =
  "UPDATE gallery_details SET place_text = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_id = ?";

/** Stamp a reviewed mark on a photo. Returns false when it isn't a gallery asset. */
export function markGalleryAssetReviewed(itemId: string, userId: string): boolean {
  const result = db.prepare(
    "UPDATE gallery_details SET reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), reviewed_by = ? WHERE item_id = ?"
  ).run(userId, itemId);
  return result.changes > 0;
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
      const precision = data.takenPrecision ?? "time";
      const floored = floorTakenAt(data.takenAt, precision);
      if (floored) {
        db.prepare(SET_DATE_SQL).run(floored, precision, data.takenApprox ? 1 : 0, itemId);
      }
    } else if (data.takenPrecision !== undefined || data.takenApprox !== undefined) {
      // Only the reading of an existing date changed ("about", or "just the year").
      const row = db.prepare("SELECT taken_at, taken_precision, taken_approx FROM gallery_details WHERE item_id = ?")
        .get(itemId) as Pick<GalleryDetailRow, "taken_at" | "taken_precision" | "taken_approx">;
      if (row.taken_at) {
        const precision = data.takenPrecision ?? row.taken_precision;
        const floored = floorTakenAt(row.taken_at, precision) ?? row.taken_at;
        db.prepare(SET_DATE_SQL).run(floored, precision, (data.takenApprox ?? row.taken_approx === 1) ? 1 : 0, itemId);
      }
    }

    if (data.placeText !== undefined) {
      db.prepare(SET_PLACE_TEXT_SQL).run(data.placeText?.trim() || null, itemId);
    }

    if (data.gps !== undefined) {
      db.prepare(
        "UPDATE gallery_details SET gps_lat = ?, gps_lng = ?, gps_source = 'manual', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_id = ?"
      ).run(data.gps?.lat ?? null, data.gps?.lng ?? null, itemId);
    }

    setEntityTags("library_item", itemId, data.tags);

    if (data.reviewedBy) markGalleryAssetReviewed(itemId, data.reviewedBy);
  })();

  if (data.gps !== undefined) requestPhotoPlaceSweep();
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
  if (data.takenAt === undefined && data.shiftMinutes === undefined && data.gps === undefined && data.placeText === undefined) return empty;

  const read = db.prepare("SELECT taken_at FROM gallery_details WHERE item_id = ?");
  const setDate = db.prepare(SET_DATE_SQL);
  const setGps = db.prepare(
    "UPDATE gallery_details SET gps_lat = ?, gps_lng = ?, gps_source = 'manual', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_id = ?"
  );
  const setPlaceText = db.prepare(SET_PLACE_TEXT_SQL);

  const precision = data.takenPrecision ?? "time";
  const approx = data.takenApprox ? 1 : 0;
  const stamped = data.takenAt !== undefined ? floorTakenAt(data.takenAt, precision) : null;

  if (data.gps !== undefined) requestPhotoPlaceSweep();
  return db.transaction(() => {
    let updated = 0;
    let noDate = 0;
    for (const itemId of itemIds) {
      const row = read.get(itemId) as Pick<GalleryDetailRow, "taken_at"> | undefined;
      if (!row) continue;

      let touched = false;
      if (stamped) {
        setDate.run(stamped, precision, approx, itemId);
        touched = true;
      } else if (data.shiftMinutes !== undefined) {
        // Shifted in JS rather than SQLite's date functions so an unparseable
        // stored value is skipped instead of silently becoming NULL. A shift is
        // a clock correction, so the date becomes an exact instant again.
        const from = row.taken_at ? new Date(row.taken_at) : null;
        if (!from || Number.isNaN(from.getTime())) {
          noDate += 1;
        } else {
          setDate.run(new Date(from.getTime() + data.shiftMinutes * 60_000).toISOString(), "time", 0, itemId);
          touched = true;
        }
      }

      if (data.gps !== undefined) {
        setGps.run(data.gps.lat, data.gps.lng, itemId);
        touched = true;
      }
      if (data.placeText !== undefined) {
        setPlaceText.run(data.placeText?.trim() || null, itemId);
        touched = true;
      }
      if (touched) updated += 1;
    }
    return { updated, noDate };
  })();
}

// Bulk tag edit from the multi-select bar: attach or detach the same tags across
// a whole selection. Additive/subtractive rather than a replace — the point is to
// label a batch of holiday photos without wiping whatever each one already
// carries. Ids without a gallery_details row (never scanned, wrong media type)
// are skipped. Permission is the caller's job.
export function changeGalleryTags(
  itemIds: string[],
  data: { add?: string[]; remove?: string[] }
): { updated: number } {
  const add = (data.add ?? []).filter((tag) => tag.trim() !== "");
  const remove = (data.remove ?? []).filter((tag) => tag.trim() !== "");
  if (itemIds.length === 0 || (add.length === 0 && remove.length === 0)) return { updated: 0 };

  const read = db.prepare("SELECT item_id FROM gallery_details WHERE item_id = ?");

  return db.transaction(() => {
    let updated = 0;
    for (const itemId of itemIds) {
      if (!read.get(itemId)) continue;
      if (remove.length > 0) removeEntityTags("library_item", itemId, remove);
      if (add.length > 0) addEntityTags("library_item", itemId, add);
      updated += 1;
    }
    return { updated };
  })();
}
