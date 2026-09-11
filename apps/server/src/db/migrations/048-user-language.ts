import type Database from "better-sqlite3";

// 3.31.0 — per-user interface language (i18n). A new column on an existing
// table, so schema.sql alone can't reach a database that already has one.
// Everyone starts on English, the language the UI has always been.
export const version = 48;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!columns.has("language")) {
    db.exec("ALTER TABLE users ADD COLUMN language TEXT NOT NULL DEFAULT 'en'");
  }
}
