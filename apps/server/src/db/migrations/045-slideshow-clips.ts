import type Database from "better-sqlite3";

// 3.26.0 — opening and closing clips: a gallery video that plays before the
// title card (a home-video "studio logo") and/or after the slides, before the
// closing card. Any accessible gallery video, not just slideshow members; a
// deleted item clears itself (SET NULL), and the render skips a clip it can't
// reach rather than failing. New columns on an existing table.
export const version = 45;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(gallery_slideshows)").all() as { name: string }[]).map((c) => c.name)
  );
  for (const name of ["intro_item_id", "outro_item_id"]) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE gallery_slideshows ADD COLUMN ${name} TEXT REFERENCES library_items(id) ON DELETE SET NULL`);
    }
  }
}
