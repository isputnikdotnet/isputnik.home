import type Database from "better-sqlite3";

// Scan layouts (docs/scan-layout-plan.md): a rule holds an ORDERED LIST of
// patterns tried in turn, not one. layouts_json carries the list; the old
// `pattern` column stays as a mirror of layouts[0] until no reader is left.
// last_scanned_at lets the Layout panel say when a rule was last applied.
// Backfilled in JS rather than json_array() so quoting is never a question.
export const version = 64;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(library_scan_rules)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!columns.has("layouts_json")) {
    db.exec("ALTER TABLE library_scan_rules ADD COLUMN layouts_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!columns.has("last_scanned_at")) {
    db.exec("ALTER TABLE library_scan_rules ADD COLUMN last_scanned_at TEXT");
  }
  // A file built from a schema.sql that postdates migration 65 never had the
  // old column, so there is nothing to carry over.
  if (columns.has("pattern")) {
    const rows = db.prepare("SELECT id, pattern FROM library_scan_rules WHERE layouts_json = '[]'")
      .all() as { id: string; pattern: string }[];
    const set = db.prepare("UPDATE library_scan_rules SET layouts_json = ? WHERE id = ?");
    for (const row of rows) set.run(JSON.stringify([row.pattern]), row.id);
  }
}
