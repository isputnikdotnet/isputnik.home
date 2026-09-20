import type Database from "better-sqlite3";

// 4.20.0: whether a video's MP4 index sits in front of its picture data, so the
// player can start without fetching the end of the file first. NULL until the next
// catalog scan reads it from the file's first few boxes (gallery/faststart.ts).
export const version = 81;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(gallery_details)").all() as { name: string }[]).map((c) => c.name)
  );
  if (columns.size === 0) return;
  if (!columns.has("faststart")) {
    db.exec("ALTER TABLE gallery_details ADD COLUMN faststart INTEGER");
  }
}
