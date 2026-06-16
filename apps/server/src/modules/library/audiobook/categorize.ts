import { nanoid } from "nanoid";
import { db } from "../../../db.js";
import { BOOK_LIBRARY_TYPES } from "../shared/library-types.js";

// Normalize a genre/tag string for matching and dedup: strip diacritics, lowercase,
// unify separators, collapse whitespace.
export function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[/_|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface AliasRow {
  keyword: string;
  category_id: string;
  priority: number;
}

function generalOtherId(): string {
  return (db.prepare("SELECT id FROM categories WHERE key = 'general_other'").get() as { id: string }).id;
}

// Pick the single best category for a book from its raw genre strings, using the
// alias keyword table. Highest-priority match wins; no match -> General / Other.
export function matchCategoryId(rawGenres: string[]): string {
  const normalized = rawGenres.map(normalizeText).filter(Boolean);
  if (normalized.length === 0) {
    return generalOtherId();
  }
  const aliases = db.prepare("SELECT keyword, category_id, priority FROM category_aliases").all() as AliasRow[];
  let best: { categoryId: string; priority: number } | null = null;
  for (const alias of aliases) {
    if (normalized.some((genre) => genre.includes(alias.keyword))) {
      if (!best || alias.priority > best.priority) {
        best = { categoryId: alias.category_id, priority: alias.priority };
      }
    }
  }
  return best?.categoryId ?? generalOtherId();
}

function upsertTagId(displayName: string): string {
  const key = normalizeText(displayName);
  const existing = db.prepare("SELECT id FROM tags WHERE key = ?").get(key) as { id: string } | undefined;
  if (existing) {
    return existing.id;
  }
  db.prepare("INSERT INTO tags (id, key, display_name) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING")
    .run(nanoid(16), key, displayName.trim());
  return (db.prepare("SELECT id FROM tags WHERE key = ?").get(key) as { id: string }).id;
}

// Add tags to an entity without removing existing ones.
export function addEntityTags(entityType: string, entityId: string, displayNames: string[]) {
  const seen = new Set<string>();
  for (const name of displayNames) {
    const key = normalizeText(name);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    const tagId = upsertTagId(name);
    db.prepare("INSERT OR IGNORE INTO taggables (tag_id, entity_type, entity_id) VALUES (?, ?, ?)")
      .run(tagId, entityType, entityId);
  }
}

// Recompute the primary category of every non-manual book (any book-like library
// type) from its existing tags and the current alias table. Cheap (DB-only) — no
// file rescan. Returns rows changed.
export function rematchAllCategories(): number {
  const typePlaceholders = BOOK_LIBRARY_TYPES.map(() => "?").join(", ");
  const books = db.prepare(`
    SELECT
      library_items.id AS id,
      ic.category_id AS category_id
    FROM library_items
    JOIN libraries ON libraries.id = library_items.library_id
    LEFT JOIN item_categories ic ON ic.item_id = library_items.id AND ic.is_primary = 1
    WHERE library_items.deleted_at IS NULL
      AND libraries.type IN (${typePlaceholders})
      AND COALESCE(ic.source, 'scan') != 'manual'
  `).all(...BOOK_LIBRARY_TYPES) as { id: string; category_id: string | null }[];

  const tagsFor = db.prepare(`
    SELECT tags.display_name AS name
    FROM taggables
    JOIN tags ON tags.id = taggables.tag_id
    WHERE taggables.entity_type = 'library_item' AND taggables.entity_id = ?
  `);
  const clearPrimary = db.prepare("DELETE FROM item_categories WHERE item_id = ? AND is_primary = 1");
  const setPrimary = db.prepare(`
    INSERT INTO item_categories (item_id, category_id, is_primary, source) VALUES (?, ?, 1, 'scan')
    ON CONFLICT(item_id, category_id) DO UPDATE SET is_primary = 1, source = 'scan'
  `);

  let changed = 0;
  db.transaction(() => {
    for (const book of books) {
      const tags = (tagsFor.all(book.id) as { name: string }[]).map((t) => t.name);
      const next = matchCategoryId(tags);
      if (next !== book.category_id) {
        clearPrimary.run(book.id);
        setPrimary.run(book.id, next);
        changed += 1;
      }
    }
  })();
  return changed;
}

// Replace the tag set for an entity (book) with the given display names.
export function setEntityTags(entityType: string, entityId: string, displayNames: string[]) {
  db.prepare("DELETE FROM taggables WHERE entity_type = ? AND entity_id = ?").run(entityType, entityId);
  addEntityTags(entityType, entityId, displayNames);
}
