import type Database from "better-sqlite3";

// 3.24.0 — a website and a location on an author/narrator profile, shown
// beside their bio. New columns on an existing table, so schema.sql alone
// can't reach a database that already has one.
export const version = 41;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(people)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!columns.has("website")) {
    db.exec("ALTER TABLE people ADD COLUMN website TEXT");
  }
  if (!columns.has("location")) {
    db.exec("ALTER TABLE people ADD COLUMN location TEXT");
  }
}
