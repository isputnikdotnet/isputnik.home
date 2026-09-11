// The book layer audiobooks and ebooks share: cover URLs, category payloads,
// tag lists and GROUP_CONCAT splitting, read by both types' catalogs and by the
// cross-type Categories and Works pages. Audiobook-only helpers stay in
// audiobook/book-helpers.ts.
import { db } from "../../../db.js";
import { builtinCategoryImageUrl, isBuiltinCategoryImageKey } from "../../../categories-seed.js";
import type { CategoryRow as DbCategoryRow, TagRow } from "../../../db/rows.js";

// A book's cover file is overwritten in place under a key derived from its id,
// so the URL alone can't tell a new cover from the old one: a browser that
// already has the image on screen keeps showing it after an edit, which is why
// applying a metadata match looked like it left the cover alone even though the
// file on disk had changed. Stamp the metadata row's updated_at on the URL —
// every write that can touch the cover bumps it, so a changed cover always
// arrives under a new URL (and the covers route can then cache it immutably).
function coverVersionSuffix(metadataUpdatedAt: string | null | undefined) {
  return metadataUpdatedAt ? `?v=${encodeURIComponent(metadataUpdatedAt)}` : "";
}

export function coverUrl(storageKey: string | null, metadataUpdatedAt?: string | null) {
  if (!storageKey) {
    return null;
  }

  return `/api/library/covers/${storageKey}${coverVersionSuffix(metadataUpdatedAt)}`;
}

export function largeCoverUrl(storageKey: string | null, metadataUpdatedAt?: string | null) {
  if (!storageKey) {
    return null;
  }

  return `/api/library/covers/${storageKey.replace(/-cover\.webp$/i, "-cover-large.webp")}${coverVersionSuffix(metadataUpdatedAt)}`;
}

export function splitGroupConcat(value: string | null) {
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

export type CategoryRow = Pick<DbCategoryRow, "id" | "key" | "name" | "icon" | "image_storage_key">;

export function categoryImageUrl(imageStorageKey: string | null) {
  if (isBuiltinCategoryImageKey(imageStorageKey)) {
    return builtinCategoryImageUrl(imageStorageKey);
  }
  return imageStorageKey ? `/api/library/covers/${imageStorageKey}` : null;
}

export function categoryPayload(categoryId: string | null) {
  if (!categoryId) {
    return null;
  }
  const row = db.prepare("SELECT id, key, name, icon, image_storage_key FROM categories WHERE id = ?").get(categoryId) as CategoryRow | undefined;
  return row ? { key: row.key, name: row.name, icon: row.icon, imageUrl: categoryImageUrl(row.image_storage_key) } : null;
}

export function bookTags(bookId: string): string[] {
  const rows = db.prepare(`
    SELECT tags.display_name AS name
    FROM taggables
    JOIN tags ON tags.id = taggables.tag_id
    WHERE taggables.entity_type = 'library_item' AND taggables.entity_id = ?
    ORDER BY tags.display_name COLLATE NOCASE
  `).all(bookId) as { name: TagRow["display_name"] }[];
  return rows.map((r) => r.name);
}

