import type Database from "better-sqlite3";

// A route's legs: how each stop was reached from the one before, and the
// line that leg follows. story_block_points shipped in 3.58.0 with neither,
// so the table already exists on installs that need these two columns.
export const version = 63;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(story_block_points)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!columns.has("mode")) {
    db.exec("ALTER TABLE story_block_points ADD COLUMN mode TEXT");
  }
  if (!columns.has("geometry")) {
    db.exec("ALTER TABLE story_block_points ADD COLUMN geometry TEXT");
  }
}
