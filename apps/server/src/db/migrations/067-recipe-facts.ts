import type Database from "better-sqlite3";

// Recipe facts on the story head: how many it serves (free text — "4–6",
// "one big pot") and the total time in minutes. Any story may carry
// them, recipes mostly; both NULL means nothing is shown. See
// docs/recipes-plan.md, phase 2.
export const version = 67;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(stories)").all() as { name: string }[]).map((c) => c.name)
  );
  if (columns.size === 0) return;
  if (!columns.has("servings")) db.exec("ALTER TABLE stories ADD COLUMN servings TEXT");
  if (!columns.has("cook_minutes")) db.exec("ALTER TABLE stories ADD COLUMN cook_minutes INTEGER");
}
