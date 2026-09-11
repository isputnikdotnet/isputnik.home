import type Database from "better-sqlite3";

// 3.46.0 — story kinds (stories v2 step 7). Every existing story reads as
// 'free', which is exactly what it was.
export const version = 59;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(stories)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!columns.has("kind")) {
    db.exec("ALTER TABLE stories ADD COLUMN kind TEXT NOT NULL DEFAULT 'free'");
  }
}
