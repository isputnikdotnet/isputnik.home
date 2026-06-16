import { nanoid } from "nanoid";
import type Database from "better-sqlite3";
import { CATEGORY_SEED, ALIAS_SEED } from "../categories-seed.js";

// Idempotent navigation-category + alias seeding. Fill-gaps only: existing rows
// keep their id and any admin edits (icon is backfilled only when unset).
export function seed(db: Database.Database): void {
  const insertCategory = db.prepare(
    "INSERT INTO categories (id, key, name, slug, sort_order, icon, image_storage_key) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING"
  );
  const backfillIcon = db.prepare("UPDATE categories SET icon = ? WHERE key = ? AND icon IS NULL");
  const findCategory = db.prepare("SELECT id FROM categories WHERE key = ?");
  const insertAlias = db.prepare(
    "INSERT INTO category_aliases (id, keyword, category_id, priority) VALUES (?, ?, ?, ?) ON CONFLICT(keyword) DO UPDATE SET category_id = excluded.category_id, priority = excluded.priority"
  );

  db.transaction(() => {
    const idByKey = new Map<string, string>();
    for (const category of CATEGORY_SEED) {
      const existing = findCategory.get(category.key) as { id: string } | undefined;
      const id = existing?.id ?? nanoid(16);
      insertCategory.run(id, category.key, category.name, category.key, category.sortOrder, category.icon, category.defaultImageStorageKey ?? null);
      backfillIcon.run(category.icon, category.key);
      idByKey.set(category.key, id);
    }
    for (const alias of ALIAS_SEED) {
      const categoryId = idByKey.get(alias.category);
      if (categoryId) {
        insertAlias.run(nanoid(16), alias.keyword, categoryId, alias.priority);
      }
    }
  })();
}
