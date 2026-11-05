import type Database from "better-sqlite3";

// Photo Sync phase 1 (docs/photo-sync-plan.md, decision 3): a personal library is an
// ordinary gallery library marked as one member's. Not `role`, which is CHECK-limited
// to the two system libraries and unique per role; a personal library is one per member.
//
//   personal_user_id     whose it is (kept after the member is removed, to say whose it was)
//   personal_orphaned_at set when that member was removed (decision 11). An orphaned
//                        library belongs to nobody: an account re-issued under the same
//                        email keeps the user id, and must not inherit it.
//   personal_adopted_at  set when an admin made an existing library someone's personal
//                        library, or handed an orphaned one over; the owner's My library
//                        tab says so.
//
// One live personal library per member: the unique index leaves orphaned ones out.
export const version = 87;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(libraries)").all() as { name: string }[]).map((c) => c.name)
  );
  if (columns.size === 0) return;
  if (!columns.has("personal_user_id")) {
    db.exec("ALTER TABLE libraries ADD COLUMN personal_user_id TEXT REFERENCES users(id)");
  }
  if (!columns.has("personal_orphaned_at")) {
    db.exec("ALTER TABLE libraries ADD COLUMN personal_orphaned_at TEXT");
  }
  if (!columns.has("personal_adopted_at")) {
    db.exec("ALTER TABLE libraries ADD COLUMN personal_adopted_at TEXT");
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_libraries_personal_user ON libraries(personal_user_id)
    WHERE personal_user_id IS NOT NULL AND personal_orphaned_at IS NULL`);
}
