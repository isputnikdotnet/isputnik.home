import type Database from "better-sqlite3";

// 3.33.0 — remember which import run brought a quote in, so one pack can be
// undone without touching another. The quote_imports table is new, so
// schema.sql creates it unaided; this is only the column on the released
// quotes table. Quotes imported before this have no run to belong to and
// stay reachable through "delete all imported", exactly as they were.
export const version = 50;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(quotes)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!columns.has("import_id")) {
    db.exec("ALTER TABLE quotes ADD COLUMN import_id TEXT REFERENCES quote_imports(id) ON DELETE SET NULL");
  }
  // Same reason as the rotation index in migration 49: schema.sql runs before this.
  db.exec("CREATE INDEX IF NOT EXISTS idx_quotes_import ON quotes(import_id) WHERE import_id IS NOT NULL");
}
