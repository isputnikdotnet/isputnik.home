import type Database from "better-sqlite3";

// 3.32.0 — the metadata a quote needs to be more than a reading highlight:
// where it came from, who may see it, whether it joins the Quote-of-the-day
// rotation, and language/date/context. The family-tree speaker link lands in
// the same pass so the table is only rewritten once, though nothing reads it
// until the profile work. New columns on an existing table, so schema.sql
// alone can't reach a database that already has one.
export const version = 49;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(quotes)").all() as { name: string }[]).map((c) => c.name)
  );
  const add = (name: string, definition: string) => {
    if (!columns.has(name)) db.exec(`ALTER TABLE quotes ADD COLUMN ${name} ${definition}`);
  };
  add("origin", "TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'reader', 'import'))");
  add("visibility", "TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'family'))");
  add("in_rotation", "INTEGER NOT NULL DEFAULT 0");
  add("language", "TEXT");
  add("quote_date", "TEXT");
  add("context", "TEXT");
  add("family_tree_person_id", "TEXT REFERENCES family_tree_persons(id) ON DELETE SET NULL");
  add("person_name", "TEXT");
  // Existing rows predate `origin` and land on its 'manual' default, which is
  // right for hand-typed quotes but wrong for the ones the reader captured —
  // and a document anchor is exactly what identifies those.
  db.prepare("UPDATE quotes SET origin = 'reader' WHERE document_id IS NOT NULL").run();
  // The daily card's pool lookup. This index cannot live in schema.sql: that
  // file is executed in full BEFORE these migrations run, so an index over a
  // column this migration has yet to add would throw on every upgrade. Move
  // it there when migrations are next folded back into the baseline.
  db.exec("CREATE INDEX IF NOT EXISTS idx_quotes_rotation ON quotes(visibility, user_id) WHERE in_rotation = 1");
}
