import type Database from "better-sqlite3";

// 3.43.0 — story guest links. A story embeds albums and slideshows, so a
// link needs to say whether a guest may open the whole set or only the
// photos the story shows inline. Off for every existing link, which is the
// narrower reading and the right default for the ones minted from now on.
export const version = 54;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(share_links)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!columns.has("expand_albums")) {
    db.exec("ALTER TABLE share_links ADD COLUMN expand_albums INTEGER NOT NULL DEFAULT 0");
  }
}
