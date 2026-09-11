import type Database from "better-sqlite3";

// 3.45.0 — story ratings (stories v2 step 4, mostly for review-shaped
// stories: a review without stars reads as unfinished).
export const version = 57;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(stories)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!columns.has("rating")) {
    db.exec("ALTER TABLE stories ADD COLUMN rating INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5)");
  }
}
