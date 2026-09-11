import type Database from "better-sqlite3";

// The rebuilt story editor: a block may carry its own heading ("Photos
// from Day 1"), and a chapter may draw its map pin as its cover instead
// of a photo. Both are additive and default to today's behaviour.
export const version = 61;

export function up(db: Database.Database): void {
  const blockColumns = new Set(
    (db.prepare("PRAGMA table_info(story_blocks)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!blockColumns.has("heading")) {
    db.exec("ALTER TABLE story_blocks ADD COLUMN heading TEXT");
  }
  const chapterColumns = new Set(
    (db.prepare("PRAGMA table_info(story_chapters)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!chapterColumns.has("hero_map")) {
    db.exec("ALTER TABLE story_chapters ADD COLUMN hero_map INTEGER NOT NULL DEFAULT 0");
  }
}
