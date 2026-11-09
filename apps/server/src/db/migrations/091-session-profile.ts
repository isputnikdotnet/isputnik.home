import type Database from "better-sqlite3";

// Viewing profiles (docs/tv-profiles-plan.md, phase P1): the profile a session
// wears. The table itself is new and comes from schema.sql; only the column on an
// existing sessions table needs adding. NULL is the account itself, and a deleted
// profile drops its sessions back to it.
export const version = 91;

export function up(db: Database.Database): void {
  const columns = new Set((db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name));
  if (columns.size === 0 || columns.has("profile_id")) return;
  db.exec("ALTER TABLE sessions ADD COLUMN profile_id TEXT REFERENCES viewing_profiles(id) ON DELETE SET NULL");
}
