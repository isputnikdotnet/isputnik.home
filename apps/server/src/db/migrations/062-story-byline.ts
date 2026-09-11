import type Database from "better-sqlite3";

// A story can be signed. Free text rather than a reference to the account
// that wrote it: a pen name, two names, or somebody no longer here — and
// the byline has to survive the account being deleted. Existing stories
// stay unsigned (NULL), which shows nothing, exactly as today.
export const version = 62;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(stories)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!columns.has("author_name")) {
    db.exec("ALTER TABLE stories ADD COLUMN author_name TEXT");
  }
}
