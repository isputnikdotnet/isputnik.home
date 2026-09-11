import type Database from "better-sqlite3";

// 3.50.0 — stories join the Recycle Bin: deleting one soft-deletes it, and
// purge_after carries the retention window it was promised at delete time
// (same contract as trashed_items.expires_at). No index: the stories table
// is small, and an index over a migration-added column must NEVER go in
// schema.sql (see migrations 25 and 58).
export const version = 60;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(stories)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!columns.has("deleted_at")) {
    db.exec("ALTER TABLE stories ADD COLUMN deleted_at TEXT");
  }
  if (!columns.has("purge_after")) {
    db.exec("ALTER TABLE stories ADD COLUMN purge_after TEXT");
  }
}
