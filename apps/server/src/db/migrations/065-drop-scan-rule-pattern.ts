import type Database from "better-sqlite3";

// The old single `pattern` column has no reader left (layouts_json holds the
// list since 64), so it goes. A fresh schema.sql no longer creates it; a
// database that already has it drops it here. Guarded so a file built from
// the new schema.sql before its user_version caught up is left alone.
export const version = 65;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(library_scan_rules)").all() as { name: string }[]).map((c) => c.name)
  );
  if (columns.has("pattern")) {
    db.exec("ALTER TABLE library_scan_rules DROP COLUMN pattern");
  }
}
