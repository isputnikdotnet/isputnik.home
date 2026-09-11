import type Database from "better-sqlite3";

// "Ask for notes" (docs/photo-review-plan.md, phase 3): an album sent with
// a question attached, whose card opens Review mode rather than the album.
export const version = 72;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(recommendations)").all() as { name: string }[]).map((c) => c.name)
  );
  if (columns.size === 0) return;
  if (!columns.has("ask_notes")) db.exec("ALTER TABLE recommendations ADD COLUMN ask_notes INTEGER NOT NULL DEFAULT 0");
}
