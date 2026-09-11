import type Database from "better-sqlite3";

// 3.2.0 — title-card options for slideshow movies. New columns on an existing
// table, so schema.sql alone can't reach a database that already has one. The
// defaults are exactly the card 3.1.x rendered (the slideshow's name over black,
// three seconds, a photo-count subline), so an existing slideshow re-renders the
// same movie until someone changes something.
export const version = 33;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(gallery_slideshows)").all() as { name: string }[]).map((c) => c.name)
  );
  const add = (name: string, definition: string) => {
    if (!columns.has(name)) db.exec(`ALTER TABLE gallery_slideshows ADD COLUMN ${name} ${definition}`);
  };
  add("title_enabled", "INTEGER NOT NULL DEFAULT 1");
  add("title_text", "TEXT");
  add("title_subtitle_mode", "TEXT NOT NULL DEFAULT 'count' CHECK (title_subtitle_mode IN ('count', 'custom', 'none'))");
  add("title_subtitle", "TEXT");
  add("title_seconds", "REAL NOT NULL DEFAULT 3");
  add("title_background", "TEXT NOT NULL DEFAULT 'black' CHECK (title_background IN ('black', 'photo', 'blur', 'collage'))");
  add("title_photo_item_id", "TEXT REFERENCES library_items(id) ON DELETE SET NULL");
}
