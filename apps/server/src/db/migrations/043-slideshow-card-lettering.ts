import type Database from "better-sqlite3";

// 3.26.0 — lettering for the slideshow movie's title card: which bundled face
// the text is set in and how large. New columns on an existing table, so
// schema.sql alone can't reach a database that already has one. The defaults
// are exactly what every earlier movie rendered (DejaVu Sans at today's size),
// so an untouched slideshow re-renders the same card.
export const version = 43;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(gallery_slideshows)").all() as { name: string }[]).map((c) => c.name)
  );
  const add = (name: string, definition: string) => {
    if (!columns.has(name)) db.exec(`ALTER TABLE gallery_slideshows ADD COLUMN ${name} ${definition}`);
  };
  add("card_font", "TEXT NOT NULL DEFAULT 'classic' CHECK (card_font IN ('classic', 'serif', 'bold', 'script', 'typewriter'))");
  add("card_size", "TEXT NOT NULL DEFAULT 'medium' CHECK (card_size IN ('small', 'medium', 'large'))");
}
