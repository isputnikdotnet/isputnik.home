import type Database from "better-sqlite3";

// 3.39.0 — life facts on a contributor: the born/died/country/occupation
// line above the biography. Every column is nullable and stays NULL on an
// existing install, so the upgrade shows nothing new until someone edits a
// person or re-runs Find info. Same additive shape as migration 41, which
// added website and location to this table.
export const version = 51;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(people)").all() as { name: string }[]).map((c) => c.name)
  );
  for (const name of ["birth_date", "death_date", "country", "occupation", "wikipedia_url"]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE people ADD COLUMN ${name} TEXT`);
  }
}
