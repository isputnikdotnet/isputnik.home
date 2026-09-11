import type Database from "better-sqlite3";

// 3.79.0: uploaded slideshow music becomes an audio asset of the Made in the
// app library (docs/app-storage-plan.md, phase 3). The row keeps its id, so
// slideshows keep pointing at it; item_id says which asset it is now.
export const version = 74;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(gallery_music_tracks)").all() as { name: string }[]).map((c) => c.name)
  );
  if (columns.size === 0) return;
  if (!columns.has("item_id")) {
    db.exec("ALTER TABLE gallery_music_tracks ADD COLUMN item_id TEXT REFERENCES library_items(id) ON DELETE CASCADE");
  }
}
