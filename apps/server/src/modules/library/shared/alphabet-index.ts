import { db } from "../../../db.js";
import { alphaFieldsFor } from "./alphabet.js";

// Keeps item_metadata's alphabet columns in step with the title. Every path that
// writes sort_title/title calls applyItemAlphaIndex afterwards; backfillAlphaKeys
// is the net under all of them — it fills whatever is still NULL (a database that
// just took migration 34, or a write path someone adds later and forgets to hook).

const READ_SOURCE = `
  SELECT COALESCE(item_metadata.sort_title, item_metadata.title, library_items.folder_path) AS value
  FROM item_metadata
  JOIN library_items ON library_items.id = item_metadata.item_id
  WHERE item_metadata.item_id = ?`;

const WRITE_INDEX = "UPDATE item_metadata SET alpha_key = ?, alpha_script = ?, sort_key = ? WHERE item_id = ?";

// Re-derives one item's bucket and sort key. Reads the stored title rather than
// taking it as an argument, so a caller can never index an item under a title it
// didn't actually save. alpha_override is an administrator's choice and is left
// alone.
export function applyItemAlphaIndex(itemId: string): void {
  const row = db.prepare(READ_SOURCE).get(itemId) as { value: string | null } | undefined;
  if (!row) return;
  const fields = alphaFieldsFor(row.value);
  db.prepare(WRITE_INDEX).run(fields.alphaKey, fields.alphaScript, fields.sortKey, itemId);
}

// Fills every item that has no bucket yet; returns how many were indexed. Runs at
// startup, where it is a no-op (one indexed lookup) on every boot but the first
// after the columns appear.
export function backfillAlphaKeys(): number {
  const rows = db.prepare(`
    SELECT item_metadata.item_id AS id,
           COALESCE(item_metadata.sort_title, item_metadata.title, library_items.folder_path) AS value
    FROM item_metadata
    JOIN library_items ON library_items.id = item_metadata.item_id
    WHERE item_metadata.alpha_key IS NULL
  `).all() as { id: string; value: string | null }[];
  if (rows.length === 0) return 0;

  const write = db.prepare(WRITE_INDEX);
  db.transaction(() => {
    for (const row of rows) {
      const fields = alphaFieldsFor(row.value);
      write.run(fields.alphaKey, fields.alphaScript, fields.sortKey, row.id);
    }
  })();
  return rows.length;
}
