import type Database from "better-sqlite3";

// 4.6: App files stops having library access rules (docs/system-data-plan.md,
// phase 4, decisions 20 and 22). A file in it is visible to admins and to whoever
// can see what owns it (a story, a photo, a slideshow, the family tree); the
// library's own grants and owner meant nothing once that holds, so they go.
//
// Self-contained on purpose: a migration must not import app code that later changes.
export const version = 77;

export function up(db: Database.Database): void {
  const table = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  if (!table("libraries") || !table("assignments")) return;
  const columns = new Set((db.prepare("PRAGMA table_info(libraries)").all() as { name: string }[]).map((c) => c.name));
  if (!columns.has("role")) return;

  const appFiles = db.prepare("SELECT id FROM libraries WHERE role = 'app-files'").get() as { id: string } | undefined;
  if (!appFiles) return;
  db.prepare("DELETE FROM assignments WHERE object_type = 'library' AND object_id = ?").run(appFiles.id);
  if (columns.has("owner_id") && columns.has("owner_type")) {
    db.prepare("UPDATE libraries SET owner_id = NULL, owner_type = NULL WHERE id = ?").run(appFiles.id);
  }
}
