import type Database from "better-sqlite3";

// 3.43.0 — saving a movie to a library becomes a per-slideshow choice. Until now a
// single server-wide setting took EVERY render into one library, which nobody opted
// into and which could not be pointed anywhere else.
//
// Continuity matters more than a clean slate here: a slideshow whose movie is already
// in a library keeps saving to that same library, so nothing silently stops updating.
// Every other slideshow starts with saving off, which is the new default. The old
// global setting is removed in the same pass — leaving it would be a dead key that
// still reads as configuration.
export const version = 53;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(gallery_slideshows)").all() as { name: string }[]).map((c) => c.name)
  );
  const add = (name: string, definition: string) => {
    if (!columns.has(name)) db.exec(`ALTER TABLE gallery_slideshows ADD COLUMN ${name} ${definition}`);
  };
  add("movie_target_library_id", "TEXT REFERENCES libraries(id) ON DELETE SET NULL");
  add("movie_on_conflict", "TEXT NOT NULL DEFAULT 'keep_both' CHECK (movie_on_conflict IN ('overwrite', 'keep_both'))");
  add("movie_file_stem", "TEXT");
  add("movie_save_error", "TEXT");

  // Carry the ones already saved. movie_library_id is only ever set by a save that
  // succeeded, so this targets exactly the slideshows that were being auto-saved.
  // Guarded on the column existing: a database old enough to predate it has nothing
  // to carry, and referencing it would fail the whole migration.
  if (columns.has("movie_library_id")) {
    db.prepare(`
          UPDATE gallery_slideshows
          SET movie_target_library_id = movie_library_id
          WHERE movie_library_id IS NOT NULL AND movie_target_library_id IS NULL
        `).run();
  }

  db.prepare("DELETE FROM app_settings WHERE key = 'gallery.slideshow.render_library'").run();
}
