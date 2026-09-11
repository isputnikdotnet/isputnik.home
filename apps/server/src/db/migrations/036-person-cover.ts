import type Database from "better-sqlite3";

// 3.4.4 — the same explicit cover pick for a person. New column on an existing
// table, so schema.sql alone can't reach a database that already has one.
export const version = 36;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(gallery_people)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!columns.has("cover_item_id")) {
    db.exec("ALTER TABLE gallery_people ADD COLUMN cover_item_id TEXT REFERENCES library_items(id) ON DELETE SET NULL");
  }
}
