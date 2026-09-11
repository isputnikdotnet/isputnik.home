import type Database from "better-sqlite3";

// 3.44.0 — story chapter pages (stories v2 step 3). A story gains its
// chapter noun ("Day 1") and a Story Home intro; a chapter gains its
// page hero: the standfirst teaser and a hero photo.
export const version = 56;

export function up(db: Database.Database): void {
  const storyColumns = new Set(
    (db.prepare("PRAGMA table_info(stories)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!storyColumns.has("chapter_noun")) db.exec("ALTER TABLE stories ADD COLUMN chapter_noun TEXT");
  if (!storyColumns.has("intro")) db.exec("ALTER TABLE stories ADD COLUMN intro TEXT");
  const chapterColumns = new Set(
    (db.prepare("PRAGMA table_info(story_chapters)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!chapterColumns.has("standfirst")) db.exec("ALTER TABLE story_chapters ADD COLUMN standfirst TEXT");
  if (!chapterColumns.has("hero_item_id")) {
    db.exec("ALTER TABLE story_chapters ADD COLUMN hero_item_id TEXT REFERENCES library_items(id) ON DELETE SET NULL");
  }
}
