import type Database from "better-sqlite3";

// 3.42.0 — the opening clip is retired (migration 45 added it, 46 its sound).
// A movie that opens on a video was the wrong shape: the clip now plays LAST,
// after the closing card, as a post-credit stinger. The closing clip keeps its
// columns and its setting; only the opening pair goes. Whoever had chosen an
// opening clip loses that choice — there is nowhere left to play it.
export const version = 52;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(gallery_slideshows)").all() as { name: string }[]).map((c) => c.name)
  );
  for (const name of ["intro_item_id", "intro_sound"]) {
    if (columns.has(name)) db.exec(`ALTER TABLE gallery_slideshows DROP COLUMN ${name}`);
  }
}
