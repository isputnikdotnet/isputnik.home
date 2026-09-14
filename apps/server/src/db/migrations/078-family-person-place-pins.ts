import type Database from "better-sqlite3";

// 4.9.0: a family member's birth and death places can carry a pin, set when the
// place was picked from the places search in the person editor.
export const version = 78;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(family_tree_persons)").all() as { name: string }[]).map((c) => c.name)
  );
  if (columns.size === 0) return;
  for (const column of ["birth_lat", "birth_lng", "death_lat", "death_lng"]) {
    if (!columns.has(column)) {
      db.exec(`ALTER TABLE family_tree_persons ADD COLUMN ${column} REAL`);
    }
  }
}
