import type Database from "better-sqlite3";

// 3.46.0 — story collections (stories v2 step 6). The story_collections
// table itself auto-applies from schema.sql; an existing stories table
// needs the membership column and its index.
export const version = 58;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(stories)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!columns.has("collection_id")) {
    db.exec("ALTER TABLE stories ADD COLUMN collection_id TEXT REFERENCES story_collections(id) ON DELETE SET NULL");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_stories_collection ON stories(collection_id)");
}
