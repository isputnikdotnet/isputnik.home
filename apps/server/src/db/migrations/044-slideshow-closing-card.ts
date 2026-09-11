import type Database from "better-sqlite3";

// 3.26.0 — the movie's closing card: an end title ("The End" unless renamed),
// up to six lines of credits, its own length and background, and the music
// fading out underneath it. New columns on an existing table, so schema.sql
// alone can't reach a database that already has one. closing_enabled defaults
// OFF — an untouched slideshow renders exactly the movie it always did.
export const version = 44;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(gallery_slideshows)").all() as { name: string }[]).map((c) => c.name)
  );
  const add = (name: string, definition: string) => {
    if (!columns.has(name)) db.exec(`ALTER TABLE gallery_slideshows ADD COLUMN ${name} ${definition}`);
  };
  add("closing_enabled", "INTEGER NOT NULL DEFAULT 0");
  add("closing_text", "TEXT");
  add("closing_lines", "TEXT");
  add("closing_seconds", "REAL NOT NULL DEFAULT 5");
  add("closing_background", "TEXT NOT NULL DEFAULT 'black' CHECK (closing_background IN ('black', 'photo', 'blur', 'collage'))");
  add("closing_photo_item_id", "TEXT REFERENCES library_items(id) ON DELETE SET NULL");
}
