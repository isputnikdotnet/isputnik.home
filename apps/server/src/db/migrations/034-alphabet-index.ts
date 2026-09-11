import type Database from "better-sqlite3";

// 3.4.0 — the alphabet index behind the A–Z strip. New columns on
// item_metadata, so schema.sql alone can't reach an existing database. They
// land empty: the values can only be computed in JS (SQLite's UPPER is
// ASCII-only, and there is no custom-collation API), so backfillAlphaKeys()
// in modules/library/shared/alphabet-index.ts fills them at startup —
// keeping product logic out of the migration runner.
export const version = 34;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(item_metadata)").all() as { name: string }[]).map((c) => c.name)
  );
  for (const name of ["alpha_key", "alpha_script", "alpha_override", "sort_key"]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE item_metadata ADD COLUMN ${name} TEXT`);
  }
}
