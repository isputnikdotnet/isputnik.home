import type Database from "better-sqlite3";

// 4.10.0: a marriage place and a life event's place can carry a pin too, set
// when the place was picked from the places search (births and deaths got theirs
// in migration 78).
export const version = 79;

function addColumns(db: Database.Database, table: string, names: string[]): void {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
  );
  if (columns.size === 0) return;
  for (const name of names) {
    if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} REAL`);
  }
}

export function up(db: Database.Database): void {
  addColumns(db, "family_tree_unions", ["married_lat", "married_lng"]);
  addColumns(db, "family_tree_events", ["place_lat", "place_lng"]);
}
