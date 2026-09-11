import type Database from "better-sqlite3";

// Photo Inbox check (docs/photo-inbox-proposal.md, phase 2): a duplicate
// cleanup whose candidates are one Inbox library's photos. Stored as a
// 'files' job plus this column, so the duplicate_type CHECK stays as it is.
export const version = 68;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(duplicate_jobs)").all() as { name: string }[]).map((c) => c.name)
  );
  if (columns.size === 0) return;
  if (!columns.has("inbox_library_id")) {
    db.exec("ALTER TABLE duplicate_jobs ADD COLUMN inbox_library_id TEXT REFERENCES libraries(id) ON DELETE SET NULL");
  }
}
