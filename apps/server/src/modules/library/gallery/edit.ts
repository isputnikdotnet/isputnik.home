// Manual metadata edits for a gallery asset (title/caption, description, date
// taken, tags). Marks item_metadata.source = 'manual' and, when a date is given,
// gallery_details.taken_at_source = 'manual', so a rescan preserves the edits.
import { db } from "../../../db.js";
import { setEntityTags } from "../audiobook/categorize.js";

export interface GalleryAssetEdit {
  title: string;
  description: string | null;
  takenAt: string | null; // ISO; null = leave the existing date untouched
  tags: string[];
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

    if (data.takenAt) {
      db.prepare(
        "UPDATE gallery_details SET taken_at = ?, taken_at_source = 'manual', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_id = ?"
      ).run(data.takenAt, itemId);
    }

    setEntityTags("library_item", itemId, data.tags);
  })();

  return true;
}
